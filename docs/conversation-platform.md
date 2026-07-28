# Conversation Platform

Delegate uses a channel-neutral conversation domain for public web, Matrix, Telegram, and future adapters.

The target boundary and migration rules are accepted in [the Unified Conversation Platform ADR](./adr-channel-conversation-platform.md). The platform unifies business behavior; it does not require every provider to use the same transport.

## Confirmed Boundaries

- PostgreSQL is the business source of truth for contacts, conversations, episodes, messages, billing, handoff, and audit.
- Matrix provides authenticated real-time rooms and multi-device synchronization when it is enabled. Anonymous public web chat continues to use Delegate APIs and SSE. Telegram can use a direct adapter without Matrix.
- `sourceProvider` records where the audience interaction originated. `transport` records how the event was carried. Telegram carried through an optional Matrix bridge remains `sourceProvider=TELEGRAM`.
- One representative, Contact, source provider, and external thread reuse one long-lived `Conversation`; changing transport does not create a new business conversation.
- `ConversationEpisode` separates service periods without creating new Matrix rooms.
- Cross-channel identity and approved long-term memory may be shared; raw message timelines remain channel-specific.
- Human takeover uses an explicit Operator identity. AI does not automatically reply while an Operator controls the episode.
- Matrix rooms, virtual users, ghosts, and bridge puppets are delivery identities, not Delegate account identities.

## Source, Transport, And Identity

| Interaction | Source provider | Transport |
| --- | --- | --- |
| Public representative Web chat | `WEB` | `WEB` |
| Native Matrix room | `MATRIX` | `MATRIX` |
| Direct Telegram Bot API | `TELEGRAM` | `TELEGRAM` |
| Telegram portal through a Matrix bridge | `TELEGRAM` | `MATRIX` |

Each provider subject binds directly to `AudienceIdentity` through provider-specific proof. Delegate does not infer account ownership from display names, usernames, room membership, or bridge-created identities. Link grants are short-lived, single-use, hashed, provider-bound, and audited. Existing links cannot be silently moved to another authenticated account.

Contacts remain representative-scoped. Service entitlement may follow the canonical audience identity across approved channels, but channel conversations and raw timelines do not merge automatically.

## Runtime Flow

```text
Channel event
  -> validate provider proof and origin idempotency
  -> resolve source provider and transport
  -> enforce representative, channel, policy, entitlement, and takeover state
  -> resolve verified audience identity
  -> transactionally write Message + GenerationRun + OutboxEvent
  -> acknowledge the channel
  -> generate with the episode's pinned RepresentativeVersion
  -> apply active RuntimePolicyOverlay records
  -> persist output Message, citations, usage, and audit
  -> deliver through the outbound channel adapter
```

The public web route accepts and persists the audience message, returns `202 Accepted`, and lets `apps/conversation-worker` complete the durable generation run. The page subscribes to both the run status and a durable conversation SSE stream, so representative and Operator messages appear without a refresh while PostgreSQL remains the source restored after reconnect.

Provider webhook and Application Service request handlers should durably accept a valid event and return promptly. Generation, delivery, retry, and dead-letter processing belong in workers. An unknown room or portal mapping is quarantined for provisioning or replay; it is not permanently marked as an ignorable audience message.

Before an answer run reaches the model, the worker searches three permission-isolated OpenViking roots: representative public resources, the current Contact's public-safe memories, and representative-level learned patterns. Only approved, READY workspace assets linked to the representative can be recalled. Selected context is injected into the model prompt; public-safe citation title/excerpt and internal recall provenance are persisted with the reply.

## Inbox, Pending Work, And Leads

- `Contact` is the stable person/account in one representative context. It is not a sales opportunity.
- `Lead` is a qualified opportunity. One Contact may have multiple Leads over time; active lead state, priority, assignee, follow-up time, and outcome are independent of contact identity.
- `HandoffRequest` is actionable queue work. It is tied to the current conversation and episode and is accepted/closed with human control transitions.
- `ConversationReadState` records per-operator read position. The legacy aggregate unread count remains during compatibility migration.
- `ConversationInternalNote` is team-only and never appears in audience history.

AI routing that reaches `collect_intake`, `handoff`, or `ask_owner` upserts a Lead. Human-required routes also upsert a HandoffRequest and move the current episode to `NEEDS_HUMAN`. Accepting the handoff, assigning the Lead, and changing the episode to `HUMAN_ACTIVE` happen in one transaction.

The Owner Inbox exposes three object views — Conversations, Pending, and Leads — over this shared state. Operator replies use explicit `OPERATOR` authorship, require an active assignment, and never masquerade as the representative. Web queue and selected-thread changes arrive through SSE within the same persisted timeline; Matrix and Telegram replies use the durable outbox, the Operator virtual identity or explicit Operator name, and bounded retry/dead-letter handling.

## Message Rules

- `clientMessageId` protects client retries.
- `externalMessageId` protects channel event retries.
- Edits create `MessageRevision`; they do not overwrite audit history.
- An edit to a queued run replaces it. An edit during processing cancels and requeues. An edit after completion preserves the historical reply.
- Redaction hides content immediately, excludes it from future context, and sets a seven-day purge deadline.
- Normal conversation content receives a default 180-day retention deadline.
- Prompts, credentials, and hidden model reasoning are not stored in user-visible message content.

## Representative Versions

`RepresentativeVersion` is immutable. A new episode pins the active version so identity, service scope, and pricing do not change mid-service.

The public representative page, inline web chat, Telegram runtime, and asynchronous conversation worker all resolve configuration from the active or episode-pinned version. Dashboard setup writes only the working draft, so an Owner can prepare the next version without changing live behavior. Representatives without an active version have no public runtime.

Real-time `RuntimePolicyOverlay` records can still pause a representative, revoke tools or knowledge, disable a channel, or tighten safety rules. Every generation records the resolved version and run state.

The same availability contract is evaluated at inbound acceptance, before generation, and before outbound delivery. It includes representative lifecycle, published version, channel desired state and observed health, active runtime overlays, human control, and required service entitlement.

## Service Entitlement And Payment Rails

Service access is scoped to an `AudienceIdentity`, representative, and product/service. It is not a representative-wide token pool shared by unrelated audience members.

The domain keeps Web checkout and Telegram Stars as separate payment rails. In
the current repository, however, Web recharge is a non-production demo/mock
flow: its mutation endpoints are disabled in production, and live provider
checkout, signed webhooks, and production refunds are not yet closed. Telegram
Stars is also default-off and not production-ready.

- provider amounts, currencies, settlement references, disputes, and refunds remain rail-specific;
- a successful, verified provider event may grant or extend the same service entitlement;
- XTR and Web currencies are not converted into a fungible balance;
- refunds and reversals use the original provider rail;
- if Telegram paid features are enabled, Telegram-native digital service follows Telegram's Stars requirements;
- if the release is Web-payment-only, Telegram paid features remain disabled and the paid interaction continues on Web.

## Native Matrix Application Service

Native Matrix is an optional channel. Telegram long-polling and direct Telegram
delivery do not require a Matrix homeserver, Application Service, or bridge.

The offline suite uses mocks and PostgreSQL fixtures. A real Synapse instance
is additionally necessary to close the protocol boundary (AS registration,
virtual users, membership, plaintext-room state, and Client API delivery).
`pnpm matrix:local:e2e` provides that disposable Docker gate with an isolated
homeserver, Application Service transaction stream, bridge, and database. It
also verifies disconnect blocks both directions without deleting history and
that re-provisioning resumes delivery. Setup details and the manual Dashboard
flow are in
[`matrix-local-synapse.md`](matrix-local-synapse.md).

`apps/matrix-bridge` implements:

- authenticated transaction ingestion;
- event idempotency through `ChannelEventInbox`;
- Matrix edit and redaction mapping;
- managed Representative and Operator virtual-user lookup;
- health and ping endpoints.

`MATRIX_AS_HS_TOKEN` is mandatory and must be injected by the environment or secret manager. Source code contains no Matrix access token or virtual-user password.

`apps/conversation-worker` claims durable generation outbox records with PostgreSQL row locking, invokes the shared representative runtime, persists the reply before delivery, and retries channel delivery without generating duplicate replies. Matrix outbound delivery is enabled only when `MATRIX_HOMESERVER_URL` and `MATRIX_AS_TOKEN` are both injected.

When Synapse queries a managed MXID, the bridge first registers that virtual
user through `m.login.application_service`, then returns success to the
homeserver. Registration is idempotent (`M_USER_IN_USE` is accepted), requires
the MXID domain to match `MATRIX_SERVER_NAME`, and is repeated before room join
as a recovery guard for old or replayed transactions. Treating
`M_USER_IN_USE` as idempotent assumes the homeserver registration reserves the
managed `_delegate_` user namespace with `exclusive: true`; production must not
enable Matrix without that registration invariant.

Native Matrix must additionally provision or explicitly map rooms, validate the event sender's permitted audience identity, authorize edits and redactions against the original message actor, and move failed inbox work through retry/quarantine/dead-letter states.

### Matrix MVP room-security gate

Matrix is plaintext private chat only in this release. Provisioning accepts only a managed-user `m.room.member` invite with `content.is_direct=true`; a normal invite is never treated as a direct room. The persisted binding begins as `PENDING_REMOTE_VALIDATION` and records the one audience MXID and one managed representative MXID. It becomes `ACTIVE` only after the bridge verifies the room. Any `m.room.encryption` state event, unexpected third member, or either expected member leaving marks the binding `ISOLATED`, records the membership evidence, and prevents new AI work.

Before the first invite, the owner must create the representative's managed
MXID from the Channels console. That owner-scoped action requires
`MATRIX_SERVER_NAME`, creates the Application Service user and channel binding,
and is protected by a database invariant allowing only one enabled
representative MXID per representative/kind. Human Operator messages keep
their Operator authorship in Delegate but use the same already-joined
representative MXID for Matrix transport, with the Operator name prefixed in
the text; adding a third Operator MXID would violate and isolate the exact
two-member room.

Where `MATRIX_HOMESERVER_URL` and `MATRIX_AS_TOKEN` are configured, the bridge joins the managed user and, with a five-second timeout, verifies through the homeserver that the joined-member set is exactly those two MXIDs and that `m.room.encryption` is absent. Timeout, permission failure, malformed state, encryption, or an additional member is fail-closed and isolates the room. Production must grant this Application Service the required joined-members and room-state reads; without that deployment permission, native Matrix must remain disabled rather than relying on invite metadata alone.

## Telegram Adapter And Optional Matrix Transport

The direct Telegram adapter remains the default migration path. grammY owns Telegram-specific commands, callbacks, deep links, pre-checkout, successful-payment events, and provider support, while the shared Conversation Platform owns identity resolution, messages, generation, policy, handoff, entitlement, and audit.

A Telegram-to-Matrix bridge is an optional private-chat/plain-text canary. It must preserve original Telegram user, chat, thread, message, and payment references separately from Matrix room/event IDs. History backfill and outbound echoes must never create new audience messages or generation runs. Direct Telegram remains available as a feature-flagged fallback until the canary, parity, and rollback windows close.

The first canary does not include group chat, media parity, reactions, typing, read receipts, history import, E2EE, full puppeting, multiple owner bots, or multiple homeservers.

### Telegram long-poll configuration

The Dashboard stores one encrypted Telegram Bot connection per verified Bot
identity. Each digital representative selects one connection, and several
representatives under the same owner may intentionally select the same
connection. The supervisor starts one grammY long-poll runtime per active
connection and dynamically reconciles additions, pauses, and credential
rotations.

`CHANNEL_CREDENTIAL_MASTER_KEY` must be an independently generated,
base64-encoded 32-byte key; `CHANNEL_CREDENTIAL_MASTER_KEY_VERSION` identifies
the current key version. The current runtime loads one key version, so changing
either value requires re-entering every stored Bot token. Tokens are accepted
only by the authenticated
Dashboard API, verified with Telegram `getMe`, encrypted at rest, and never
returned by list or snapshot APIs. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ID`, and
`TELEGRAM_BOT_USERNAME` remain as a legacy single-Bot bootstrap path. During an
upgrade, a matching pending migrated connection is activated without changing
its owner or platform-managed scope. `TELEGRAM_WEBHOOK_SECRET` is not read by
long-polling.

Every Delegate Bot replica reconciles credential-free connection descriptors,
but it must atomically acquire that connection's PostgreSQL runtime lease
before resolving its encrypted credential. A non-holder never selects or
decrypts the token, and an unchanged holder does not decrypt it again on each
reconcile. The defaults are a five-second descriptor reconcile, a 120-second
lease, a 20-second heartbeat, and a ten-second database-operation timeout:

- `TELEGRAM_RUNTIME_RECONCILE_MS=5000`
- `TELEGRAM_RUNTIME_LEASE_MS=120000`
- `TELEGRAM_RUNTIME_LEASE_RENEW_MS=20000`
- `TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS=10000`

Lease acquisition, renewal, expiry, and takeover use the PostgreSQL clock.
Renewal and release require the exact connection, holder, and lease token, so a
stale process cannot delete its successor's lease. A failed or timed-out
heartbeat immediately stops local polling; graceful shutdown attempts a fenced
release, while a crash is recovered after expiry. Configuration validation
requires the renewal interval plus database timeout and the maximum supported
60-second Telegram request timeout to fit inside the lease duration.

The database lease coordinates only Delegate replicas. It cannot fence a
manually launched script, another deployment, or any other external
`getUpdates` consumer that does not use this database. Such a consumer remains
detectable through Telegram's `409 Conflict` response
(`another_get_updates_consumer`) and must be stopped or migrated separately.
Running the legacy environment-token fallback without PostgreSQL is therefore
supported only as a single-instance development mode.

The current paid continuation path sends users to the Web demo/mock recharge
surface. `TELEGRAM_WEB_RECHARGE_BASE_URL` lets the Bot use a public origin
without changing the representative app's canonical origin, and falls back to
`NEXT_PUBLIC_REPRESENTATIVE_URL` when unset. The resolved value must be a public
HTTPS origin for Telegram to emit a clickable inline recharge button. Loopback,
private-network, `.local`, credential-bearing, or non-HTTPS URLs are sent only
as message text for local testing. The official Telegram continuation requires
a signed-in Web audience and an exact verified Telegram identity link for the
active Bot before recharge creation; completion and reversal remain owned by
the canonical Web identity even if a channel link is later revoked. A clickable
button does not make the underlying mock flow production-ready.

### Telegram runtime ownership and delivery recovery

`TELEGRAM_CONVERSATION_PLATFORM_MODE` is a single-owner contract shared by the
Telegram adapter and conversation worker:

- `legacy`: grammY owns text generation and delivery;
- `shadow`: grammY still owns replies while the Conversation Platform only
  persists comparison messages and creates no generation outbox;
- `worker`: grammY only accepts private text into the durable platform and the
  conversation worker owns both representative and Operator delivery.

`worker` is the default and is a production release gate. The bot and worker
reject `legacy` or `shadow` when `NODE_ENV=production`, and new Stars invoices
are disabled outside `worker` even in development. This prevents the legacy
conversation unlock flags from bypassing the shared, finite entitlement
ledger. `legacy` and `shadow` remain local migration/rollback diagnostics for
unpaid traffic only; they are not valid paid production modes.

Stars invoice creation is separately default-off behind
`TELEGRAM_STARS_LIVE_ENABLED`. The current long-polling bot cannot guarantee
that a charged update survives a database outage before the durable payment
inbox write, so production rejects live Stars even when that flag is set.
Successful-payment events that do reach the database are persisted first and
retried idempotently, but live Stars remains a launch blocker until Telegram
updates enter through a durable webhook/raw-ingress boundary.

The worker refuses to claim either Telegram generation or Telegram Operator
outbox work unless the mode is `worker`. A refused claim is deferred without
consuming a retry attempt. The worker rejects unknown mode values at startup;
deployments must inject and pre-validate the same value for the Telegram
adapter rather than relying on an implicit fallback.

Outbox `availableAt` is also the processing-lease deadline. Expired
`PROCESSING` work can be reclaimed after a crash. The default
`CONVERSATION_OUTBOX_PROCESSING_LEASE_MS` is five minutes and five minutes is
also the enforced minimum. The conversation worker renews an active generation
lease while work continues and fences writes by the owning lease attempt, so a
stale worker cannot extend or complete work after another worker has reclaimed
it.

Generation completion and provider delivery are separate recoverable phases.
Once an output `Message` exists, retries use that persisted text and never run
the model or consume the entitlement again. A persisted provider
`externalMessageId` closes the outbox without another send.

Matrix delivery uses a stable transaction id and is provider-idempotent.
Telegram Bot API `sendMessage` has no client idempotency key, so Telegram
delivery is deliberately **at-least-once**, not exactly-once. The worker applies
`TELEGRAM_REQUEST_TIMEOUT_MS`, persists successful Telegram message ids, and
avoids resending once that receipt exists. A process failure after Telegram
accepted a message but before its id was committed remains an ambiguous outcome
and can produce a duplicate; operations and UI must expose that reconciliation
case rather than claim exactly-once delivery.

Cutover and rollback are stop-the-owner operations:

1. move all bot instances to `shadow` and verify no generation outbox is
   created by shadow traffic;
2. roll bot instances to `worker` before enabling Telegram ownership in the
   worker fleet;
3. on rollback, first stop or roll every worker instance out of `worker`,
   record the Telegram update/outbox high-water marks, and only then restore
   grammY `legacy` replies;
4. keep completed-but-undelivered outputs frozen for reconciliation; never
   regenerate them under the legacy runtime.

## Compatibility Migration

Legacy `ConversationTurn`, `telegramUserId`, and `telegramChatId` remain available while adapters migrate.

1. Add and dual-write channel-neutral models.
2. Add source/transport, verified identity, audience-scoped entitlement, and channel-state invariants.
3. Backfill existing Web and Telegram conversations with restartable, idempotent jobs and retained high-water marks.
4. Move readers to `Message` and `ConversationChannelBinding`.
5. Move Telegram business behavior to the shared platform while keeping one active adapter owner and a direct fallback.
6. Complete native Matrix provisioning and durable inbox processing.
7. Run any Telegram-to-Matrix bridge behind a per-representative canary flag.
8. Remove Telegram-shaped required fields only after parity, reconciliation, and rollback windows pass.

Rollback disables the canary adapter, restores the previous active adapter owner, and resumes from durable pending events and provider high-water marks. Already-completed replies are delivered or reconciled; they are never regenerated solely because the transport changed.

## Migration Invariants

- One provider event creates at most one accepted `Message`.
- One accepted audience message creates at most one active generation result.
- Only one adapter owns provider ingestion, generation, and delivery during a cutover.
- Bridge echo and history backfill cannot trigger generation.
- Provider identity conflicts fail closed.
- Balance and usage changes are audience-scoped, atomic, append-only, and idempotent.
- Paused, unpublished, or human-controlled conversations cannot start generation.
- Unknown mappings remain retryable and observable.

## Verification

```bash
pnpm test:channels
pnpm test:channels:pg16
pnpm matrix:local:e2e

pnpm db:validate
pnpm --filter @delegate/runtime test
pnpm --filter @delegate/web-data test
pnpm --filter @delegate/dashboard typecheck
pnpm --filter @delegate/reps typecheck
pnpm --filter @delegate/matrix-bridge test
pnpm --filter @delegate/matrix-bridge typecheck
pnpm --filter @delegate/conversation-worker test
pnpm --filter @delegate/conversation-worker typecheck
```
