<p align="center">
  <img src="./docs/assets/delegate-hero.png" alt="Delegate hero banner showing finance, legal, healthcare, and creator workflows" width="100%" />
</p>

<p align="center">
  <a href="./README.zh-CN.md"><img alt="中文" src="https://img.shields.io/badge/中文-111827?style=for-the-badge" /></a>
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-2563EB?style=for-the-badge" /></a>
</p>

# Delegate

Think of Delegate as an AI front desk.

When people reach you on the web today, and later through channels like Telegram, WhatsApp, or Feishu, Delegate lets your AI representative handle the first reception pass:

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
- **Owner dashboard** in `apps/web`, covering representative health, governed actions, compute sessions, artifacts, deliverables, packages, OpenViking traces, creator training, and workflow state.
- **Optional Telegram bot runtime foundation** in `apps/bot`, powered by grammY and shared runtime policy, kept as future channel infrastructure rather than the first Delegate product surface.
- **AMN wallet control plane** covering internal wallet ledger entries, mock recharge, Agent token purchase, usage charging, Creator 20% revenue policy, refund/reversal services, withdrawal request freezes, provider adapters, and owner/public wallet views.
- **Compute broker** in `apps/compute-broker`, providing governed `exec`, `read`, `write`, `process`, and `browser` requests behind approval and policy gates.
- **Workflow runner** in `apps/workflow-runner`, supporting the local runner and Temporal-backed durable workflow dispatch.
- **Prisma/Postgres data model** for representatives, contacts, conversations, handoffs, approvals, invoices, compute, artifacts, deliverables, workflows, and audit trails.
- **OpenViking integration** for representative-scoped public resources, recall, session commit traces, and safe memory previews.
- **ClawHub registry primitives** for future non-privileged representative skill packs.

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
  -> Users discover the Agent on the web first, then later on Telegram, WhatsApp, Feishu, WeCom, or an app
  -> Users recharge that specific Agent
  -> Agent serves the user
  -> Billing charges for tokens, tasks, or subscriptions
  -> Settlement calculates Creator revenue
  -> Ledger publishes transparent proof
```

The intended AMN layers are:

- **AMN Pay:** a future unified recharge entry that can be opened from any platform.
- **Billing Engine:** charges for token usage, completed tasks, subscriptions, or service packages.
- **Wallet Engine:** manages balances per Agent / Digital Representative.
- **Settlement Engine:** calculates Creator revenue, platform fees, provider costs, and withdrawals.
- **Transparent Ledger:** records recharge, charge, settlement, and proof events so users and creators can verify state.

What is implemented today is the web-first Delegate wedge plus the first AMN wallet loop: public representative pages, web chat, pricing tiers, public mock recharge, user cash balance, Agent token purchase, Agent token usage charging, Creator pending/withdrawable earnings, withdrawal request freezing, refund/reversal services, owner wallet dashboard, provider adapter boundaries, and durable follow-up workflows.

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
| Account types | Implemented | `USER_CASH`, `AGENT_TOKEN`, `CREATOR_PENDING`, `CREATOR_WITHDRAWABLE`, `PLATFORM_REVENUE`, and `PROVIDER_COST` are modeled in Prisma. Creator earning is split into pending and withdrawable accounts for safer release and withdrawal freezing. |
| Data models | Mostly implemented | `UserWallet`, `AgentWallet`, `WalletLedgerEntry`, `RechargeOrder`, `PaymentProviderEvent`, `AgentTokenPurchase`, `AgentUsageCharge`, `CreatorEarning`, and `WithdrawRequest` are implemented. There is no standalone generic `User` table yet; public users are represented by `UserWallet.externalUserId`. |
| Integer money and tokens | Implemented | Money uses integer smallest currency units such as CNY fen and USD cents. Agent tokens are integers. |
| User recharge | Implemented for mock flow | `RechargeOrder` creation, mock payment success, idempotent provider events, `UserWallet` credit, and wallet ledger entries are implemented. |
| User buys Agent tokens | Implemented | The service checks `UserWallet`, debits cash, credits `AgentWallet`, creates `AgentTokenPurchase`, creates Creator pending earnings at the policy share, and writes ledger entries. Current pricing uses per-Agent `tokenUnitPriceCents`; a central price catalog is still future work. |
| Agent consumes tokens | Implemented as a service | `AgentUsageCharge` debits Agent tokens, records provider cost and platform revenue, and releases Creator pending earnings into withdrawable balance. It is not yet wired into every live reply / compute / browser / MCP runtime path automatically. |
| Creator withdrawal | MVP implemented | `WithdrawRequest` checks verified owner, claimed representative, and withdrawable balance, then freezes funds with ledger entries. Automatic payout through Stripe Connect / Alipay / WeChat transfer is not implemented yet. |
| Refund and reversal | Partially implemented | Paid recharge refunds and unconsumed token purchase reversals are implemented with reversal ledger entries. Full chargeback automation and related balance freezing are still future work. |
| Payment reuse | Adapter boundary implemented | Mock provider is live. Stripe Checkout-style adapter is implemented through an injected client boundary. WeChat Pay and Alipay adapters are fail-closed skeletons requiring official SDK / OpenAPI callbacks and signature verification before use. Delegate does not handle card numbers, bank cards, payment passwords, or raw sensitive payment data. |
| First-version exclusions | Preserved | No automatic cross-border payout, Merkle proof, open Wallet API, unclaimed-representative auto-withdrawal, chain ledger, or multi-currency FX. |

Telegram remains future channel infrastructure for this product direction. If Delegate later ships bot-based digital goods and services, they should follow Telegram's rules, including Telegram Stars where required. AMN Pay is a future web/unified recharge path, not a reason to bypass platform policy.

## Architecture Principles

Delegate is built around a few hard boundaries:

- **Postgres is business truth.** Workflow, billing, handoff, approval, and dashboard state come from Postgres records.
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

- Node.js and pnpm
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
pnpm typecheck
pnpm test
pnpm build
```

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
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET` enable the optional Telegram bot foundation, but the first Delegate product version is web-first.
- `REP_PUBLIC_CHAT_SESSION_SECRET` can override the public-chat cookie signing secret. If unset, the reps app falls back to `TELEGRAM_WEBHOOK_SECRET` and then a local development secret.
- `DELEGATE_MODEL_ENABLED`, `DELEGATE_MODEL_PROVIDER`, `DELEGATE_OPENAI_MODEL`, and `DELEGATE_ANTHROPIC_MODEL` control model-backed representative replies.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ARK_API_KEY` enable live provider calls.
- `OPENVIKING_*` controls public memory sync, recall, and commit behavior.
- `COMPUTE_*` controls the broker, Docker runner, browser image, and native computer-use readiness.
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

pnpm docker:ps
pnpm docker:logs
pnpm docker:down

pnpm registry:search:clawhub "qualification"
```

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
