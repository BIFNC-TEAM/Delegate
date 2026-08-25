# Agent Runtime V3

This document is the source of truth for Delegate's conversation planning and
capability-execution runtime. It describes the target contract implemented by
the V3 rollout; older V2 documents remain useful for rollback and historical
compute-plane detail, but they are not the active protocol specification.

## Decision summary

- One immutable, server-validated `TurnPlan V3` is the execution truth.
- The model produces a non-authoritative `PlannerProposal`; it never grants
  permission, chooses billing, or marks work complete.
- Capability Definition and runtime Availability are separate. Health changes
  never mutate `definitionHash`.
- MCP, Compute, Knowledge, Builtin, and future Skill requests share compiler
  lifecycle rules while retaining discriminated executor payloads.
- Postgres is business truth. Temporal owns durable waiting, signal delivery,
  retry scheduling, and cancellation cleanup, not domain state.
- Tool transport success and business success are independent. A third-party
  capability without a server/Owner `SuccessContract` resolves to semantic
  `unknown`, never success.
- `response.compose` is a normal action in the DAG. It reads only Verified
  ActionResults and authorized evidence references.
- V2 remains available only for `disabled`/`shadow` rollback modes. An active
  V3 mode does not run the V2 planner or the legacy natural-language detailed
  planner.

## End-to-end flow

```text
Channel input
  -> normalize text, links, attachment metadata
  -> derive turn-scoped constraints (tool policy: auto/forbidden/required/conflict)
  -> identity/version/human-control/safety checks
  -> TurnEnvelope + authorized context + fixed CapabilityCatalog
  -> Capability Definition/Availability hard filter
  -> authorized Knowledge-manifest metadata probe + Candidate Snapshot
  -> one strict PlannerProposal
  -> server evidence escalation and materialization
  -> immutable Validated TurnPlan V3
       Goals
       Evidence requirements
       Action DAG + conditional activation
       Goal/Action failure policy
       Deliverables
  -> policy / approval / entitlement admission
  -> Capability Compiler Registry
  -> atomic Action execution admission
  -> Temporal/Outbox-driven recoverable execution
  -> transport result
  -> payload limits, schema validation, PII/secret redaction,
     prompt-injection marking, semantic success evaluation
  -> Verified ActionResult
  -> derived GoalOutcome
  -> response.compose with claim-level evidence bindings
  -> Message + DeliveryAttempt + provider acceptance
  -> billing settlement/release/hold under the product completion rule
```

The three candidate families are represented as goals and capabilities inside
one proposal rather than three independent Agent services:

- authorized knowledge retrieval;
- MCP/Compute/Builtin execution;
- stable general composition.

## V3.3 capability discovery and generic arbiter

Knowledge, MCP, Skill, Compute, and Builtin capabilities publish the same
immutable semantic dimensions: operations, evidence classes, freshness,
authority, open domains, and aliases. Definition semantics participate in the
definition hash; dynamic availability remains outside it.

For a small eligible catalog (32 capabilities or fewer), the Planner receives
the complete authorized, channel-compatible, non-unavailable set. Larger
catalogs use bounded hybrid retrieval over keys/tags, descriptions, semantic
domains/aliases, discovery sidecars, and input-schema field names/descriptions.
Low-confidence or byte-budget-truncated retrieval can produce only a control
clarification; it may not silently default to Knowledge or General. Definition,
Catalog, per-candidate projection, and aggregate Planner projection have fixed
byte budgets. The compact Candidate Snapshot binds the complete Envelope,
recent-turn query inputs, availability snapshot, filters, scoring/risk signals,
projection budget, and discovery hashes.

MCP descriptions and schema text are bounded untrusted discovery data kept
outside the immutable Definition. Raw sidecar text never enters the Planner
Prompt. An injection-screened summary of at most 2 KiB may enter the bounded
candidate projection solely to explain capability semantics and parameter
meaning; it is explicitly not instruction, evidence, authorization, policy, or
completion. Suspected prompt injection receives no discovery relevance credit
and is recorded in the Candidate Snapshot. Remote annotations never set Effect,
Approval, Idempotency, or Success semantics.

Before accepting the provider Proposal, the server derives a generic external
evidence signal from read/search/verification language, explicit resource
locators, and the immutable semantics of currently published capabilities. It
contains no repository-, vendor-, or industry-specific routing rule. When the
signal applies, General and Knowledge cannot substitute for the selected
authoritative capability. The server also normalizes internally inconsistent
provider fields monotonically: a selected Knowledge capability becomes a
Knowledge goal; any other selected capability becomes a Capability goal; and
evidence and operation can only be tightened to what that immutable capability
can actually satisfy. A source pointer is provenance, not Goal identity, so a
selection is never broadened to sibling Goals merely because both point at
`/currentMessage/text`. A read-only capability can never be normalized into a
create, mutate, or deliver permission.
When one message contains multiple `owner/repository` locators, the scalar
repository binder never chooses the first match. The Proposal must bind every
locator through an explicit grounded selection (for example, two read Actions)
or return a control clarification.
Installed Skills publish release-pinned definitions, but remain unavailable
until an explicit healthy runner publication exists.

Questions asking for a self-introduction, who the representative speaks for,
or what it can do use the builtin `representative.describe_self` Action. It
combines the published Owner/representative profile, relevant authorized
knowledge, and user-facing outcomes derived from the fixed Capability Catalog.
Its verified output also carries the server-owned human-confirmation state,
handoff access mode, published handoff prompt, and fixed governance statements;
the Composer never invents industry-specific approval boundaries.
The result enters composition as verified `capability_result` / `tool_output`
plus any authorized-knowledge evidence; internal capability keys are not a
user-facing self-description.

The Planner declares each Goal's operation, evidence, freshness, authority,
semantic confidence, and General eligibility in the single strict proposal.
The server does not add industry-specific keyword routing: it applies a
conservative, generic admission contract and rejects General unless the Goal is
stable answer/explain work, explicitly eligible, and above the confidence
floor. Strong evidence and side-effect requirements require explicit immutable
Capability semantics; an unclassified MCP/Compute executor cannot satisfy them
by type alone.

Planner evidence requirements use a discriminated strict schema: evidence-free
goals require exactly zero evidence, while authorized knowledge, capability
results, current external facts, and transactional authority require at least
one item. This prevents a provider from emitting internally contradictory
evidence fields that only fail after materialization.

The public representative Envelope explicitly sets
`planningDefaults.knowledgePolicy=prefer_authorized`, so the server first
inserts the Knowledge Action. A Goal-scoped `knowledge_preferred` fallback is
materialized only when the turn explicitly requests stable general/model
knowledge after a verified Knowledge miss and the server independently
classifies the complete Goal clause as non-Owner-specific. The Planner cannot
authorize this fallback itself and an explicit
`authorized_knowledge` requirement is never weakened. The metadata probe reads the same
pinned RepresentativeVersion and authorized public-knowledge manifest as the
real Action, but does not call OpenViking or create a UseRun. A verified `found`
result binds claims to knowledge. A verified `not_found` or `unavailable`
result may use stable general knowledge, but the server prepends a fixed
disclosure that the representative knowledge base was not applied. An explicit
turn-level tool prohibition still permits direct stable General. Owner-specific,
current, and transactional questions remain evidence-required and never use
this fallback.

“Non-Owner-specific” is a fail-closed server authority decision, not Planner
confidence. The default is `owner_authority_required`; fallback requires both
an explicit turn-level source instruction and a positive stable-general
explanation classification. Explicit Owner
subjects and implicit operational subjects such as opening hours, accepted
payments, or offered courses remain Owner-authoritative. Planner-provided
`generalEligibility` and confidence are necessary quality signals but never
grant source authority.

Each validated Goal carries a server-verified `sourceSpan` containing an exact
`/currentMessage/text` quote and UTF-16 start/end offsets. A single-Goal legacy
Proposal may adapt to the full message. Every non-control Goal in a multi-Goal
turn must provide its own exact range matching a complete server-derived clause;
missing, repeated/ambiguous, partial-clause, or invalid ranges fail closed.
Authority is classified per span, so “退款政策是什么，同时解释等温线”
keeps the policy Goal Owner-bound while allowing only the isotherm Goal to use
stable-general fallback.

`TurnConstraints` are normalized once at ingress and embedded in the
`TurnEnvelope`. They are scoped to the current input message and plan revision;
they are never inherited by the next turn. The Planner consumes this normalized
contract and does not re-parse control phrases. Server validation rejects a
forbidden turn containing non-composer capabilities and a required turn without
at least one published non-composer capability. Conflicting explicit instructions
produce a control goal and cannot execute tools.

## Authoritative contracts

### PlannerProposal versus Validated Plan

`PlannerProposal` is strict structured model output, bounded to 512 KiB and
stored separately for audit when it reaches server materialization. It may be
invalid. Proposal contract `turn-planner.v3.generic-arbiter.3` contains Goals,
operations, semantic confidence, General eligibility, evidence requirements,
capability selections, goal associations, and bounded argument candidates
only. The model does not own Action ids, provenance,
dependencies, activation, Composer, failure Actions, or Deliverables.

The server Action Materializer pins capability hashes and output schemas,
binds required arguments from trusted Envelope pointers, drops ungrounded
argument candidates, creates stable Action ids, attaches server-required
capabilities to every relevant Goal, creates exactly one `response.compose`,
computes its terminal-aware dependencies, creates the message Deliverable, and
then validates the complete DAG. Evidence requirements may only be strengthened.

`Validated TurnPlan V3` starts the immutable boundary. A required change creates
a new revision and atomically supersedes the prior execution epoch. It is never
edited in place.

### Capability Definition versus Availability

The immutable definition contains:

- key, version, executor, input/output JSON Schema;
- structured effect and idempotency contract;
- identity/data scopes and supported channels;
- optional server-owned `SuccessContract`;
- `definitionHash`;
- for MCP only, the separate published tool-schema hash and binding-definition
  hash.

Availability contains health, checked time, and runtime revision. Missing,
catalog-mismatched, or older-than-five-minute external availability fails
closed before planning. Compute Broker refreshes MCP `tools/list` immediately
at startup and every 120 seconds under a database advisory lock; one binding's
failure does not block the others. Planning pins the definition; execution
reads current availability and fails closed on drift.

For MCP, execution verifies three independent coordinates:

```text
Plan capabilityDefinitionHash == current Catalog definitionHash
compiled bindingRevision       == published binding revision
live schema hash               == published MCP tool schema hash
```

For a server-trusted MCP policy it additionally verifies the current endpoint,
transport, exact tool-schema hash, trust-policy ID, Effect revision, Effect
value, and SuccessContract. Any endpoint/schema/policy drift is
confirmed-not-sent and requires a replan before the remote call begins. The
trust coordinate intentionally excludes installation-local binding IDs and
config revisions, so a legitimate fresh installation remains portable.

The live hash is computed again from the `tools/list` response already
performed by the invocation handshake. The periodic catalog refresh is a
separate read-only publication/health loop; invocation does not add a second
per-call discovery request.

MCP annotations remain untrusted observations. Side-effect class, approval
ceiling, scopes, and success semantics come from a versioned platform/Owner
policy. A newly discovered MCP tool without that classification is published
as unavailable and cannot reach planning or approval; a versioned policy that
still says external-write/unknown is likewise unavailable. The server-owned
DeepWiki trust coordinate pins the HTTPS endpoint, transport, exact per-tool
Schema, policy ID, and Effect revision. Only that
coordinate receives `delegate.mcp-effect.deepwiki.v1` and external read-only;
a binding that merely renames itself `deepwiki` or exposes `ask_question`
remains unavailable. No remote annotation can widen the policy.

### Effects and approval ceilings

Effects are structured as boundary, mutation, and reversibility. Approval uses
a partial-order comparison, not enum/string ordering:

```text
internal read < internal write
external read < external reversible write < external irreversible write
internal write and external write are incomparable
external unknown write is never covered by an older approval
```

An Approval fixes the ActionIntent, request hash, capability definition, and
maximum effect. Approval does not revive an expired Compute Session. After
approval, the broker creates a fresh short-lived Session/Lease under current
policy and binds it back to the same Plan, Action, Approval, and Attempt.

### Action dependencies and fallback activation

Dependencies use explicit allowed status sets; there is no broad `terminal`
condition. External writes can only depend on success. Composer actions may
observe failure, partial, skipped, canceled, and reconciliation states.

Fallback actions are persisted but cannot run as ordinary primary steps. They
carry `on_failure`, source Action, allowed failure codes, fallback group, and
priority. A source success marks unused alternatives `SKIPPED`; a source failure
activates only a pre-planned alternative whose verified failure code matches.
Admission locks the fallback group and permits only the next eligible priority;
another queued/executing/succeeded/unknown member fences the whole group. If
the current alternative fails, the same lock admits the next remaining
priority; three or more alternatives therefore run serially without loops or
parallel claims.

## Atomic execution admission

No external call may begin until one transaction has locked and revalidated:

- active Plan fence, revision, and execution epoch;
- Action activation and dependencies;
- current policy, approval intent, and human-control state;
- entitlement/BillingAdmission;
- Capability Definition and current binding/schema coordinates.

The same transaction records:

- Action claim;
- ExecutionAttempt and execution lease;
- explicit `BillingAdmission`; the current conversation-owned execution lane
  accepts only `not_billable` because its entitlement is reserved by the
  GenerationRun. A future Action-owned lane must reserve and validate its
  `BillableUnit` in this same transaction before `reserved` is accepted;
- ExternalEffect with stable idempotency key when needed;
- `action.execution.requested` Outbox.

Immediately before an external call, ExternalEffect and Attempt move together
from prepared to call-started and bind the Attempt ID, lease-token hash, and
call-start time. A crash before call-start is confirmed-not-sent; a crash after
call-start, including a later local persistence exception, is outcome-unknown,
holds Effect/BillableUnit state for reconciliation, consumes the execution
Outbox without retry, and cannot be rewritten as confirmed failure. Neither
path silently retries an external mutation.

Builtin, Knowledge, managed-document, and Composer Actions use the same
Attempt/lease rule: the Worker must atomically mark `CALL_STARTED` with the
current Generation lease token before invoking a model, recall provider, or
artifact writer, and completion/failure uses the identical Attempt-then-scope
lock order and CAS fence.

## Result and evidence boundary

The executor's raw response is not a result contract. The verification pipeline
is:

```text
raw response
  -> byte/node/depth limits
  -> output JSON Schema
  -> secret/PII classification and redaction
  -> prompt-injection marking
  -> server-owned SuccessContract
  -> sanitized Artifact / Verified ActionResult
```

Text, file, and JSON artifacts pass the same secret-redaction boundary before
commit. Composer evidence ledgers store coordinates only, not duplicated content.

`ActionResult` records both transport and semantic outcomes. Published MCP
capabilities receive the versioned server evaluator
`mcp.generic_semantic@1`: protocol errors, `isError=true`, empty output, and
explicit failure text such as "Repository not found" cannot satisfy a Goal.
This evaluator is failure-only: a non-empty response with no recognized error
still remains `semantic=unknown`. Only an Owner/platform-pinned, purpose-built
`success_schema`, `status_predicate`, or versioned evaluator may declare
success; otherwise the result is held for explicit confirmation/reconciliation.
Approved V3 execution is never finalized directly from process exit code; the
approval-result reconciler reads the Verified ActionResult so transport success
cannot become business completion when semantics failed or remain unknown.
The server-owned DeepWiki read policy pins
`mcp.deepwiki.read_semantic@1`: it rejects known repository, permission,
authorization, rate-limit, timeout, overload, and 5xx failures. DeepWiki
currently exposes free-form text without a machine-verifiable business-success
field, so every other response remains semantic `unknown` until a trusted
wrapper supplies such a field; length or token density never proves success.

`GoalOutcome` is derived from ActionResults, deliverables, evidence policy, and
failure policy. It is not a second writable source of truth. A successful
planned fallback can recover its primary failure; unused alternatives are
skipped.

`response.compose` emits structured claim, inference, and status segments:

- knowledge claims reference the current authorized UseRun;
- tool claims reference current Verified ActionResults;
- transactional claims reference current authoritative results;
- stable-general claims are allowed only for a stable general goal;
- inference is explicitly labeled and references its sources.

Every claim, inference, and status carries a `goalId`. The server validates its
evidence class, allowed source kind, minimum evidence count, ActionResult
ownership, and GoalOutcome against that Goal. A failed/unknown tool result
cannot be rendered as success, and an evidence-bound Goal cannot be completed
by a status-only message. Legacy drafts without coordinates are adapted only
for an unambiguous single-Goal replay; multi-Goal ambiguity fails closed.
Knowledge fallback disclosure is rendered immediately before the first claim
of that fallback Goal. It is never prepended to the whole turn or attributed to
unrelated Knowledge/Tool Goals.

Before `response.compose`, GoalOutcome is projected from source Actions only;
the pending Composer and reply Deliverable are removed from that circular
projection. A pending source Goal blocks composition. On replay, a successful
Composer Attempt is revalidated against the pinned Plan, current verified
ActionResults, evidence ownership, fallback activations, and source
GoalOutcomes—not merely its output Schema. Plan completion repeats the same
semantic validation against final GoalOutcome; old ambiguous multi-Goal drafts
fail closed.

Unknown references reject the entire draft. Tool output is data, never
instruction.

## Durable execution and delivery

Temporal workflows wait for approval, clarification, handoff, cancellation, and
reconciliation signals without holding a conversation Worker. Activities always
re-read Postgres and use stable signal IDs. Workflow and message commands are
written through Outbox records in the same transaction as business state.

The following states are intentionally distinct:

```text
Plan completed
Action completed
Artifact committed
Message queued
Provider accepted
Billing settled/released/held
```

Plan completion means result-ready, not delivered. Delivery attempts carry the
composer Action coordinate plus the immutable Plan ID, revision, execution
epoch, Generation Outbox ID/attempt, and a per-attempt delivery lease token.
Before Matrix or Telegram is called, a separate atomic admission transaction
commits `CALL_STARTED`; the channel transaction then revalidates that exact
admission and the current `PlanExecutionFence` immediately beside the provider
call. Web performs the same fence before changing the Message to `SENT`.

Supersession cancels `QUEUED` and pre-call `PROCESSING/CALL_PREPARED`
deliveries and closes their Outbox. `CALL_STARTED` or response-pending
deliveries become `RECONCILIATION_REQUIRED/OUTCOME_UNKNOWN`; provider-accepted
evidence is retained, but neither case is automatically resent. Provider
acceptance, Message status, Generation Outbox completion, and Plan completion
remain separate facts.

Mixed plans are supported as one DAG: ready Knowledge/Builtin source Actions
commit Verified Results first, dependent MCP/Compute Actions then enter durable
execution, and the final Composer reads all source results. Inline failure
prevents dependent external admission; Knowledge miss plus tool success is
reported as tool-grounded, not as a hidden General fallback.

## Billing lifecycle

`BillableUnit` fixes product, pricing version, representative, payer,
entitlement account, quantity, purpose hash, and idempotency key. Its lifecycle
is:

```text
PENDING_RESERVATION -> RESERVED -> TRANSFERRED/SETTLEMENT_PENDING
  -> SETTLED
  -> RELEASED
  -> HELD_FOR_RECONCILIATION
```

Reservation transfer is allowed only when payer, entitlement account, product,
pricing version, and authorized purpose remain identical. Conversation-owned
free/service usage is recorded on individual Actions as explicit
`not_billable` admission rather than an absent billing decision. The current
V3 lane has exactly one commercial owner: `GenerationRun`. V3 Action Attempts
therefore never create `LedgerEntry` charges or expose a second Action bill;
the Broker fails closed if that explicit Generation-owned admission is missing.

## Rollout and rollback

`TURN_PLAN_V3_MODE` supports:

- `disabled`: V3 is off; V2 compatibility may run.
- `shadow`: V3 records comparison plans and never owns execution.
- `active_readonly`: only authorized knowledge and stable general composition
  are published.
- `active_governed`: managed document, typed Compute, and schema-pinned MCP
  lanes are published. Unsupported or unavailable Skill executors are omitted
  from the active catalog and fail closed.

Active V3 never runs the V2 planner. V2 code and persisted rows remain readable
for rollback; they do not become a second active write authority.

Rollout is lane-specific and evaluated by `evaluateV3ReleaseGate`. Hard safety
metrics (duplicate effects/settlement, silent tool fallback, unsupported live
claims, provider-unknown resend, stale-plan execution, policy bypass, unknown
composer evidence) must remain zero. A lane also requires at least 1,000 shadow
samples, seven consecutive passing days, strict-schema success of 99.5% or
better, validated plans of 99% or better, and the configured latency/cost budget.
Production additionally refuses to start an active mode unless deployment sets
`TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED=true`; that attestation is valid only after
the lane's release-gate review has passed.

## Skill and pi framework decision

Delegate keeps a Skill compiler request type, but it does not publish a Skill
as executable unless a trusted, version-pinned runtime adapter exists. Current
workspace Skill governance intentionally blocks third-party package code in the
public runtime; summaries/tags alone are not executable semantics.

The [pi monorepo](https://github.com/badlogic/pi-mono) provides useful agent-core,
multi-provider, tool, extension, session, and coding-agent primitives. It does
not replace Delegate's domain protocols: immutable Plan revisions, Postgres
truth, policy/approval ceilings, entitlement reservation, ExternalEffect
reconciliation, Temporal waits, Artifact CAS, or provider delivery acceptance.
Therefore pi is not introduced as the top-level Agent framework. It may be
evaluated later behind the existing `SkillExecutionRequest` or isolated Compute
adapter, where its output remains subject to the same admission and result
contracts.

## Reused foundations

- TurnEnvelope and existing conversation/version/channel fences;
- Postgres domain models and Temporal/Workflow Outboxes;
- Compute Broker Policy, approval, sandbox, MCP, and Artifact execution;
- OpenViking authorized recall and UseRun citations;
- Artifact CAS and provider-acceptance delivery;
- V2 rows, traces, and code as rollback/read compatibility.

## Not in scope

- three independent Agent services;
- moving business truth into Temporal history;
- allowing the model to decide permission, price, or billing;
- executing untrusted third-party Skill code;
- industry-label intent taxonomies;
- replacing the Compute Broker, Artifact store, or Outbox with pi or another
  conversational agent loop.

## Verification map

Key suites:

- `packages/runtime/tests/turn-planning-v3.test.ts`
- `packages/runtime/tests/capability-compilation.test.ts`
- `packages/runtime/tests/action-results.test.ts`
- `packages/runtime/tests/turn-outcomes.test.ts`
- `packages/runtime/tests/v3-release-gates.test.ts`
- `packages/model-runtime/tests/turn-planner-v3.test.ts`
- `packages/model-runtime/tests/turn-composer-v3.test.ts`
- `packages/web-data/tests/conversation-turn-plans.test.ts`
- `packages/web-data/tests/v3-inline-actions.test.ts`
- `packages/web-data/tests/managed-document-artifacts.test.ts`
- `packages/web-data/tests/delegation-task-actions.test.ts`
- `apps/compute-broker/tests/generation-work-fence.test.ts`
- `apps/compute-broker/tests/verified-action-results.test.ts`
- `apps/compute-broker/tests/mcp-tool-definitions.test.ts`
- `apps/compute-broker/tests/mcp-catalog-refresh.test.ts`
- `apps/compute-broker/tests/session-runtime-pin.test.ts`
- `apps/workflow-runner/tests/v3-reconciliation.test.ts`
- `apps/conversation-worker/tests/processor.test.ts`
