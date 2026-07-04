# Temporal-Native Durable Workflow Refactor RFC

## Status

Draft as of 2026-03-29.

This RFC is based on:

- the current Delegate codebase
- the current Temporal TypeScript SDK APIs and docs
- the existing product rule that business truth lives in Postgres, not in a long-running agent loop or Temporal history

## Why This RFC Exists

Delegate already has a real durable workflow backbone:

- approval expiration workflows are created in `apps/compute-broker/src/approvals.ts`
- owner handoff follow-up workflows are created in `apps/bot/src/runtime-store.ts`
- workflow truth is persisted in `WorkflowRun`
- a local runner processes due jobs
- a Temporal bridge and worker entrypoint already exist in `apps/workflow-runner/src/temporal-bridge.ts` and `apps/workflow-runner/src/temporal/workflows.ts`

Temporal-native waiting from creation time is implemented for the timer workflow kinds, and the same outbox/runner boundary now also supports creator training review.

Today, the Temporal path is:

1. write `WorkflowRun` and `WorkflowCommandOutbox(START)` in the same committed Postgres flow
2. let the workflow runner dispatch the START command after commit
3. start the Temporal workflow immediately using `externalWorkflowId` as the idempotency key
4. pass `scheduledAt` into the workflow input
5. have the workflow sleep durably until `scheduledAt`
6. run a DB-backed idempotent activity that reuses the existing business logic

That means Delegate is now using Temporal as the owner of durable waiting, timer wake-up, and post-restart resume for approval expiration and handoff follow-up.

This RFC remains the design record for that gradual refactor and the next steps, without moving product truth out of Postgres.

## Current Repo Truth

### Product-visible workflows

The current product already exposes workflow-backed behavior in a few places:

- approval requests can expire automatically
- handoff requests can trigger timed owner follow-up reminders
- the owner dashboard shows workflow engine configuration, phase-aware workflow metrics, failed workflow count, and recent workflow rows
- the compute dashboard has a separate "stale approval workflow" heuristic for pending approvals

Relevant code:

- `apps/compute-broker/src/approvals.ts`
- `apps/bot/src/runtime-store.ts`
- `apps/workflow-runner/src/runner.ts`
- `packages/web-data/src/owner-dashboard.ts`
- `packages/web-data/src/compute.ts`

### Durable workflows actually implemented today

There are currently three real durable workflow kinds in the schema:

- `APPROVAL_EXPIRATION`
- `HANDOFF_FOLLOW_UP`
- `CREATOR_TRAINING_REVIEW`

See `prisma/schema.prisma`.

### Current Temporal integration

The current Temporal bridge is real and owns create-time durable waiting:

- the worker boots successfully when the Temporal profile is configured
- the bridge dispatches START and CANCEL commands from `WorkflowCommandOutbox`
- the bridge starts `runDelegateWorkflowRun` with explicit `workflowRunId` and `scheduledAt` input
- the workflow sleeps until `scheduledAt` and then calls a single activity
- the activity delegates back into `processWorkflowRunById`, which re-checks Postgres truth

Relevant code:

- `apps/workflow-runner/src/temporal-bridge.ts`
- `apps/workflow-runner/src/temporal/workflows.ts`
- `apps/workflow-runner/src/temporal/activities.ts`

### Current cancellation behavior

Manual resolution now cancels the Postgres business workflow first and delivers Temporal cancellation as cleanup.

Today, approval resolution and handoff resolution:

- resolve the approval or handoff business row in Postgres
- mark matching active `WorkflowRun` rows `CANCELED`
- set `enginePhase = CANCEL_REQUESTED` when a Temporal execution may exist
- write `WorkflowCommandOutbox(CANCEL)` in the same transaction
- let the dispatcher call Temporal `WorkflowHandle.cancel()`
- keep activities safe if a workflow wakes after manual resolution

Relevant code:

- `apps/compute-broker/src/executions.ts`
- `packages/web-data/src/owner-dashboard.ts`

## Goals

1. Use Temporal as the durable waiting engine for long-lived business timers.
2. Keep Postgres as the source of product truth for dashboard, audit, billing, and operator state.
3. Preserve the current `WorkflowRun` table as the main business-facing workflow record.
4. Migrate the existing durable workflow kinds incrementally, keeping Postgres as product truth.
5. Keep `LOCAL_RUNNER` as a fallback and local development mode.
6. Improve correctness around start idempotency, cancellation, retries, and observability.

## Non-Goals

1. Do not move approval, handoff, billing, or inbox truth into Temporal history.
2. Do not migrate the general bot runtime, FAQ routing, or normal chat replies into Temporal.
3. Do not require every workflow to surface raw Temporal internals in the owner UI.
4. Do not depend on activity heartbeats as the main correctness mechanism for these timer workflows.
5. Do not remove the local runner in the first migration.

## Temporal Constraints That Matter Here

This RFC relies on a few Temporal rules from the official TypeScript SDK:

- Workflow IDs are unique and are a valid idempotency key for business-level workflow start.
- Starting a workflow with the same ID as an already running workflow creates a conflict unless conflict handling is specified.
- `sleep()` inside a workflow is the canonical durable timer mechanism.
- `startDelay` also exists, but this RFC standardizes on workflow-level `sleep()` because Delegate wants an active execution that can later support richer cancel/query/signal behavior.
- Workflow cancellation is explicit from the client side via a workflow handle.
- Activity cancellation is not the main safety mechanism here because activities only reliably observe cancellation when they heartbeat or are local activities.

Official references:

- Workflow APIs: <https://typescript.temporal.io/api/namespaces/workflow>
- Workflow options: <https://typescript.temporal.io/api/interfaces/client.WorkflowOptions>
- Workflow handle APIs: <https://typescript.temporal.io/api/interfaces/client.WorkflowHandle>
- Activity APIs: <https://typescript.temporal.io/api/namespaces/activity>

## Design Principles

### 1. Postgres remains business truth

`WorkflowRun` is the operator-facing durable truth.

Temporal is responsible for:

- durable waiting
- wake-up after restarts
- activity retry
- multi-worker reliability
- workflow cancellation delivery

Temporal is not the authoritative source for:

- whether an approval is still pending
- whether a handoff is still open
- whether a workflow should still mutate business state

Those answers stay in Postgres.

### 2. Activities must stay DB-idempotent

The approval-expire and handoff-follow-up activities must continue to re-read the latest Postgres state before mutating anything.

That is required because:

- cancel requests are best-effort cleanup, not the source of truth
- a workflow can wake up after a manual resolution already happened
- Temporal retry may re-run an activity after a partial failure

### 3. Start and cancel must be post-commit, not in-transaction network calls

A workflow start or cancel request to Temporal should never be the only place where state exists.

If business truth is written in Postgres, the Temporal command must be driven from Postgres after commit using an idempotent dispatch mechanism.

## Proposed Architecture

### Overview

```text
Business transaction
  -> write business truth
  -> write WorkflowRun
  -> write WorkflowCommandOutbox(START or CANCEL)

Dispatcher / reconciler
  -> reads outbox
  -> starts or cancels Temporal workflow idempotently
  -> updates WorkflowRun engine metadata

Temporal workflow
  -> waits durably until scheduledAt
  -> runs kind-specific activity
  -> activity re-checks Postgres
  -> activity updates terminal WorkflowRun state
```

### Recommended Temporal workflow shape

For each durable workflow kind, use a native Temporal workflow:

- `ApprovalExpirationWorkflow`
- `HandoffFollowUpWorkflow`

Each workflow should:

1. receive `workflowRunId`
2. load minimal input from the DB or activity boundary
3. compute `msUntilScheduledAt`
4. `sleep(msUntilScheduledAt)` if needed
5. call one kind-specific activity

Each activity should:

1. load the latest `WorkflowRun`
2. load the latest approval or handoff row
3. no-op safely if Postgres already says the business object is resolved
4. apply the existing business mutation and audit write
5. mark the `WorkflowRun` terminal

## State Model

The current `WorkflowRun.status` field is too coarse for a create-now, wake-later Temporal lifecycle unless we make its meaning explicit and add a second axis for engine state.

### Proposed model

Keep `WorkflowRun.status` as the product-facing lifecycle field and add `enginePhase` as the orchestration-facing phase field.

#### Product-facing status

Keep the existing enum values, but clarify the semantics:

- `QUEUED`: the row exists in Postgres, but engine execution has not yet been confirmed
- `RUNNING`: the workflow execution exists in the engine and is active; for Temporal this includes durable timer waiting, retry backoff, and activity execution
- `COMPLETED`: the workflow successfully reached its intended terminal outcome
- `FAILED`: the workflow failed and needs operator or retry handling
- `CANCELED`: business truth says this workflow should no longer run

This is the most gradual change because it keeps the main enum but stops pretending that "waiting durably in Temporal" is still a queue state.

#### Engine phase

Add a new enum or explicit string field such as:

- `DISPATCH_PENDING`
- `WAITING_TIMER`
- `ACTIVITY_RUNNING`
- `RETRY_BACKOFF`
- `CANCEL_REQUESTED`
- `COMPLETED`
- `FAILED`
- `CANCELED`

`status` answers "what is the workflow's authoritative lifecycle state for the product?"

`enginePhase` answers "what is the orchestration layer currently doing?"

### Why two axes are necessary

Without `enginePhase`, the system has no clean way to represent this common Temporal-native state:

- business workflow is still active
- Postgres row should remain live in dashboards
- Temporal execution already exists
- the workflow is only waiting on a timer

That is not truly `QUEUED`, but it also should not force the owner UI to guess from raw Temporal history.

### Recommended new `WorkflowRun` fields

The existing fields already cover part of the story:

- `queueName`
- `externalWorkflowId`
- `scheduledAt`
- `startedAt`
- `completedAt`
- `failedAt`
- `lastError`
- `attemptCount`

Add fields that are directly useful for state, drift repair, and UI:

- `externalRunId String?`
- `enginePhase WorkflowEnginePhase`
- `nextWakeAt DateTime?`
- `dispatchAttemptCount Int @default(0)`
- `cancelRequestedAt DateTime?`
- `lastObservedAt DateTime?`
- `lastEngineError String?`

Recommended semantics:

- `attemptCount`: business activity attempts, not dispatcher retries
- `dispatchAttemptCount`: Temporal start or cancel dispatch retries
- `nextWakeAt`: expected wake time for timer wait or retry backoff
- `lastObservedAt`: last successful reconciliation with Temporal or local runner

### Explicitly not recommended

Do not add `lastHeartbeat` as a primary workflow field for this RFC.

Reason:

- heartbeats are activity-level, not workflow-level
- the approval and handoff workflows are timer-heavy and activity-light
- the activities are short DB operations, so heartbeat is not the right main observability primitive

If future long-running activities need heartbeats, expose that on compute-style operational surfaces, not as the main owner workflow list field.

## Dual-Write Consistency

### Problem

If Delegate writes Postgres and starts Temporal in the request path without a post-commit handoff strategy, it creates drift risk:

- Postgres row committed, Temporal start never happened
- Temporal workflow started, request crashed before Postgres metadata was updated
- duplicate starts after retries
- manual cancel races with initial start

### Proposal: DB outbox for workflow commands

Add a small outbox table, for example `WorkflowCommandOutbox`, with rows like:

- `workflowRunId`
- `commandType` = `START` or `CANCEL`
- `payload`
- `attemptCount`
- `availableAt`
- `processedAt`
- `lastError`

This outbox must be written in the same Postgres transaction as the business mutation and the `WorkflowRun` row change.

### Start path

1. Business transaction creates the approval or handoff state.
2. The same transaction creates `WorkflowRun` with:
   - `engine = TEMPORAL`
   - `status = QUEUED`
   - `enginePhase = DISPATCH_PENDING`
   - `scheduledAt`
   - `externalWorkflowId`
3. The same transaction writes `WorkflowCommandOutbox(START)`.
4. A dispatcher reads the outbox after commit and first re-checks the latest `WorkflowRun` row.
5. The dispatcher starts the workflow using `externalWorkflowId` as the business idempotency key.
6. On success, or on "already started" conflict that matches the same business workflow, the dispatcher updates:
   - `status = RUNNING`
   - `enginePhase = WAITING_TIMER`
   - `externalRunId`
   - `startedAt`
   - `nextWakeAt = scheduledAt`
   - `lastObservedAt`
7. The dispatcher marks the outbox row processed.

### Idempotency requirement

`externalWorkflowId` must be stable and business-meaningful.

This is the id used to make Temporal start idempotent.

The dispatcher should treat:

- start success
- "already started" on the same business workflow

as equivalent success paths, then call `describe()` or a handle-based lookup to populate `externalRunId` and repair metadata.

### Cancel path

1. Manual approval resolution or handoff closure updates business truth first.
2. The same transaction updates `WorkflowRun` to `CANCELED`.
3. If a Temporal execution may already exist, the same transaction also sets:
   - `enginePhase = CANCEL_REQUESTED`
   - `cancelRequestedAt`
4. If no Temporal execution has been confirmed yet, the row can move directly to:
   - `enginePhase = CANCELED`
5. If a Temporal execution may exist, the same transaction writes `WorkflowCommandOutbox(CANCEL)`.
6. The cancel dispatcher calls `WorkflowHandle.cancel()`.
7. On successful cancel delivery, or if the workflow is already closed or missing, the dispatcher marks cancel cleanup complete and updates:
   - `enginePhase = CANCELED`
   - `lastObservedAt`

### Why Postgres can mark cancel before Temporal confirms

Because Postgres is authoritative for business truth.

Once the approval is no longer pending or the handoff is no longer open, the product truth is already "this workflow should not act anymore."

Temporal cancel is then cleanup and resource reclamation, not the authoritative business decision.

## Cancellation Semantics

### Product rule

Manual resolution wins immediately.

Examples:

- owner approves or rejects an approval request
- owner accepts, declines, or closes a handoff

As soon as Postgres says the subject is resolved, the workflow must become semantically inactive.

### Engine rule

Temporal cancellation is best-effort and should happen, but correctness cannot depend on it arriving in time.

### Activity rule

Every activity must re-check Postgres before mutating business state.

That means these cases are safe:

- workflow woke up after the approval was already resolved
- cancel command was delayed
- Temporal retry re-ran the activity
- worker restarted mid-flight

### Future long-running activity rule

If Delegate later introduces longer activities, then those activities should opt into Temporal cancellation properly:

- use heartbeat where appropriate
- pass the Temporal activity cancellation signal into abortable libraries

That is not required for the current short DB-centric activities.

## Dashboard and API Surface

The current owner dashboard mostly exposes:

- configured engine
- effective engine
- queue name
- queued count
- failed count
- recent workflows

That is not enough once Temporal workflows are created immediately and then sleep durably.

### Replace "Queued workflows" with richer pending-state metrics

Recommended metrics:

- `pendingWorkflows`: `status IN (QUEUED, RUNNING)`
- `dispatchPendingWorkflows`: `enginePhase = DISPATCH_PENDING`
- `waitingTimerWorkflows`: `enginePhase = WAITING_TIMER`
- `retryBackoffWorkflows`: `enginePhase = RETRY_BACKOFF`
- `cancelRequestedWorkflows`: `enginePhase = CANCEL_REQUESTED`
- `failedWorkflows`: `status = FAILED`

This avoids the current semantic trap where "queued" is overloaded as both "not started yet" and "still pending overall."

### Recommended per-workflow fields

Expose these in dashboard data and APIs:

- `id`
- `kind`
- `engine`
- `status`
- `enginePhase`
- `scheduledAt`
- `nextWakeAt`
- `startedAt`
- `completedAt`
- `failedAt`
- `externalWorkflowId`
- `externalRunId`
- `queueName`
- `attemptCount`
- `dispatchAttemptCount`
- `lastError`
- `lastEngineError`
- `cancelRequestedAt`

### Recommended workflow detail copy

For owner-facing lists, prefer phase-aware descriptions such as:

- `dispatch_pending`
- `waiting_until_scheduled_time`
- `running_expiration_check`
- `running_handoff_follow_up`
- `retrying_after_failure`
- `cancel_requested`
- `completed`
- `failed`

Do not rely only on free-form `detail` text when the state is queryable.

### Temporal metadata in UI

The workflow detail panel can optionally show:

- Temporal workflow ID
- Temporal run ID
- namespace
- task queue

This is useful for operators and debugging, but it should remain secondary to the Postgres truth shown in the dashboard.

### Compute-specific stale workflow heuristic

Keep the compute dashboard's existing "stale approval workflow" heuristic separate from the owner workflow overview.

That heuristic is approval-specific operational logic, not the generic workflow status model.

## Recommended Migration Plan

### Phase 0: Documentation and terminology cleanup

- landed this RFC
- updated stale docs that claimed Temporal was absent
- clarified in docs that Delegate has a Temporal bridge, outbox dispatch, native durable timers, cancellation cleanup, and creator training review workflow support

### Phase 1: Outbox-backed Temporal start

- done: added `WorkflowCommandOutbox`
- done: added `enginePhase` and minimal Temporal metadata fields
- done: write `START` commands in the same transaction as `WorkflowRun` creation
- done: keep local runner unchanged
- done: repurpose the Temporal runner loop into a dispatcher/reconciler, not a timer scheduler

### Phase 2: Native waiting in Temporal

- done: Temporal workflows start at creation time after outbox dispatch
- done: workflow input includes `scheduledAt`
- done: workflow uses `sleep()` until `scheduledAt`
- done: "waiting until due" moved out of the local timer poller for Temporal mode
- done: activities remain DB-idempotent and no-op after cancellation

### Phase 3: Cancellation correctness and observability

- done: add outbox-backed `CANCEL`
- done: call Temporal `cancel()` for active workflows from the dispatcher
- done: expose new dashboard fields and phase-based metrics
- remaining: add deeper reconciliation for missing `externalRunId`, stale `DISPATCH_PENDING`, and stuck cancel requests

### Phase 4: Native per-kind workflows

- split `runDelegateWorkflowRun` into explicit kind-specific workflows
- keep shared helper code where useful
- configure per-kind retry and timeout policies instead of using one generic wrapper for everything

### Phase 5: Expand to new long-running product workflows

After the existing workflows are stable, consider additional Temporal-native candidates such as:

- quote follow-up
- scheduling reminders
- payment recovery
- deliverable delivery follow-ups

Do not migrate ordinary real-time chat routing.

## Testing Strategy

Prioritize correctness under timing and failure, not only happy-path completion.

Required test cases:

1. start command written exactly once with workflow creation
2. duplicate start dispatch is idempotent
3. manual resolution before Temporal start results in no-op start dispatch
4. manual resolution after Temporal start sends cancel and still no-ops safely if cancel is delayed
5. workflow survives worker restart while waiting on timer
6. activity retry does not duplicate business mutation
7. stale `DISPATCH_PENDING` rows are reconciled
8. stuck `CANCEL_REQUESTED` rows are reconciled
9. dashboard metrics count `RUNNING + WAITING_TIMER` workflows correctly
10. local runner behavior still works when `effectiveEngine = local_runner`

## Risks

### 1. Misleading status if dashboard keeps old semantics

If the UI continues to treat only `QUEUED` as "pending workflow," it will undercount active Temporal-native workflows that are sleeping in the engine.

### 2. Start drift without outbox or reconciliation

Starting Temporal directly from request handlers will eventually produce inconsistent state under retries, crashes, or network errors.

### 3. Over-trusting Temporal cancellation

If later code assumes "cancel was requested, therefore no activity can run," it will reintroduce correctness bugs.

The DB re-check remains mandatory.

### 4. Conflating workflow and activity observability

Heartbeat is useful for long activities, but it is not the right core field for timer workflows.

## Open Questions

1. Whether to implement `enginePhase` as a Prisma enum or a constrained string field first.
2. Whether `attemptCount` should be backfilled to mean "activity attempts" and a new `dispatchAttemptCount` should track dispatcher retries from day one.
3. Whether to persist Temporal namespace per row or keep it as environment-level config plus current queue name.
4. Whether to standardize `externalWorkflowId` generation on stable IDs only instead of mixing representative slug and representative ID across creation sites.

## Decision Summary

The correct refactor is not "move workflow truth into Temporal."

The correct refactor is:

- keep Postgres as the workflow business record
- add a post-commit command outbox
- start Temporal workflows immediately when the row is created
- wait durably in Temporal with workflow timers
- keep activities idempotent and DB-truth-aware
- treat Temporal cancel as cleanup, not authority
- evolve dashboard semantics from "queued rows" to "active workflow state + engine phase"
