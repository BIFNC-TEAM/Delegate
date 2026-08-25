# Delegate Architecture Decisions

## Status

Directional architecture decisions captured on 2026-03-24 and reconciled with Agent Runtime V3 on 2026-08-21. The authoritative runtime protocol is [Agent Runtime V3](./agent-runtime-v3.md); this document retains broader product and stack tradeoffs.

## Core shift

Delegate is no longer aiming for "public bot with bounded workflows only." The target state is:

- a Telegram-native public representative plane
- a default-isolated compute plane backed by Docker or VMs
- a control plane for policy, billing, handoff, and audit
- a memory plane that separates public-safe context from transactional state

The product boundary still matters:

- the representative is public-facing
- compute must be isolated by default
- owner secrets and private workspace state must stay out of representative memory
- high-impact actions still require policy and approval

## One-line model

```text
Representative Plane -> Capability Gate -> Isolated Compute Plane -> Audit + Billing + Memory Filters
```

## Adopt / Reject / Replace / Later

| Area | Adopt | Reject | Replace with | Later |
| --- | --- | --- | --- | --- |
| Model access | OpenClaw-style provider abstraction, auth normalization, cooldown, and fallback | OpenClaw-style "support every possible auth path" sprawl in the public product path | OpenAI Responses API as the primary runtime; Anthropic as secondary for compute-heavy lanes | Add more providers only when a concrete owner segment needs them |
| Compute plane | OpenClaw's sandbox mindset and tool taxonomy | Host-first execution, optional sandboxing, `elevated`-style host escape hatches for representative traffic | Docker per session by default; stronger isolation with microVMs where needed | Capability marketplace across remote compute pools |
| Browser / computer use | OpenClaw's browser/node split and policy framing | A single generic browser wrapper as the only browser strategy | Dual browser stack: Playwright/CDP for deterministic flows, OpenAI/Anthropic native computer-use lanes for ambiguous UI tasks | Multi-browser pools and domain-specialized browser agents |
| Tool permissions | OpenClaw allow/deny matrices; Claude Code-style permission ergonomics | Prompt-only guardrails and coarse binary allowlists | A policy engine with `allow`, `ask`, `deny`, and org-managed defaults | Customer-specific policy packs and signed capability templates |
| Hooks / lifecycle | Claude Code hooks model | Pure after-the-fact logs | Interceptable lifecycle hooks around tool use, handoff, memory commit, and billing | Customer webhooks and programmable automations |
| Workflow orchestration | Session stickiness and failure-aware routing | One giant agent loop owning all business state | Postgres truth plus Temporal/Outbox durable waiting and signals | Localized subflows only behind the V3 Action/Result contract |
| Context and memory | OpenClaw continuity mindset; Claude prompt caching, context editing, and memory-tool principles | Mixing transcript, artifacts, and owner-private memory in one store | Postgres for truth, OpenViking for public-safe long-term context, artifact storage for raw outputs, ephemeral compute state for sandbox-local files | Memory promotion policies learned from owner feedback |
| Files and artifacts | Claude Files API product pattern | Storing large artifacts inside conversation transcript or long-term memory | Object storage + metadata + retention policies + summary extraction | Searchable artifact catalogs per representative |
| Capability transport | OpenClaw discovery thinking; Anthropic MCP direction | Arbitrary plugin code running inside representative runtime | Internal capability services plus remote MCP servers with explicit policy and provenance | External skill marketplace with signed trust tiers |
| Billing | OpenClaw usage visibility; Anthropic's separate compute-meter mindset | Treating token cost as the user-facing product price | Dual ledger: user credits/packs externally, model + compute + browser + storage cost internally | Dynamic margin-aware pricing and sponsor automation |
| Multi-agent | Scoped context/tool/budget boundaries | OpenClaw-style persona multiplication or a framework loop owning business truth | Goal-oriented TurnPlan V3 plus discriminated capability executors | A pi/other agent-core adapter only behind Skill/Compute execution contracts |

## Recommended stack

### 1. Representative plane

- Telegram gateway for private chat, mention/reply, and deep links
- public representative profile, knowledge pack, pricing, and handoff policy
- deterministic first-response workflows for FAQ, intake, quote, schedule, and paid unlock prompts

### 2. Compute plane

- sandbox-by-default capability runner
- `exec`, `read`, `write`, `process`, and `browser` provided through isolated sessions
- Docker per session to start
- microVMs for stronger isolation when owners need higher assurance

### 3. Browser stack

- Playwright/CDP lane for stable structured browser tasks
- native computer-use lane for fuzzy UI tasks
- isolated browser sessions with per-session cookies, downloads, and artifacts

### 4. Policy and approval plane

- `allow`: low-risk actions run automatically
- `ask`: sensitive actions require approval
- `deny`: forbidden actions never run
- managed org defaults that representatives cannot silently override

### 5. Workflow plane

- typed TypeScript workflow handlers for today's core product paths
- Temporal for retries, compensations, SLA windows, reminders, and asynchronous completion
- current durable workflows keep Postgres as truth while Temporal handles outbox-dispatched start, native timer waiting, retry, and cancellation cleanup for approval expiration and handoff follow-up
- model reasoning used for routing, summarization, and parameter filling, not as the only source of workflow truth
- one immutable TurnPlan V3 is the execution truth; Temporal history is never a second plan/state authority

### 6. Memory and state

- Postgres for contacts, conversations, invoices, handoffs, wallets, analytics, and policy decisions
- OpenViking for public-safe long-term context and representative patterns
- object storage for raw screenshots, logs, files, and generated outputs
- ephemeral sandbox state that is destroyed or retained under explicit policy

### 7. Capability transport

- internal capability services for first-party tools
- remote MCP servers for approved external capabilities
- provenance and trust tier metadata stored for every installed capability
- schema-pinned MCP definitions refreshed by a single-instance read-only catalog loop, plus live drift checks from the invocation handshake

### 8. Agent framework boundary

- Keep the Delegate V3 contracts as the top-level runtime.
- Do not replace Policy, Approval, Billing, Temporal, Artifact CAS, or Outbox with pi/OpenClaw/LangGraph state.
- A framework may be embedded later as a version-pinned Skill or isolated Compute executor; its output remains untrusted until Verified ActionResult validation.

## Claude-inspired decisions worth explicitly borrowing

### Permission ergonomics

Borrow from Claude Code:

- `allow / ask / deny`
- managed settings
- explicit directory and resource scope
- strong default-deny handling for sensitive paths and domains

Reference:

- <https://docs.anthropic.com/en/docs/claude-code/settings>
- <https://docs.anthropic.com/s/claude-code-security>
- <https://docs.anthropic.com/en/docs/claude-code/team>

### Hooks

Borrow from Claude Code hooks:

- pre-tool intercepts
- post-tool cleanup and summarization
- task/session completion hooks

Delegate should use these for:

- approval interception
- cost budget checks
- artifact retention decisions
- memory filtering
- owner-facing audit summaries

Reference:

- <https://code.claude.com/docs/en/hooks>

### Subagents

Borrow from Claude Code subagents:

- scoped context
- scoped tools
- scoped prompts
- scoped budgets

Delegate should apply this to:

- triage agent
- compute agent
- browser agent
- quote agent
- handoff summarizer

Reference:

- <https://docs.anthropic.com/en/docs/claude-code/sub-agents>

### Context management

Borrow from Claude API:

- prompt caching for stable representative prefixes
- context editing for pruning stale tool results
- fine-grained tool streaming for responsive live status
- memory-tool philosophy that long-term memory is not the same as transcript

References:

- <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- <https://platform.claude.com/docs/en/build-with-claude/context-editing>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>

### Compute as a first-class meter

Borrow from Anthropic's code-execution product design:

- compute is distinct from token generation
- files in and files out are first-class
- sessions and outputs have their own lifecycle

Delegate should mirror that idea with:

- compute-minute accounting
- browser-minute accounting
- artifact accounting
- user-facing compute-inclusive product packs

Reference:

- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool>

## What Delegate should explicitly not copy from OpenClaw

### Do not copy host-first execution

OpenClaw's runtime is powerful, but Delegate should not let representative traffic run directly on the owner's host machine. Representative-triggered compute must start inside a sandbox.

### Do not copy monolithic runtime ownership of business state

OpenClaw's agent loop is the heart of a private runtime. Delegate's business truth should remain in explicit workflow and database state, especially for billing, handoff, and priorities.

### Do not copy local-profile-centric secret handling as the product default

That pattern is reasonable for a personal assistant. It is not the right default for a public representative network.

### Do not copy arbitrary plugin execution inside the public runtime

Discovery and provenance are useful. Executable authority should live in isolated capability services instead.

## Implemented foundation and next build order

Implemented: structured `allow/ask/deny`, session-scoped Compute leases, Artifact storage, Temporal-backed durable workflows, deterministic/native browser lanes, lifecycle hooks, and Agent Runtime V3 planning/execution fences.

Next: collect lane-specific Shadow evidence, satisfy the executable release gates, add trusted Skill runtime adapters only when real package semantics exist, and expand server-owned SuccessContracts for third-party capabilities.

The phased implementation sequence that maps these decisions onto product delivery lives in [docs/roadmap.md](./roadmap.md).

The detailed engineering breakdown for `V2: Isolated Compute Plane` lives in [docs/v2-isolated-compute-plane-plan.md](./v2-isolated-compute-plane-plan.md).
The implemented planning and execution protocol lives in [docs/agent-runtime-v3.md](./agent-runtime-v3.md).

## Sources

- OpenClaw model providers: <https://docs.openclaw.ai/concepts/model-providers>
- OpenClaw failover: <https://docs.openclaw.ai/concepts/model-failover>
- OpenClaw tools: <https://docs.openclaw.ai/tools>
- OpenClaw sandboxing: <https://docs.openclaw.ai/gateway/sandboxing>
- OpenClaw usage tracking: <https://docs.openclaw.ai/concepts/usage-tracking>
- Anthropic MCP announcement: <https://www.anthropic.com/news/model-context-protocol>
- Anthropic agent capabilities announcement: <https://claude.com/blog/agent-capabilities-api>
- Claude computer use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- Claude code execution: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool>
- Claude files: <https://platform.claude.com/docs/en/build-with-claude/files>
- Claude prompt caching: <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Claude context editing: <https://platform.claude.com/docs/en/build-with-claude/context-editing>
- Claude fine-grained tool streaming: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming>
- Claude memory tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- Claude Code settings: <https://docs.anthropic.com/en/docs/claude-code/settings>
- Claude Code security: <https://docs.anthropic.com/s/claude-code-security>
- Claude Code team / IAM: <https://docs.anthropic.com/en/docs/claude-code/team>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code subagents: <https://docs.anthropic.com/en/docs/claude-code/sub-agents>
- Temporal docs: <https://docs.temporal.io/>
- Pi agent toolkit: <https://github.com/badlogic/pi-mono>
