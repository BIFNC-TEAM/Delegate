# Delegate Roadmap

This roadmap reflects three truths at once:

- Delegate is web-first today and must preserve that working wedge.
- Web, Matrix, and Telegram should converge on one business runtime without making Matrix a mandatory Telegram dependency.
- Delegate is now targeting an isolated compute plane behind that public interface, not just bounded FAQ workflows.

The sequence below is ordered to protect identity, entitlement, and delivery correctness first, then add channels and general compute without collapsing the trust boundary. Channel decisions are fixed in [the Unified Conversation Platform ADR](./adr-channel-conversation-platform.md).

## V1: Public Representative Core

Goal: prove that a stranger can understand the representative in 10 seconds and get value in one Web chat session.

Build:

- one representative
- private chat entry
- public representative page
- FAQ answering
- material delivery
- free usage contract
- `Pass` purchase trigger
- owner inbox for human handoff
- OpenViking-backed public-safe memory

Success:

- owner can publish in 15 minutes
- most common inbound questions are handled without the owner
- first paid unlock happens without custom explanation
- memory improves replies without leaking owner-private context

## V1.5: Conversation Platform Hardening

Goal: make identity, entitlement, policy, and delivery safe before expanding messaging channels.

Build:

- explicit `sourceProvider`, `transport`, and interaction mode
- typed channel desired state and observed health
- one availability gate across inbound acceptance, generation, and outbound delivery
- verified, short-lived, single-use provider identity links to `AudienceIdentity`
- audience-and-representative-scoped service entitlement with append-only ledger
- Web checkout and Telegram Stars as separate provider rails with original-rail refunds
- atomic balance checks, provider-event idempotency, retry, and dead letter
- restartable backfill and reconciliation for legacy Web and Telegram data

Success:

- one audience member cannot consume another member's entitlement
- repeated provider events do not duplicate messages, replies, balance, or usage
- paused, unpublished, or human-controlled conversations never start AI generation
- identity conflicts fail closed and retain a complete audit trail

## V1.75: Native Matrix and Thin Telegram Adapters

Goal: make native Matrix and Telegram private chat use the same Conversation Platform without duplicating business behavior.

Build:

- native, unencrypted Matrix direct-room provisioning and membership validation
- durable Matrix transaction ingestion with asynchronous processing, retry, quarantine, and dead letter
- grammY reduced to a Telegram-specific edge for Bot API, commands, callbacks, deep links, Stars, and support
- shared message acceptance, pinned-version generation, policy, handoff, entitlement, and outbox delivery
- provider origin IDs, edit/redaction authorization, and bridge-loop prevention
- per-representative adapter ownership and rollback controls

Success:

- each provider event creates at most one business message and one generation
- unknown Matrix rooms are provisioned or quarantined instead of silently discarded
- adapter restarts and provider retries do not produce duplicate replies
- direct Telegram remains recoverable throughout migration

## V1.9: Optional Telegram-to-Matrix Canary

Goal: determine whether Matrix transport provides measurable operating value without making it part of the product identity or business truth.

Build:

- one managed test bot, private chat, plain text, and no encryption
- explicit Telegram source identity carried through Matrix transport metadata
- portal mapping, origin idempotency, echo/history suppression, and high-water marks
- per-representative feature flag, health split by source and transport, and direct Telegram fallback
- delivery, latency, loss, loop, and operator-workflow measurements

Success:

- no message loss, duplicate generation, loop, or identity drift under retries and restarts
- failure can be rolled back without regenerating completed replies
- the bridge is adopted only if its measured value exceeds its availability and operations cost

## V2: Isolated Compute Plane

Goal: let representatives safely use general compute without turning the public product into a host-level assistant.

Build:

- capability gate with `allow / ask / deny`
- session-scoped compute leases
- Docker-per-session sandbox for `exec / read / write / process`
- artifact storage for logs, files, screenshots, and outputs
- dual ledger accounting for model + compute + browser cost
- audit trail for all compute actions

Success:

- representatives can complete scoped general-compute tasks without host access
- owners can see what ran, why it ran, what it cost, and what files were produced
- sensitive actions are intercepted instead of silently executed

Implementation detail: [docs/v2-isolated-compute-plane-plan.md](./v2-isolated-compute-plane-plan.md)

## V2.5: Browser and Native Computer Use

Goal: add browser execution as a governed product surface instead of a generic automation hack.

Build:

- deterministic browser lane with Playwright/CDP
- native computer-use lane for ambiguous UI tasks
- isolated browser sessions with per-session cookies and download scope
- domain and action policy controls
- approval flow for destructive or authenticated actions

Success:

- representative can complete browser-heavy tasks with visible safety boundaries
- owner can approve risky actions before execution
- browser artifacts are searchable and auditable

## V3: Durable Workflows and Capability Network

Goal: move from isolated tasks to reliable multi-step service delivery.

Build:

- Temporal-backed long-running workflows
- retries, compensations, SLA timers, and follow-up automations
- current foundation: approval expiration and handoff follow-up now use Postgres truth, outbox-dispatched Temporal start/cancel, native timer waiting, and phase-aware dashboard observability
- capability services and remote MCP servers
- signed trust tiers and provenance for installed capabilities
- scoped subagents for triage, browser, compute, and handoff

Success:

- long-running tasks survive restarts and partial failures
- capability execution is composable without arbitrary plugin code in the representative runtime
- multiple specialized agents can cooperate without sharing unlimited context or tools

## V4: Optimization and Network Layer

Goal: improve conversion, trust, and operating leverage while preparing for a broader agent network.

Build:

- FAQ gap analytics
- source-level conversion analysis
- compute and browser margin analytics
- richer intake templates by representative type
- source-versus-transport reliability analytics
- carefully scoped Telegram group and media experiments after participant and entitlement semantics are approved
- memory promotion policies based on owner feedback
- cross-representative capability graph and marketplace experiments

Success:

- more paid continuations per inbound contact
- fewer low-value manual handoffs
- clearer operating playbook for each representative template
- viable path from public representative product to broader capability network

## Channel migration exclusions

The first migration does not include:

- WhatsApp, WeChat, Feishu, or WeCom;
- Matrix E2EE or an encrypted Telegram bridge;
- group billing, ambient group listening, or automatic payer/beneficiary inference;
- media parity, reactions, typing, read receipts, or history import;
- full puppeting, multiple owner bots, or multiple homeservers;
- automatic identity matching by username, display name, email-like text, or room membership;
- automatic merging of raw Web, Matrix, and Telegram timelines;
- conversion between XTR and Web currencies;
- removal of direct Telegram fallback before the canary and reconciliation windows close.
