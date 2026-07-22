# Delegation task product contract

This contract defines the owner-visible and audience-visible behavior of a delegated task. Runtime records such as a model run, compute session, approval, or workflow remain implementation details of the task.

## Task identity

- One accepted user outcome creates one task. Ordinary question answering does not create a task.
- An explicit `/compute` operation creates a task after parsing a concrete action. A bare `/compute` only opens usage guidance.
- Natural language creates a task only after the grounded planner has produced a concrete operation. Missing business inputs must be clarified rather than guessed; generated-document file locations are platform-managed and are never requested from a public visitor.
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
- Data grants and resource policy are captured when their inputs enter the task. Owner-authorized public Knowledge Assets are recorded individually; later policy changes do not retroactively broaden an existing task.

## Owner actions

- **Cancel** is available before execution starts and while waiting for approval or input. Canceling a pending approval resolves it as rejected and preserves the evidence. An atomic running operation is not presented as cancelable until the broker can prove process termination.
- **Retry** is available for failed, canceled, or expired single-step Compute tasks. It creates a new generation attempt linked to the same task and re-evaluates current policy.
- **Continue** is available only when the task is explicitly waiting for the Owner. Waiting-for-user tasks require new audience input instead.
- Every accepted or rejected action appends a hash-linked task event. Invalid transitions return a conflict and do not partially mutate state.

## Completion and delivery

- A task is complete only after execution succeeds and at least one final output record exists. A summary output is valid when an operation intentionally produces no file.
- Files in `/workspace` are temporary execution state. Public conversation messages never expose sandbox paths, object keys, raw execution errors, or generated file contents; they show a safe attachment name and download action instead. An `Artifact` or `Deliverable` is the durable, downloadable result.
- The original conversation receives the final result. The owner task detail exposes outputs, external effects, cost, approvals, and the audit timeline.
- Failure, rejection, expiration, and cancellation remain visible; they are never rewritten as successful completion.

## Current P1 boundary

- A grounded natural-language plan may contain up to five ordered Compute or browser steps. Each step stores its concrete request, dependencies, policy result, outputs, and execution attempt. The next dependency-ready step is queued only after the current step commits successfully.
- Low-level read, command, browser, or explicit-file operations still clarify missing concrete inputs. Generated-document requests clarify topic, source material, audience, and format while the platform allocates the sandbox output path. The next audience message is recorded as a task input and the grounded planner must revalidate the combined request before execution resumes.
- MCP failures after a remote call begins are treated as an unknown outcome and move to reconciliation rather than automatic retry. An Owner may confirm remote success or failure with evidence; only confirmed failure can be retried.
- Delegate does not invent inverse MCP calls. Compensation performed in the external system can be recorded with Owner evidence and remains visible in the hash-linked audit timeline.
- The current scheduler is fail-fast and runs one dependency-ready step at a time. Parallel branches, automatic inverse-tool contracts, and arbitrary user-authored DAGs remain future scope.
