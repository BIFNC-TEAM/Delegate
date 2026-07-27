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

AMN's long-term thesis is simple: any Agent can earn, any user can recharge, any platform can connect, and revenue should be transparent. Delegate turns that thesis into a concrete public digital representative: a web-first interface that answers from approved public knowledge, routes sensitive work through explicit policy, shows recharge/service depth, and hands off to a human when the representative should not act alone.

It is not a private assistant exposed to the public. Delegate is a separate public runtime and recharge/profile surface for one Digital Representative at a time.

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
- **Public representative app** in `apps/reps`, including representative profiles, service tiers, web chat, recharge-entry modules, and signed public-chat session state.
- **Owner dashboard** in `apps/web`, covering representative health, delegated tasks, governed actions, compute sessions, artifacts, deliverables, packages, OpenViking traces, creator training, and workflow state.
- **Optional Telegram bot runtime foundation** in `apps/bot`, powered by grammY and retained as the Telegram-specific edge while business behavior moves toward the shared Conversation Platform.
- **Matrix Application Service foundation** in `apps/matrix-bridge`, providing authenticated Matrix transaction ingestion and channel event mapping. Native Matrix is an optional channel; it is not required for Telegram availability.
- **AMN wallet control plane** covering internal wallet ledger entries, mock recharge, Agent token purchase, usage charging, Creator 20% revenue policy, refund/reversal services, withdrawal request freezes, provider adapters, and owner/public wallet views.
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
  -> Users recharge that specific Agent
  -> Agent serves the user
  -> Billing charges for tokens, tasks, or subscriptions
  -> Settlement calculates Creator revenue
  -> Ledger publishes transparent proof
```

The intended AMN layers are:

- **AMN Pay:** a future unified recharge entry that can be opened from any platform.
- **Billing Engine:** charges for token usage, completed tasks, subscriptions, or service packages.
- **Wallet Engine:** manages balances per user × Agent / Digital Representative.
- **Settlement Engine:** calculates Creator revenue, platform fees, provider costs, and withdrawals.
- **Transparent Ledger:** records recharge, charge, settlement, and proof events so users and creators can verify state.

What is implemented today is the web-first Delegate wedge plus the first AMN wallet loop: public representative pages, web chat, pricing tiers, development-only mock recharge, user cash balance, user-and-Agent-scoped service-credit purchase, reserve/settle/release charging in public conversations, immediate balance refresh after purchase, return of unused demo credits to wallet cash, Creator pending/withdrawable earnings, creator withdrawal request/cancel UI, development-only mock review and settlement, partial refund/reversal services, the workspace wallet dashboard, provider adapter boundaries, and durable follow-up workflows.

What is still not fully productionized: live Stripe SDK wiring and webhook signing, live WeChat Pay or Alipay credentials and certificate flows, automatic payout through Stripe Connect / Alipay transfer / WeChat merchant transfer, generic open Wallet API, chargeback automation, Merkle proof publication, multi-currency FX, and full settlement automation.

## AMN Wallet Implementation Status

The intended architecture is **internal double-entry wallet ledger + external payment adapters**:

```text
Stripe / WeChat Pay / Alipay
  -> collect money, refund, notify, and eventually pay out

Delegate
  -> user balance, Agent tokens, Creator 20%, costs, profit, withdrawal state, and audit ledger
```

Current status against the wallet plan:

| Area | Status | Notes |
| --- | --- | --- |
| Account types | Implemented | User cash, deferred service credit, Creator pending/withdrawable/frozen, platform deferred/earned revenue, provider cost, external settlement, and payout clearing are modeled in Prisma. |
| Data models | Mostly implemented | `UserWallet`, aggregate `AgentWallet`, scoped `UserAgentWallet`, `WalletTransaction`, append-only `WalletLedgerEntry`, purchase/usage/withdrawal allocation records, recharge/provider events, Creator earnings, and withdrawal requests are implemented. Public users resolve through canonical `AudienceIdentity`; `UserWallet.externalUserId` remains a legacy payment selector while wallet ownership is checked through `audienceIdentityId`. |
| Integer money and tokens | Implemented | Money uses integer smallest currency units such as CNY fen and USD cents. Agent tokens are integers. |
| User recharge | Implemented for development mock flow | Recharge creation, idempotent provider events, payment completion, cash credit, and representative-scoped service-credit purchase can complete atomically. Mock endpoints are unavailable in production. |
| User buys Agent service credits | Implemented | The service checks `UserWallet`, debits cash, credits the exact `UserAgentWallet`, grants the matching canonical `ServiceEntitlement`, creates a FIFO purchase lot and Creator pending earnings, updates the aggregate Agent projection, and writes all records in one transaction. |
| Agent consumes service credits | Implemented for public conversation flow | Acceptance atomically chooses a conversation-locked free slot or reserves the same canonical audience units in both the wallet and entitlement ledgers before publishing work. Successful replies and approved Compute settle both; non-billable, rejected, edited, redacted, canceled, and terminal-failure paths transfer or release both, including retry-backoff runs. Multi-step Compute/MCP tasks transfer one server-verified run owner and finalize it exactly once; generation writes are fenced by renewable worker leases. Wallet/entitlement drift fails closed on a consistent snapshot, and the package root exposes only the composite dual-ledger usage lifecycle. |
| Creator withdrawal | Operational mock loop implemented | Verified creators can submit and cancel representative-scoped requests from the workspace wallet. Requests allocate and freeze exact earnings FIFO. A non-production-only operations endpoint demonstrates approve, reject, paid, transient failure, retry, and permanent-failure release; it is unavailable in production. Automatic payout submission is not implemented yet. |
| Refund and reversal | Partially implemented | Paid recharge refunds and partial reversal of unconsumed purchase lots retract wallet credits and the matching unspent `ServiceEntitlement` atomically. The public development flow can return its own unused credits to wallet cash after audience and representative ownership checks. Full provider refund submission, chargeback automation, and dispute freezing remain future work. |
| Payment reuse | Adapter boundary implemented | Mock provider is live. Stripe Checkout-style adapter is implemented through an injected client boundary. WeChat Pay and Alipay adapters are fail-closed skeletons requiring official SDK / OpenAPI callbacks and signature verification before use. Delegate does not handle card numbers, bank cards, payment passwords, or raw sensitive payment data. |
| Database safety gate | Implemented | Validated PostgreSQL checks protect cash, scoped-credit, Creator earning, usage, and paid-withdrawal invariants. `pnpm test:postgres:wallet` runs real PostgreSQL 16 races for duplicate recharge, concurrent spending, final-credit reservation, terminal usage mutation, and withdrawal freezing. |
| First-version exclusions | Preserved | No automatic cross-border payout, Merkle proof, open Wallet API, unclaimed-representative auto-withdrawal, chain ledger, or multi-currency FX. |

Telegram remains future channel infrastructure for this product direction. If Delegate later ships bot-based digital goods and services, they should follow Telegram's rules, including Telegram Stars where required. AMN Pay is a future web/unified recharge path, not a reason to bypass platform policy.

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
- **Users recharge an Agent, not the platform generically.** The page should make clear which Digital Representative receives the balance.
- **Compute is isolated and governed.** General-purpose commands and browser work go through the compute broker, capability policy, audit records, and owner-visible approvals.
- **Memory is scoped.** OpenViking stores representative-scoped public resources and public-safe long-term context, not owner-private state.
- **Policy beats prompt luck.** Sensitive actions pass through explicit `allow`, `ask`, or `deny` decisions instead of relying only on model behavior.

## Workspace Layout

```text
apps/
  bot/              Optional Telegram runtime foundation
  compute-broker/   Isolated compute and browser broker
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
- Docker, if you want the full local stack
- Provider API keys only when you want live model or OpenViking calls

Install dependencies and create local env:

```bash
pnpm install
cp .env.example .env
```

Start the full Docker Compose stack:

```bash
pnpm docker:up
```

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
- Compute broker health: `http://localhost:4010/health`
- Workflow runner health: `http://localhost:4020/health`
- Artifact store API: `http://localhost:9000`
- Artifact store console: `http://localhost:9001`
- OpenViking API: `http://localhost:1933`
- OpenViking console docs: `http://localhost:8020/docs`

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
- `LOGTO_ENDPOINT`, `LOGTO_APP_ID`, `LOGTO_APP_SECRET`, `LOGTO_REDIRECT_URI`, and `LOGTO_SCOPES` enable Logto-compatible OIDC login for creator dashboard sessions.
- `DELEGATE_AUTH_SESSION_SECRET` signs dashboard auth and callback-state cookies. Set a strong secret in production.
- `DELEGATE_DASHBOARD_AUTH_MODE=required` forces dashboard auth in non-production environments; production always requires it.
- `NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS=true` exposes the explicitly labeled local recharge panel so the mock recharge, service-credit purchase, usage, and unused-credit return loop can be exercised. Keep it `false` outside development; the mock mutation endpoints also return `404` in production.
- `DELEGATE_SKILL_TRUSTED_KEYS` is a JSON object mapping registry publisher key IDs to trusted Ed25519 public-key PEM strings. Signed patch auto-adoption remains disabled when the matching key is absent.
- `DELEGATE_CLAWHUB_URL` selects a credential-free HTTPS Registry origin, `DELEGATE_CLAWHUB_ALLOWED_HOSTS` allowlists its hostname, and `DELEGATE_CLAWHUB_TRUST_MAX_AGE_MS` bounds exact-version verification freshness (24 hours by default). Redirects are rejected. Adoption and rollback re-fetch the exact publisher/version manifest and verdict, reject stale or changed evidence, and re-evaluate signatures against the current trusted-key set before changing release state.
- `TELEGRAM_BOT_TOKEN`, numeric `TELEGRAM_BOT_ID`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET` enable the optional Telegram bot foundation, but the first Delegate product version is web-first. Channel binding fails closed when the numeric bot ID cannot be configured or derived from the token.
- `REP_PUBLIC_CHAT_SESSION_SECRET` can override the public-chat cookie signing secret. If unset, the reps app falls back to `TELEGRAM_WEBHOOK_SECRET` and then a local development secret.
- `DELEGATE_MODEL_ENABLED`, `DELEGATE_MODEL_PROVIDER`, `DELEGATE_OPENAI_MODEL`, and `DELEGATE_ANTHROPIC_MODEL` control model-backed representative replies.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ARK_API_KEY` enable live provider calls.
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

pnpm docker:ps
pnpm docker:logs
pnpm docker:down

pnpm registry:search:clawhub "qualification"
```

`pnpm test:channels` is the credential-free, offline channel gate. It clears
developer-machine provider credentials, then tests and typechecks the Web,
Matrix, Telegram, worker, dashboard, and public representative packages.
`pnpm test:channels:pg16` adds disposable PostgreSQL 16 fixtures for the native
cross-channel identity/message/entitlement loop, entitlement concurrency, and
migration compatibility. These fixtures do not use the configured application
database.

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
- [Public audience identity](./docs/public-audience-identity.md): web anonymous identity, Contact/Conversation, recharge, and sandbox linkage.
- [Conversation platform](./docs/conversation-platform.md): channel-neutral messages, episodes, versions, human control, SSE, and Matrix Application Service boundaries.
- [Channel Conversation Platform ADR](./docs/adr-channel-conversation-platform.md): source/transport separation, identity proof, Web/Stars entitlement, channel MVP, migration, and rollback decisions.
- [Delegation tasks](./docs/delegation-tasks.md): task aggregate, lifecycle, ownership validation, approvals, outputs, and audit linkage.
- [Delegation task product contract](./docs/delegation-task-product-contract.md): creation rules, visible lifecycle, owner actions, approval binding, completion, and the current P1 boundary.
- [Creator training loop](./docs/creator-training-loop.md): source registry, creator feedback, suggestion workflow, review, evaluation, and rollback.
- [Temporal-native workflow RFC](./docs/temporal-native-workflow-rfc.md): workflow state model, outbox, timer, cancellation, and dashboard semantics.
- [V2 isolated compute plane plan](./docs/v2-isolated-compute-plane-plan.md): compute and browser isolation model.
- [OpenViking integration](./docs/openviking-integration.md): public memory and recall integration.
- [Roadmap](./docs/roadmap.md): staged product and platform direction.
- [Gap analysis](./docs/gap-analysis.md): remaining product and architecture gaps.
- [Design system](./DESIGN.md): visual direction and implementation notes.

## Current Boundaries

Delegate can:

- answer from public representative knowledge
- collect structured intake
- offer paid continuation
- show web-first recharge/service-depth UI and invoice records
- show early Agent Wallet / recharge-entry state for a specific Digital Representative
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
