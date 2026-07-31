<p align="center">
  <img src="./docs/assets/delegate-hero.png" alt="Delegate hero banner showing finance, legal, healthcare, and creator workflows" width="100%" />
</p>

<p align="center">
  <a href="./README.zh-CN.md"><img alt="中文" src="https://img.shields.io/badge/中文-111827?style=for-the-badge" /></a>
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-2563EB?style=for-the-badge" /></a>
</p>

# Delegate

Think of Delegate as an AI front desk.

When people reach you on the web today, and later through channels like Matrix, Telegram, WhatsApp, or Feishu, Delegate lets your AI representative handle the first reception pass:

- answer what it can answer
- charge when the interaction should be paid
- ask you to decide when approval is needed
- hand off to you when a human should take over

Its goal is not to replace you. It catches high-frequency, standardized, priceable conversations first, so you only step in when your presence is actually needed.

Delegate is the first product wedge for **Agent Monetization Network (AMN)**, an open monetization network for AI Agents and Digital Representatives.

AMN's long-term thesis is simple: any Agent can earn, any user can buy scoped service, any platform can connect, and revenue should be transparent. Delegate turns that thesis into a concrete public digital representative: a web-first interface that answers from approved public knowledge, routes sensitive work through explicit policy, shows service packages and depth, and hands off to a human when the representative should not act alone.

It is not a private assistant exposed to the public. Delegate is a separate public runtime and service-package/profile surface for one Digital Representative at a time.

The current product wedge is intentionally narrow:

- Web-first representative runtime
- public representative page and public-safe chat
- founder representative demo data
- FAQ, intake, paid continuation, and owner handoff
- early Agent Wallet semantics through web-facing service credits, invoices, and sponsor pool state
- governed compute through an isolated broker
- durable timers for approval expiration and handoff follow-up

## What Ships Today

Delegate currently includes these working surfaces and services:

- **Marketing site** in `apps/site`, using the Dispatch Editorial design system.
- **Public representative app** in `apps/reps`, including representative profiles, service packages, web chat, WeChat checkout, and signed public-chat session state.
- **Owner dashboard** in `apps/web`, covering representative health, delegated tasks, governed actions, compute sessions, artifacts, deliverables, packages, OpenViking traces, creator training, workflow state, and Owner profile, identity-security, and Dashboard notification settings.
- **Optional Telegram bot runtime foundation** in `apps/bot`, powered by grammY and retained as the Telegram-specific edge while business behavior moves toward the shared Conversation Platform.
- **Matrix Application Service foundation** in `apps/matrix-bridge`, providing authenticated Matrix transaction ingestion and channel event mapping. Native Matrix is an optional channel; it is not required for Telegram availability.
- **AMN wallet control plane** covering immutable billing products and prices, snapshotted orders, internal wallet ledger entries, local mock payment, default-off WeChat Pay API v3 Native collection and recovery, service-credit fulfillment, usage charging, provisional Creator 20% revenue share, refund/reversal services, withdrawal request freezes, provider adapters, and owner/public wallet views.
- **Compute broker** in `apps/compute-broker`, providing governed `exec`, `read`, `write`, `process`, and `browser` requests behind approval and policy gates.
- **Workflow runner** in `apps/workflow-runner`, supporting the local runner and Temporal-backed durable workflow dispatch.
- **Prisma/Postgres data model** for representatives, contacts, conversations, delegation tasks, handoffs, approvals, invoices, compute, artifacts, deliverables, workflows, and audit trails.
- **OpenViking integration** for representative-scoped public resources, recall, session commit traces, and safe memory previews.
- **Workspace skill governance** with ClawHub metadata discovery, immutable version pinning, representative draft bindings, MCP/Compute readiness checks, unified approvals/audit, and signed patch-update policy. Third-party package code is not executed.

The durable workflow kinds implemented today are:

- `APPROVAL_EXPIRATION`
- `HANDOFF_FOLLOW_UP`
- `CREATOR_TRAINING_REVIEW`

Temporal is already wired for those workflows through post-commit command outbox dispatch, native workflow timers, cancellation cleanup, asynchronous training review, and dashboard phase observability. Ordinary real-time chat routing still stays out of Temporal.

## AMN Target Model

AMN is the broader network Delegate is growing toward. The target model is:

```text
Creator creates an Agent
  -> Agent receives its own Agent Wallet
  -> Users discover the Agent on the web first, then later on Matrix, Telegram, WhatsApp, Feishu, WeCom, or an app
  -> Users buy a service package for that specific Agent
  -> Agent serves the user
  -> Billing charges for tokens, tasks, or subscriptions
  -> Settlement calculates Creator revenue
  -> Ledger publishes transparent proof
```

The intended AMN layers are:

- **AMN Pay:** a future unified service checkout that can be opened from any platform.
- **Billing Engine:** charges for token usage, completed tasks, subscriptions, or service packages.
- **Wallet Engine:** manages balances per user × Agent / Digital Representative.
- **Settlement Engine:** calculates Creator revenue, platform fees, provider costs, and withdrawals.
- **Transparent Ledger:** records recharge, charge, settlement, and proof events so users and creators can verify state.

What is implemented today is the web-first Delegate wedge plus the first AMN
wallet loop: public representative pages, web chat, pricing tiers,
development-only mock payment, default-off WeChat Pay API v3 Native checkout,
signed payment and refund callbacks, signed query recovery, immutable
`BillingProduct` / `BillingPriceVersion` terms, snapshotted orders,
user-and-Agent-scoped service-credit fulfillment, reserve/settle/release
charging in public conversations, immediate credit refresh after purchase,
full reversal of wholly unused demo credits, Creator pending/withdrawable earnings,
creator withdrawal request/cancel UI, development-only mock review and
settlement, Owner service-package version management, encrypted tokenized
Owner/Organization payout profiles, verified-destination withdrawal snapshots,
eligible full-unused WeChat refund submission and reversal, the
workspace wallet dashboard with an owner-scoped exception queue, provider
adapter boundaries, and durable follow-up workflows.

The WeChat implementation is production-shaped but is not yet production
validated: the real merchant ¥5 payment-and-refund canary and release checklist
remain open. Code, migration, and test completion do not prove that the
merchant/AppID binding, production callbacks, API permissions, or payer flow
work in the deployed environment.

What is still not fully productionized: live Stripe SDK wiring and webhook
signing, live Alipay collection, WeChat merchant activation and live canary,
automatic payout through Stripe Connect / Alipay transfer / WeChat merchant
transfer, generic open Wallet API, chargeback automation, Merkle proof
publication, multi-currency FX, and full settlement automation.

## AMN Wallet Implementation Status

The intended architecture is **internal double-entry wallet ledger + external payment adapters**:

```text
Stripe / WeChat Pay / Alipay
  -> collect money, refund, notify, and eventually pay out

Delegate
  -> scoped service credits, provisional Creator 20%, costs, profit, withdrawal state, and audit ledger
```

Current status against the wallet plan:

| Area | Status | Notes |
| --- | --- | --- |
| Account types | Implemented | Internal user-cash clearing, deferred service credit, Creator pending/withdrawable/frozen, platform deferred/earned revenue, provider cost, external settlement, and payout clearing are modeled in Prisma. Internal cash is not a customer product or public balance. |
| Data models | Mostly implemented | Stable `BillingProduct`, immutable `BillingPriceVersion`, snapshotted `RechargeOrder`, aggregate `AgentWallet`, scoped `UserAgentWallet`, `WalletTransaction`, append-only `WalletLedgerEntry`, purchase/usage/withdrawal allocation records, provider events, Creator earnings, payout profiles/destinations, and destination-snapshotted withdrawal requests are implemented. Public users resolve through canonical `AudienceIdentity`; `UserWallet.externalUserId` remains a legacy payment selector while wallet ownership is checked through `audienceIdentityId`. |
| Integer money and tokens | Implemented | Money uses integer smallest currency units such as CNY fen and USD cents. Agent tokens are integers. |
| Service-package checkout | Mock and default-off WeChat Native flows implemented | The browser submits only a server-published price-version ID. Delegate freezes price, units, revenue share, refund, and expiry terms before its first Native POST, then persists exact replay facts and durable recovery work. Uncertain creation queries the same order before exact replay. Local QR expiry never cancels money, and a lost QR permits replacement only after a delayed signed provider close. Verified late success still grants the snapshotted package exactly once. Every public purchase write requires a verified Web account; mock endpoints are unavailable in production. Live merchant activation remains gated by the runbook canary. |
| User receives representative service credits | Implemented | Payment credits and clears the internal cash account in the same transaction, credits the exact `UserAgentWallet`, grants the matching canonical `ServiceEntitlement`, creates a FIFO purchase lot and Creator pending earnings from the order snapshot, updates the aggregate Agent projection, and writes all records atomically. |
| Agent consumes service credits | Implemented for public conversation flow | Acceptance atomically chooses a conversation-locked free slot or reserves the same canonical audience units in both the wallet and entitlement ledgers before publishing work. Successful replies and approved Compute settle both; non-billable, rejected, edited, redacted, canceled, and terminal-failure paths transfer or release both, including retry-backoff runs. Multi-step Compute/MCP tasks transfer one server-verified run owner and finalize it exactly once; generation writes are fenced by renewable worker leases. Wallet/entitlement drift fails closed on a consistent snapshot, and the package root exposes only the composite dual-ledger usage lifecycle. |
| Creator withdrawal | Profile and operational mock loop implemented | Verified creators configure an Owner/Organization payout profile backed by an encrypted opaque WeChat recipient token and masked display label. A withdrawal requires an active CNY destination, snapshots it immutably, and allocates/freezes exact earnings FIFO. Local-only review/activation and mock operations demonstrate the lifecycle; both are unavailable in production. Production Operator RBAC, maker/checker approval, provider submission, proof, and reconciliation are not implemented yet. |
| Refund and reversal | Eligible WeChat full-refund loop implemented | The authenticated billing dashboard can queue one idempotent full refund for a wholly unused and unreserved WeChat purchase. Delegate persists the refund intent, freezes entitlement, and durably marks the first submission `UNKNOWN` before the provider call. Every uncertain outcome queries the original `out_refund_no`; exact replay or deterministic rejection is allowed only after signed not-found evidence. Unknown codes and unsafe, ambiguous, abnormal, or unresolved cases remain frozen for reconciliation. Verified callback/query facts drive idempotent reversal. Local demo partial reversal is retained; automatic chargeback/dispute resolution remains future work. |
| Payment adapters | Mock and WeChat Native implemented | Mock remains development-only. WeChat Pay API v3 Native signs exact request bytes, verifies response/callback signatures, supports public-key rotation with legacy platform-certificate compatibility, and never exposes provider payloads to the browser. Stripe has an injected Checkout-style boundary but no live SDK/webhook wiring; Alipay remains fail closed. Delegate does not handle card numbers, bank cards, payment passwords, or raw sensitive payment data. |
| WeChat operations | Implemented | The workflow runner executes order reconciliation, refund lifecycle, and refund reversal as independently tracked lanes so one failure does not suppress the others. Liveness, readiness, and redacted operations health have separate semantics; persistent checkpoints and per-lane `FAILED` backlog keep unresolved work visible across idle backoff, restarts, replicas, and unrelated successes. Proven exceptions across all representatives owned by the signed-in Owner appear in one private Dashboard queue with versioned, idempotent claim, exact-Outbox retry, and acknowledge actions; unmatched platform events are never assigned to an owner. |
| Database safety gate | Implemented | Validated PostgreSQL checks protect cash, scoped-credit, Creator earning, usage, paid-withdrawal, and refund lifecycle invariants. `pnpm test:postgres:wallet` runs real PostgreSQL 16 races and recovery scenarios for duplicate recharge, concurrent spending, payment callback/query convergence, refund idempotency, unknown-outcome query-first recovery, terminal-fact replay, and withdrawal freezing. |
| First-version exclusions | Preserved | No automatic cross-border payout, Merkle proof, open Wallet API, unclaimed-representative auto-withdrawal, chain ledger, or multi-currency FX. |

Telegram is now an optional, non-production channel runtime for this product direction. If Delegate later ships production bot-based digital goods and services, they should follow Telegram's rules, including Telegram Stars where required. AMN Pay is a future unified checkout path, not a reason to bypass platform policy. During the current demo, Telegram sends users to the Web service-package surface. That continuation requires Web sign-in and an exact, verified binding to the active Bot before an order can be created, so credits land on the same canonical Delegate identity. An inline purchase button is emitted only when the Bot-specific `TELEGRAM_WEB_RECHARGE_BASE_URL` (or its `NEXT_PUBLIC_REPRESENTATIVE_URL` fallback) is a public HTTPS origin. Loopback or other non-public HTTP URLs remain plain message text for local testing.

## Channel Architecture Direction

Delegate is web-first today and is moving toward one channel-neutral Conversation Platform with thin provider adapters:

- PostgreSQL remains business truth for identity, messages, generation, handoff, entitlement, and audit.
- Web, native Matrix, and Telegram are external sources. Matrix is not a mandatory Telegram hub.
- `sourceProvider` records where an interaction originated; `transport` records how it was carried. Telegram transported through a Matrix bridge is still a Telegram interaction.
- Telegram and Matrix subjects bind directly to `AudienceIdentity` only after provider-specific proof. Matrix ghosts or bridge puppets are transport identities, not Delegate users.
- Web checkout and Telegram Stars remain separate payment rails. They may grant the same audience-and-representative-scoped service entitlement, but their balances and refunds are not mixed.
- The first channel migration is private-chat and plain-text only, with per-representative rollout and a direct Telegram fallback.

The accepted decision, migration order, and rollback invariants are documented in [the channel Conversation Platform ADR](./docs/adr-channel-conversation-platform.md).

## Architecture Principles

Delegate is built around a few hard boundaries:

- **Postgres is business truth.** Delegation tasks connect workflow, billing, handoff, approval, outputs, and dashboard state in Postgres without treating a conversation or runtime session as the task itself.
- **Channels share a business runtime, not necessarily a transport.** Provider adapters converge on the Conversation Platform; Matrix remains optional infrastructure rather than a required Telegram dependency.
- **Provider identity requires provider proof.** External subjects bind to `AudienceIdentity`; usernames, display names, room membership, ghosts, and puppets are not account-linking evidence.
- **Entitlement is unified, payment rails are not.** Web money and Telegram Stars retain their own settlement and refund semantics while granting audience-scoped service access.
- **Temporal is orchestration.** Temporal handles start, durable waiting, retry, wake-up, and cancellation delivery for long-running workflow timers.
- **Public representatives are not private workspaces.** The runtime does not read owner-private files, accounts, secrets, or hidden notes.
- **Users buy scoped service, not generic platform cash.** The page must identify the Digital Representative, package, included credits, and refund terms.
- **Compute is isolated and governed.** General-purpose commands and browser work go through the compute broker, capability policy, audit records, and owner-visible approvals.
- **Memory is scoped.** OpenViking stores representative-scoped public resources and public-safe long-term context, not owner-private state.
- **Policy beats prompt luck.** Sensitive actions pass through explicit `allow`, `ask`, or `deny` decisions instead of relying only on model behavior.

## Workspace Layout

```text
apps/
  bot/              Optional Telegram runtime foundation
  conversation-worker/ Durable channel generation and delivery worker
  compute-broker/   Isolated compute and browser broker
  matrix-bridge/    Optional native Matrix Application Service
  reps/             Public representative pages and public chat
  site/             Marketing website
  web/              Owner dashboard
  workflow-runner/  Local and Temporal workflow runner

packages/
  artifacts/          Artifact object-key and retention helpers
  capability-policy/  Capability gate evaluation primitives
  compute-protocol/   Typed compute broker payloads and schemas
  domain/             Shared schemas and demo representative data
  lifecycle-hooks/    Runtime lifecycle event hooks
  model-runtime/      Model context assembly and provider runtime
  openviking/         Typed OpenViking client, URI rules, and safety filters
  registry/           External skill registry clients
  runtime/            Inquiry classification and action-gate policy
  web-data/           Dashboard and public-page data access helpers
  web-ui/             Shared CSS/design system assets
  workflows/          Shared workflow kinds, inputs, and scheduling helpers

prisma/
  schema.prisma       Database schema
  migrations/         Prisma migrations

docs/
  architecture.md
  adr-channel-conversation-platform.md
  delegate-architecture-decisions.md
  public-audience-identity.md
  per-user-sandbox-runtime.md
  temporal-native-workflow-rfc.md
  creator-training-loop.md
  v2-isolated-compute-plane-plan.md
  openviking-integration.md
  roadmap.md
```

## Quick Start

Prerequisites:

- Node.js 20.18.1 or newer and pnpm
- Docker with Docker Compose v2.24.4 or newer, if you want the full local stack
- Provider API keys only when you want live model or OpenViking calls

Install dependencies and create local env:

```bash
pnpm install
cp .env.example .env
```

Start the local test stack. This explicit override runs only the Dashboard and
representative app in development mode, enables the built-in local identities,
and keeps production authentication fail-closed:

```bash
pnpm docker:up:local
```

Use `pnpm docker:up` for the production-shaped local stack; it requires a
configured Logto Traditional Web application before creator login can succeed.
The repository also includes a separate, loopback-only Logto OSS v1.41.0
baseline with its own PostgreSQL database. Bootstrap its generated local
credentials and initialize the database exactly once:

```bash
pnpm logto:local:bootstrap
pnpm logto:local:config
pnpm logto:local:init
```

Subsequent starts use `pnpm logto:local:up`; `pnpm logto:local:smoke` verifies
OIDC discovery, JWKS, the token endpoint, and the Admin Console SPA.
`pnpm logto:local:backup` creates a checksummed database + credential + Secret
Vault KEK recovery set before an upgrade. Application IDs and secrets still
need to be created manually in the Console. See
[`docs/logto-self-hosting-runbook.md`](docs/logto-self-hosting-runbook.md) for
the exact Console setup, one-shot upgrade flow, and production boundaries.

Native Matrix is optional and is not part of Telegram delivery. The Matrix
command bootstraps a development-only Synapse instance with random local
Application Service tokens, then includes the same local app override. Its
Synapse and bridge ports are published only on host loopback:

```bash
pnpm docker:up:matrix
```

For the smaller Matrix protocol gate, start an independently registered
`matrix-e2e.local` Synapse, an isolated `delegate_matrix_e2e`
database/migration job, and its own Matrix bridge, then run the real Client API
and disconnect/reconnect lifecycle smoke:

```bash
pnpm matrix:local:up
pnpm matrix:local:smoke
```

See [`docs/matrix-local-synapse.md`](docs/matrix-local-synapse.md) for generated
credential locations, the one-command E2E flow, full Dashboard testing, and the
production differences.

Run the standard checks:

```bash
pnpm verify
pnpm build
```

`pnpm verify` generates the Prisma client first, validates the checked-in schema,
then runs workspace typechecks and tests in that order.

Useful local URLs for the default Docker profile:

- Site: `http://localhost:3000`
- Dashboard: `http://localhost:3001/dashboard?view=overview`
- Representative: `http://localhost:3002/reps/lin-founder-rep`
- Dashboard liveness: `http://localhost:3001/health`
- Representative liveness: `http://localhost:3002/health`
- Representative readiness: `http://localhost:3002/ready`
- Compute broker health: `http://localhost:4010/health`
- Workflow runner health: `http://localhost:4020/health`
- Workflow runner readiness: `http://localhost:4020/ready`
- Workflow runner WeChat operations health: `http://localhost:4020/operations/wechat-pay/health`
- Artifact store API: `http://localhost:9000`
- Artifact store console: `http://localhost:9001`
- OpenViking API: `http://localhost:1933`
- OpenViking console docs: `http://localhost:8020/docs`
- Local Synapse Client API (Matrix profile): `http://127.0.0.1:8008`
- Matrix Application Service bridge (Matrix profile): `http://127.0.0.1:4030`
- Isolated Matrix E2E Client API: `http://127.0.0.1:8009`
- Isolated Matrix E2E bridge: `http://127.0.0.1:4031`
- Local Logto core: `http://127.0.0.1:3301`
- Local Logto Admin Console: `http://127.0.0.1:3302`

If you are running the three Next.js apps manually side by side, use explicit ports:

```bash
PORT=3100 pnpm dev:site
PORT=3101 pnpm dev:dashboard
PORT=3102 pnpm dev:reps
```

Then open:

- Site: `http://localhost:3100`
- Dashboard: `http://localhost:3101/dashboard?view=overview`
- Representative: `http://localhost:3102/reps/lin-founder-rep`

For database-only local development:

```bash
pnpm docker:up:db
pnpm db:setup
pnpm dev:site
pnpm dev:dashboard
pnpm dev:reps
pnpm dev:bot
```

## Temporal Workflow Mode

Delegate defaults to the built-in local runner:

```bash
WORKFLOW_ENGINE=local_runner
```

In local-runner mode, due workflow rows are processed directly by `apps/workflow-runner`.

To run the Temporal profile:

```bash
pnpm docker:up:temporal
```

That profile starts Temporal, Temporal UI, namespace setup, and the workflow runner with Temporal settings. Once it is healthy, check:

- Temporal UI: `http://localhost:8233`
- Workflow runner: `http://localhost:4020/health`

The health response should report `engine: "temporal"` and a running Temporal bridge.

The current Temporal model is:

1. Producers write business truth, `WorkflowRun`, and `WorkflowCommandOutbox` in the same committed Postgres flow.
2. The workflow runner dispatches `START` and `CANCEL` commands after commit.
3. Temporal starts the workflow immediately with `externalWorkflowId` as the stable idempotency key.
4. The workflow receives `scheduledAt`, sleeps durably until that time, then runs a DB-backed idempotent activity.
5. Manual resolution updates Postgres first and treats Temporal cancellation as cleanup, not authority.

If Temporal configuration is incomplete, Delegate falls back to `local_runner` rather than enqueueing unserviceable Temporal jobs.

## Environment Guide

The default `.env.example` is safe for local development. Important settings:

- `DATABASE_URL` points Prisma to Postgres.
- `LOGTO_ENDPOINT` and `LOGTO_SCOPES` are shared OIDC settings. `LOGTO_BACKCHANNEL_ENDPOINT` may provide a trusted server-only route for token and JWKS calls, but authorization URLs and issuer validation always use the public `LOGTO_ENDPOINT`. Dashboard uses only `LOGTO_DASHBOARD_APP_ID` / `LOGTO_DASHBOARD_APP_SECRET`; Public Representatives uses only `LOGTO_REPS_APP_ID` / `LOGTO_REPS_APP_SECRET`. Each callback is derived from its canonical `NEXT_PUBLIC_*` origin at `/auth/callback`; there is no deployment-supplied redirect URI or cross-application credential fallback.
- `LOGTO_REPS_LEGACY_ENDPOINT`, `LOGTO_REPS_LEGACY_APP_ID`, `LOGTO_REPS_LEGACY_APP_SECRET`, and the future RFC3339 `DELEGATE_REPS_LEGACY_CALLBACK_UNTIL` belong only to the Reps service and exist solely to drain already-issued v1/v2 dynamic callbacks in place. Missing, malformed, or expired compatibility configuration makes the old callback return `410` without a token request. Remove the complete tuple after the drain deadline.
- The self-hosted local Logto infrastructure uses a separate generated `.local/logto/logto.env`, not the root application `.env`. `pnpm logto:local:bootstrap` creates it with a dedicated database password and Secret Vault KEK; its committed key contract is documented in `deploy/logto/logto.env.example`.
- `LOGTO_ACCOUNT_CENTER_URL` optionally exposes a validated Logto self-service account-management link in Owner Settings. Production values must use HTTPS; local development may use loopback HTTP.
- `DELEGATE_CREATOR_ADMISSION_PRINCIPALS` is the comma- or newline-separated allowlist of exact `issuer|subject` Logto principals that may create a new Creator account. A successful Logto login alone never creates an Owner. Existing Owner identity links continue to work after their principal is removed; subject-only entries and wildcards are intentionally rejected.
- `DELEGATE_ACCOUNT_SESSION_MODE` is the finite `legacy | shadow | enforce | contract` rollout state for Account/AppSession v2 and defaults to `legacy`. `legacy` never accesses the v2 account/session tables. `shadow` keeps the signed legacy cookies authoritative while callbacks atomically resolve the exact issuer+subject Account, CAS-bind the already-authorized persona, rotate any prior v2 token, and issue the HttpOnly `delegate_dashboard_session_v2` or cross-representative `delegate_reps_session_v2` cookie. Shadow logout revokes the browser-held application token when storage is available, while every mode deletes the browser cookie. `enforce` and `contract` deliberately reject login and stop trusting legacy cookies until v2 read authority is implemented; setting either early cannot silently fall back to legacy authentication.
- Owner Settings notification preferences control Dashboard navigation reminders only. They do not enable email, SMS, Slack, webhook, or quiet-hours delivery.
- `NEXT_PUBLIC_DASHBOARD_URL` and `NEXT_PUBLIC_REPRESENTATIVE_URL` are required canonical public origins for the production-shaped apps. The local override fixes them to loopback origins so development login cannot be redirected to a remote host through a reused environment file.
- `TELEGRAM_WEB_RECHARGE_BASE_URL` optionally gives only the Bot a public Web-recharge origin without changing the representative app's canonical origin. It falls back to `NEXT_PUBLIC_REPRESENTATIVE_URL`; only public HTTPS values produce an inline button, while local HTTP values are sent as text.
- `DELEGATE_AUTH_SESSION_SECRET` signs dashboard and representative auth/callback-state cookies. Reps fixed-callback state also carries the signed Representative slug and complete anonymous public-chat binding so the root callback never derives identity from Host or unsigned query values. Set a strong secret in production.
- `DELEGATE_DASHBOARD_AUTH_MODE=required` forces dashboard auth in non-production environments; production always requires it.
- `DELEGATE_AUTH_DEV_LOGIN` and the `DELEGATE_AUTH_DEV_*` identities are accepted only outside production and only when the login switch is explicitly enabled. `DELEGATE_LOCAL_AUTH_BOOTSTRAP=true` separately permits the local fixture binding step. Both default to disabled in `.env.example`; `pnpm docker:up:local` explicitly enables them and binds the development subject to the seeded demo Owner without weakening the production login boundary.
- `NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS=true` exposes the explicitly labeled local service-package panel so mock payment, direct credit grant, usage, and wholly-unused reversal can be exercised. Order creation, completion, and reversal require a signed-in audience account. Telegram continuations additionally require the current verified Bot binding. Keep it `false` outside development; the mock mutation endpoints also return `404` in production. This switch does not enable WeChat Pay.
- `DELEGATE_WECHAT_PAY_COLLECTION_ENABLED` controls creation of new WeChat
  Native orders. `DELEGATE_WECHAT_PAY_PROCESSING_ENABLED` independently keeps
  callbacks, signed order/refund queries, refund submission recovery, and
  ledger reversal running for existing money. Collection is invalid without
  processing. Configure both split flags together using exact lowercase
  `true`/`false`; partial or misspelled values fail readiness. The older
  `DELEGATE_WECHAT_PAY_ENABLED` is only a compatibility fallback when both
  split flags are absent.
- `WECHAT_PAY_NOTIFY_URL` and `WECHAT_PAY_REFUND_NOTIFY_URL` are separate
  credential-free public HTTPS callback URLs. When blank, both can be derived
  from a public origin-only `NEXT_PUBLIC_REPRESENTATIVE_URL`. During WeChat's
  public-key gray migration, configure both the current
  `WECHAT_PAY_PUBLIC_KEY_ID`/`WECHAT_PAY_PUBLIC_KEY_BASE64` pair and the prior
  platform certificate pair until the merchant console reaches 100% and a
  post-migration canary succeeds. See the
  [production runbook](./docs/wechat-pay-production-runbook.md).
- `DELEGATE_SKILL_TRUSTED_KEYS` is a JSON object mapping registry publisher key IDs to trusted Ed25519 public-key PEM strings. Signed patch auto-adoption remains disabled when the matching key is absent.
- `DELEGATE_CLAWHUB_URL` selects a credential-free HTTPS Registry origin, `DELEGATE_CLAWHUB_ALLOWED_HOSTS` allowlists its hostname, and `DELEGATE_CLAWHUB_TRUST_MAX_AGE_MS` bounds exact-version verification freshness (24 hours by default). Redirects are rejected. Adoption and rollback re-fetch the exact publisher/version manifest and verdict, reject stale or changed evidence, and re-evaluate signatures against the current trusted-key set before changing release state.
- `CHANNEL_CREDENTIAL_MASTER_KEY` encrypts Dashboard-managed Telegram Bot tokens at rest and must be an independently generated, base64-encoded 32-byte key (`openssl rand -base64 32`). `CHANNEL_CREDENTIAL_MASTER_KEY_VERSION` identifies the active key version; because the current runtime reads one key version, changing either value requires re-entering each Bot token. Each digital representative can select its own Bot connection, while multiple representatives owned by the same account may deliberately reuse one connection. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ID`, and `TELEGRAM_BOT_USERNAME` remain only as the legacy single-Bot bootstrap path; new Bot connections are added and verified in Dashboard without exposing tokens back to the browser.
- `PAYOUT_CREDENTIAL_MASTER_KEY` encrypts opaque WeChat Pay recipient tokens for Creator payout destinations. Generate a separate base64-encoded 32-byte key (`openssl rand -base64 32`) and identify it with `PAYOUT_CREDENTIAL_MASTER_KEY_VERSION`; never reuse the channel credential key. Delegate stores only encrypted provider tokens and masked labels—never bank-card numbers, payment passwords, or identity-document contents. Rotating the active key requires a controlled destination re-binding flow.
- `TELEGRAM_RUNTIME_RECONCILE_MS`, `TELEGRAM_RUNTIME_LEASE_MS`, `TELEGRAM_RUNTIME_LEASE_RENEW_MS`, and `TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS` control multi-replica long-poll ownership (defaults: 5s, 120s, 20s, and 10s). Replicas discover only credential-free Bot descriptors; the database lease winner alone decrypts one token and starts polling. A lost or timed-out heartbeat stops that runtime, while an expired lease allows crash takeover. This lease coordinates only Delegate Bot processes—an external script using the same token is still reported through Telegram's `409 Conflict` and must be stopped separately.
- `REP_PUBLIC_CHAT_SESSION_SECRET` can override the public-chat cookie signing secret. If unset, the reps app falls back to `TELEGRAM_WEBHOOK_SECRET` and then a local development secret.
- `DELEGATE_MODEL_ENABLED`, `DELEGATE_MODEL_PROVIDER`, `DELEGATE_MODEL_FALLBACK_PROVIDER`, and the provider-specific model variables control model-backed representative replies.
- `DELEGATE_MODEL_API_KEY` (or `OPENAI_API_KEY`), `DELEGATE_BAILIAN_API_KEY`, and `ANTHROPIC_API_KEY` enable OpenAI-compatible, Bailian, and Anthropic calls respectively. `ARK_API_KEY` is used by OpenViking/compute integrations, not by the representative reply runtime.
- `OPENVIKING_*` controls public memory sync, recall, and commit behavior.
- `COMPUTE_*` controls the broker, Docker runner, browser image, and native computer-use readiness.
- `CONVERSATION_OUTBOX_PROCESSING_LEASE_MS` defaults to the five-minute
  renewable conversation-worker lease and cannot be configured below five
  minutes.
- `WORKFLOW_*` controls local-runner versus Temporal workflow execution.
- `ARTIFACT_STORE_*` controls MinIO-backed artifact storage.
- `KNOWLEDGE_OBJECT_STORE_*` controls private knowledge source storage. Its default bucket is fixed to `delegate-1324808004`; Tencent COS can be used through its S3-compatible endpoint with `FORCE_PATH_STYLE=false`.

Knowledge files are persisted before background processing reads the original object, extracts and normalizes text, prepares retrieval chunks, and writes the document into OpenViking's vector index. An asset becomes `READY` only after source storage, extraction, and vector indexing all succeed. Archive and permanent-delete flows remove the vector index as well, preventing revoked content from remaining retrievable.

When model providers are unavailable, the bot and public representative paths fall back to deterministic previews instead of failing the conversation.

## Useful Commands

```bash
pnpm dev:site
pnpm dev:dashboard
pnpm dev:reps
pnpm dev:bot
pnpm dev:compute-broker
pnpm dev:workflow-runner

pnpm db:generate
pnpm db:validate
pnpm db:migrate:dev
pnpm db:deploy
pnpm db:seed
pnpm db:setup

pnpm test:channels
pnpm test:channels:pg16
pnpm test:postgres:owner-settings
pnpm test:logto:config

pnpm docker:ps
pnpm docker:logs
pnpm docker:down
pnpm docker:up:local
pnpm docker:up:matrix
pnpm logto:local:config
pnpm logto:local:init
pnpm logto:local:smoke
pnpm logto:local:backup
pnpm matrix:local:e2e

pnpm registry:search:clawhub "qualification"
```

`pnpm docker:down` also stops services started through the Matrix or Temporal
profiles. It does not delete the local database or other named volumes.
`pnpm matrix:local:down` is narrower: it removes only local Matrix containers
and leaves shared PostgreSQL and the rest of the application stack running.

`pnpm test:channels` is the credential-free, offline channel gate. It clears
developer-machine provider credentials, then tests and typechecks the Web,
Matrix, Telegram, worker, dashboard, and public representative packages.
`pnpm test:channels:pg16` adds disposable PostgreSQL 16 fixtures for the native
cross-channel identity/message/entitlement loop, entitlement concurrency, and
migration compatibility. These fixtures do not use the configured application
database.
`pnpm test:postgres:owner-settings` likewise creates and removes an isolated
PostgreSQL 16 container, applies every migration from a fresh database, and
verifies Owner Settings CAS, idempotency, concurrency, audit, notification, and
public-identity boundaries.

For an Owner Settings release, apply the three additive settings migrations
before deploying the application. Keep the two single-statement
`CREATE INDEX CONCURRENTLY` migrations outside any manually added transaction.
If the application rollout fails, roll back the application first and leave
these forward-compatible schema additions in place; do not run a destructive
database downgrade.

### Workspace skill migration rollout

The repository gate is read-only by default. It requires an explicit target
environment and a recent backup proof whose fingerprint covers the PostgreSQL
protocol, hostname, port, and database name. It also compares every applied,
non-rolled-back `_prisma_migrations.checksum` with the SHA-256 of the matching
local `migration.sql`:

```bash
pnpm test:migration-gate

scripts/workspace-skill-release-gate.sh \
  --environment staging \
  --backup-proof /absolute/path/to/backup-proof.json
```

The proof is JSON containing `environment`, `databaseTargetFingerprint`,
`snapshotId`, `createdAt`, and `restoreVerifiedAt`. Generate only the
non-secret target fingerprint from the same `DATABASE_URL` that the gate will
use. `restoreVerifiedAt` must describe a restore of that backup and therefore
cannot predate `createdAt`:

```bash
node -e 'const c=require("node:crypto");const u=new URL(process.env.DATABASE_URL);const p=u.protocol.replace(/:$/,"").toLowerCase();const h=u.hostname.replace(/^\[|\]$/g,"").toLowerCase();const n=u.port||"5432";const d=decodeURIComponent(u.pathname.replace(/^\/+/, ""));console.log(c.createHash("sha256").update([p,h,n,d].join("|")).digest("hex").slice(0,16))'
```

If `psql` is not installed on the host, the local Compose database supports
the same read-only preflight:

```bash
docker compose exec -T postgres psql \
  -U postgres \
  -d delegate \
  -X \
  --set ON_ERROR_STOP=1 \
  --file - \
  < prisma/preflight/workspace-skill-legacy-version-conflicts.sql
```

For a direct `psql` run, apply bounded waits rather than allowing a release job
to wait indefinitely:

```bash
PGOPTIONS="-c lock_timeout=5s -c statement_timeout=5min" \
  psql "$DATABASE_URL" \
  -X \
  --set ON_ERROR_STOP=1 \
  --file prisma/preflight/workspace-skill-legacy-version-conflicts.sql
```

Each returned row is one owner/skill ambiguity group. `issueCodes` distinguishes
`missing_version`, `version_conflict`, and `status_conflict`; the last one also
detects `installed` versus `update_available` disagreement when every binding
reports the same version. `bindingCount`, `representativeCount`,
`affectedReleaseCount`, and `affectedPendingApprovalCount` size the maintenance
window. Record and review the selected owner/version before deployment.

Migration
`20260723220000_reconcile_legacy_multi_representative_skill_versions` selects a
winner only from a non-empty historical binding by `updatedAt DESC, id DESC`.
`SkillPack.version` is catalog metadata and is never treated as adoption
evidence. When a valid winner exists, conflicting bindings are normalized to
that version but disabled, the installation becomes `NEEDS_REVIEW`, and other
historical versions remain `REJECTED` non-runnable history. When every legacy
version is null or blank, the migration creates no installed release, clears
the installed version and binding adoption fields, demotes the bindings to
`available`, disables them, and rejects any catalog-derived migrated candidate
and its pending approval. (`WorkspaceSkillInstall.installedAt` is a legacy
NOT NULL audit timestamp and is not runtime authority.) A higher
catalog version can remain only as a non-adopted `CANDIDATE` with owner approval
when a concrete historical baseline exists. The migration never enables a
binding and does not relax ClawHub trust quarantine.

The additive
`20260723224000_workspace_skill_legacy_ambiguity_corrective` migration handles
databases that already ran a former revision of the backfill. It detects both
currently visible ambiguity and the former reconciliation's exact review-note
marker, so already-normalized conflicts cannot evade quarantine. It is
idempotent and has no data effect after the current fresh migration chain.

Before approving a backup proof, perform a restore rehearsal into a new,
empty, disposable local or staging database—never production:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file /secure/path/delegate-pre-migration.dump

pg_restore \
  --exit-on-error \
  --single-transaction \
  --dbname "$DISPOSABLE_RESTORE_DATABASE_URL" \
  /secure/path/delegate-pre-migration.dump

DATABASE_URL="$DISPOSABLE_RESTORE_DATABASE_URL" \
  pnpm exec prisma migrate status --schema prisma/schema.prisma
```

The release maintenance checklist is:

1. Pause dashboard writes, workers, bots, and any job that mutates skill,
   release, approval, or representative binding rows.
2. Confirm the backup artifact, its retention, target fingerprint, and a
   successful disposable restore; save the proof outside the repository.
3. Run the read-only gate, archive its report, and review every selected
   version. An applied checksum mismatch always blocks and lists the migration
   name; there is no automatic override. Unapplied local migrations do not
   count as mismatches. If conflicts exist, the local rehearsal path
   additionally requires `--conflicts-reviewed`.
4. Apply `lock_timeout` and `statement_timeout`, then watch database locks,
   WAL growth, disk, replica lag, and application errors throughout the
   maintenance window.
5. Run the approved deployment workflow. The script deliberately refuses
   automatic deployment for staging and production; only an explicit localhost
   rehearsal can use
   `--mode deploy --maintenance-confirmed --allow-local-deploy`.
6. Rerun the preflight and require zero rows. Require `prisma migrate status`
   to report up-to-date before restoring writes, then smoke-test install,
   approval, representative publish, and MCP execution.

Before deployment, `prisma migrate status` may report pending migrations; that
is expected. A failed migration or applied checksum mismatch is never expected
and blocks the gate. A checksum mismatch requires an approved manual migration
history investigation; the additive data correction does not erase Prisma's
historical checksum warning. After deployment, both pending and failed
migrations block write-traffic recovery.

The real PostgreSQL concurrency suite is also a release gate:

```bash
pnpm test:postgres:skills
pnpm test:migration-fixture:pg16
```

Run this suite only against an isolated local or staging test database that can
be mutated and discarded. Never point it at production. The PG16 migration
fixture creates and destroys its own Docker database and covers null/blank
versions, mixed status, multi-version history, higher catalog versions, release
state, approvals, and postflight convergence. It also reproduces a formerly
applied catalog-derived installed release, then proves that only the additive
corrective migration runs, closes the erroneous approval, keeps a legitimate
catalog update candidate non-adopted, and returns the preflight to zero rows. On
large installations, validate lock and WAL impact in staging because
reconciliation updates installation, release, approval, and binding rows in one
transaction.

The first product path to dogfood is the browser representative page at `http://localhost:3102/reps/lin-founder-rep`, plus the owner dashboard at `http://localhost:3101/dashboard?view=overview`.

## Design System

Delegate uses the **Dispatch Editorial** direction from [DESIGN.md](./DESIGN.md):

- light operational surfaces shared with the public site
- teal trust/live signals with indigo automation and decision emphasis
- editorial marketing pages
- procedural, dense owner dashboard views
- trust disclosures close to primary actions

The project uses resilient local CSS font fallbacks during builds. If exact Instrument Sans, Instrument Serif, or IBM Plex Mono rendering is required later, self-host those font files instead of relying on build-time Google Fonts fetches.

## Documentation Map

- [Architecture](./docs/architecture.md): product thesis, runtime loop, security boundary, and OpenViking rules.
- [Architecture decisions](./docs/delegate-architecture-decisions.md): larger system direction and tradeoffs.
- [Public audience identity](./docs/public-audience-identity.md): web identity, Contact/Conversation, service purchase, and sandbox linkage.
- [Wallet & Billing product contract](./docs/wallet-billing-product-contract.md): V1 package, price-version, entitlement, revenue, refund, and production-gate rules.
- [Wallet & Billing funds-flow ADR](./docs/adr-wallet-billing-funds-flow.md): immutable checkout terms, internal clearing, ledger flow, and consequences.
- [Conversation platform](./docs/conversation-platform.md): channel-neutral messages, episodes, versions, human control, SSE, and Matrix Application Service boundaries.
- [Channel Conversation Platform ADR](./docs/adr-channel-conversation-platform.md): source/transport separation, identity proof, Web/Stars entitlement, channel MVP, migration, and rollback decisions.
- [Delegation tasks](./docs/delegation-tasks.md): task aggregate, lifecycle, ownership validation, approvals, outputs, and audit linkage.
- [Delegation task product contract](./docs/delegation-task-product-contract.md): creation rules, visible lifecycle, owner actions, approval binding, completion, and the current P1 boundary.
- [Creator training loop](./docs/creator-training-loop.md): source registry, creator feedback, suggestion workflow, review, evaluation, and rollback.
- [Temporal-native workflow RFC](./docs/temporal-native-workflow-rfc.md): workflow state model, outbox, timer, cancellation, and dashboard semantics.
- [V2 isolated compute plane plan](./docs/v2-isolated-compute-plane-plan.md): compute and browser isolation model.
- [OpenViking integration](./docs/openviking-integration.md): public memory and recall integration.
- [WeChat Pay production runbook](./docs/wechat-pay-production-runbook.md): split release controls, callback and refund recovery, readiness, incidents, and the live merchant canary.
- [Roadmap](./docs/roadmap.md): staged product and platform direction.
- [Gap analysis](./docs/gap-analysis.md): remaining product and architecture gaps.
- [Design system](./DESIGN.md): visual direction and implementation notes.

## Current Boundaries

Delegate can:

- answer from public representative knowledge
- collect structured intake
- offer paid continuation
- show web-first service-package/service-depth UI and order records
- show representative-scoped service credits and wallet operations for a specific Digital Representative
- run a default-off, signed WeChat Pay Native collection and eligible
  full-unused refund recovery path after its explicit production gates are met
- create owner handoff requests
- run governed compute and browser tasks through the broker
- persist artifacts, deliverables, package downloads, audit events, and ledgers
- expire approvals and follow up on handoffs through durable workflow timers

Delegate intentionally does not:

- expose owner-private workspace memory
- run arbitrary host commands from the representative runtime
- mutate real calendars or private accounts silently
- treat raw Temporal history as business truth
- migrate ordinary chat replies into long-running workflows
- trust client-supplied public-chat tier or recent-turn state as authority
- claim AMN Pay, withdrawals, generic wallet APIs, settlement automation, or Merkle proofs are shipped before they exist
