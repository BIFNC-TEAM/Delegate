# Delegation Tasks

The owner and audience behavior is defined by the [delegation task product contract](./delegation-task-product-contract.md).

`DelegationTask` is the business object that connects a visitor's requested outcome to the work Delegate performs. A conversation is communication context; a compute session, model run, approval, or workflow is only one execution detail of a task.

## Aggregate boundary

The task records:

- initiator, representative, and immutable representative version;
- objective, desired outcome, acceptance criteria, priority, and deadline;
- user-provided inputs and explicit data grants;
- allowed capabilities, skills, MCP bindings, external accounts, time, cost, credit, tool-call, step, network, filesystem, and artifact limits;
- ordered execution steps and their dependencies;
- approvals and proposed or completed external side effects;
- artifacts, deliverables, summaries, and final outputs;
- an append-only, hash-linked task event stream.

Existing runtime records keep nullable task and step references so historical data remains valid. New delegated compute work links `Message`, `GenerationRun`, `ComputeSession`, `ToolExecution`, `ApprovalRequest`, approval-expiration `WorkflowRun`, `Artifact`, `LedgerEntry`, and `EventAudit` records to the same task.

## Current creation rule

Ordinary question answering remains a conversation and does not create a task. A public web request creates a task only after an explicit `/compute` instruction or the grounded natural-language compute planner has identified a concrete operation. A bare `/compute` request only returns usage guidance.

The compute path currently creates one step per task:

```text
READY -> RUNNING -> COMPLETED
                  -> FAILED
          |
          +-> AWAITING_APPROVAL -> RUNNING -> COMPLETED
                                  -> CANCELED (rejected)
                                  -> EXPIRED
```

The task resource policy is a captured business-level limit. The compute broker remains the enforcement boundary for capability policy, sandbox isolation, billing availability, and owner approval.

## Ownership and audit guarantees

The web-data service verifies that the representative, contact, conversation, episode, generation run, representative version, and input message belong to one context before creating the task. The compute broker repeats ownership checks before attaching a session to a task and verifies that the requested capability is allowed by both the task step and its resource policy.

Task transitions use a PostgreSQL advisory transaction lock. Each event receives a monotonic per-task sequence plus a SHA-256 hash over canonical JSON and the preceding event hash. Operational audit records remain separate and carry the task ID for cross-system investigation.

## Product surfaces

- Public chat uses outcome language and returns final files through the original conversation.
- Inbox → Pending lists active, waiting, and failed delegated tasks without adding another top-level dashboard module.
- Conversation detail shows task status, next actor, step state, output count, and approval count.
- Approval detail shows the task that requested the governed action.

P1 multi-step service delegation uses the same aggregate for clarification, dependency-ordered Compute/browser steps, MCP calls, delivery, and reconciliation without equating any individual runtime session with the user's task. It is intentionally fail-fast and sequential; unknown MCP outcomes require Owner reconciliation before retry.
