# Conversation Platform

Delegate uses a channel-neutral conversation domain for public web, Matrix, Telegram, and future adapters.

## Confirmed Boundaries

- PostgreSQL is the business source of truth for contacts, conversations, episodes, messages, billing, handoff, and audit.
- Matrix provides authenticated real-time rooms and multi-device synchronization. Anonymous public web chat continues to use Delegate APIs and SSE.
- One representative, audience identity, and channel reuse one long-lived `Conversation`.
- `ConversationEpisode` separates service periods without creating new Matrix rooms.
- Cross-channel identity and approved long-term memory may be shared; raw message timelines remain channel-specific.
- Human takeover uses an explicit Operator identity. AI does not automatically reply while an Operator controls the episode.

## Runtime Flow

```text
Channel event
  -> validate identity, limits, and idempotency
  -> transactionally write Message + GenerationRun + OutboxEvent
  -> acknowledge the channel
  -> generate with the episode's pinned RepresentativeVersion
  -> apply active RuntimePolicyOverlay records
  -> persist output Message, citations, usage, and audit
  -> deliver through the outbound channel adapter
```

The public web route accepts and persists the audience message, returns `202 Accepted`, and lets `apps/conversation-worker` complete the durable generation run. The page subscribes to both the run status and a durable conversation SSE stream, so representative and Operator messages appear without a refresh while PostgreSQL remains the source restored after reconnect.

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

## Matrix Application Service

`apps/matrix-bridge` implements:

- authenticated transaction ingestion;
- event idempotency through `ChannelEventInbox`;
- Matrix edit and redaction mapping;
- managed Representative and Operator virtual-user lookup;
- health and ping endpoints.

`MATRIX_AS_HS_TOKEN` is mandatory and must be injected by the environment or secret manager. Source code contains no Matrix access token or virtual-user password.

`apps/conversation-worker` claims durable generation outbox records with PostgreSQL row locking, invokes the shared representative runtime, persists the reply before delivery, and retries channel delivery without generating duplicate replies. Matrix outbound delivery is enabled only when `MATRIX_HOMESERVER_URL` and `MATRIX_AS_TOKEN` are both injected.

## Compatibility Migration

Legacy `ConversationTurn`, `telegramUserId`, and `telegramChatId` remain available while adapters migrate.

1. Add and dual-write channel-neutral models.
2. Backfill existing Web and Telegram conversations.
3. Move readers to `Message` and `ConversationChannelBinding`.
4. Remove Telegram-shaped required fields only after all adapters pass parity tests.

## Verification

```bash
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
