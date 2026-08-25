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

Ordinary stable/knowledge answering remains a conversation and does not create a task. In active V3, a task is created only after the server-validated TurnPlan contains a typed MCP/Compute Action. The old natural-language detailed planner runs only in V2 rollback/shadow modes. A bare `/compute` request still returns usage guidance.

The compute path creates one step per planned operation, with at most five dependency-ordered steps in the current P1 scheduler:

```text
READY -> RUNNING -> COMPLETED
                  -> FAILED
                  -> BLOCKED (step; task is failed)
          |
          +-> AWAITING_APPROVAL -> RUNNING -> COMPLETED
                                  -> CANCELED (rejected)
                                  -> EXPIRED
```

The task resource policy is a captured business-level limit. The compute broker remains the enforcement boundary for capability policy, sandbox isolation, billing availability, and owner approval.

When the Owner enables the `public_knowledge` delegation scope, each recalled Knowledge Asset used by planning is stored as a task input plus an Owner data grant with task-local read/use scopes. User-input-only mode creates no knowledge grant.

## Ownership and audit guarantees

The web-data service verifies that the representative, contact, conversation, episode, generation run, representative version, and input message belong to one context before creating the task. The compute broker repeats ownership checks before attaching a session to a task and verifies that the requested capability is allowed by both the task step and its resource policy.

Task transitions use a PostgreSQL advisory transaction lock. Each event receives a monotonic per-task sequence plus a SHA-256 hash over canonical JSON and the preceding event hash. Operational audit records remain separate and carry the task ID for cross-system investigation.

## Product surfaces

- Public chat uses outcome language and returns final files through the original conversation.
- Inbox → Pending lists active, waiting, and failed delegated tasks without adding another top-level dashboard module.
- Conversation detail shows task status, next actor, step state, output count, and approval count.
- Approval detail shows the task that requested the governed action.

Multi-step service delegation uses the same aggregate for clarification, dependency-ordered Compute/browser steps, MCP calls, delivery, and reconciliation without equating any individual runtime session with the user's task. PlanAction remains protocol truth. Planned `on_failure` alternatives activate only on matching Verified failure codes; unused alternatives become `SKIPPED`. Unknown MCP outcomes require Owner reconciliation before retry.
