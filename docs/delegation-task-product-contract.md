# Delegation task product contract

This contract defines the owner-visible and audience-visible behavior of a delegated task. Runtime records such as a model run, compute session, approval, or workflow remain implementation details of the task.

## Task identity

- One accepted user outcome creates one task. Ordinary question answering does not create a task.
- An explicit `/compute` operation creates a task after parsing a concrete action. A bare `/compute` only opens usage guidance.
- Natural language creates a task only after the grounded planner has produced a concrete operation. Missing targets or inputs must be clarified rather than guessed.
- Re-execution remains an attempt of the same task. It must not silently create a second business task.
- Creation and every owner action are idempotent and scoped to one representative.

## Visible lifecycle

| Product state | Meaning | Next actor |
| --- | --- | --- |
| Clarifying | Required input is missing | Audience |
| Ready / queued | The accepted plan is waiting for the platform | System |
| Waiting for approval | A deterministic policy rule requires a decision | Owner |
| Running | At least one atomic operation is executing | System |
| Waiting for user | The plan requires new audience input | Audience |
| Waiting for owner | The task is paused for an owner decision other than a governed action approval | Owner |
| Completed | Acceptance criteria were met and final output was recorded | None |
| Failed | Execution ended without meeting acceptance criteria | None |
| Canceled | An authorized actor stopped the task or rejected its required action | None |
| Expired | A deadline or approval window elapsed | None |

Internal enum names may appear in audit data, but product surfaces use the meanings above.

## Plan and authorization

- The task detail shows the immutable requested outcome, current plan summary, ordered steps, capability, target, and captured resource limits.
- Approval is decided by deterministic capability policy. The model may propose an operation but cannot approve it.
- An approval records the matched rule, policy decision, risk explanation, request fingerprint, approver, decision note, and expiration.
- Approval applies only to the fingerprinted operation. A changed command, path, payload, external account, or capability requires a new policy evaluation and, when applicable, a new approval.
- Data grants and resource policy are captured at task creation. Later policy changes do not retroactively broaden an existing task.

## Owner actions

- **Cancel** is available before execution starts and while waiting for approval or input. Canceling a pending approval resolves it as rejected and preserves the evidence. An atomic running operation is not presented as cancelable until the broker can prove process termination.
- **Retry** is available for failed, canceled, or expired single-step Compute tasks. It creates a new generation attempt linked to the same task and re-evaluates current policy.
- **Continue** is available only when the task is explicitly waiting for the Owner. Waiting-for-user tasks require new audience input instead.
- Every accepted or rejected action appends a hash-linked task event. Invalid transitions return a conflict and do not partially mutate state.

## Completion and delivery

- A task is complete only after execution succeeds and at least one final output record exists. A summary output is valid when an operation intentionally produces no file.
- Files in `/workspace` are temporary execution state. An `Artifact` or `Deliverable` is the durable, downloadable result.
- The original conversation receives the final result. The owner task detail exposes outputs, external effects, cost, approvals, and the audit timeline.
- Failure, rejection, expiration, and cancellation remain visible; they are never rewritten as successful completion.

## Current P0 boundary

P0 supports one Compute, browser, or MCP step. The schema may describe multiple steps, but multi-step dependency scheduling, compensation, and user-supplied continuation inputs are not claimed until a workflow orchestrator enforces them.
