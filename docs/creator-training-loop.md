# Creator Training Loop

Delegate lets a creator keep improving a public digital representative without letting raw user chats rewrite public knowledge automatically.

The product loop is:

1. Creator registers source material such as URL, PDF, text, Notion, Drive, or website placeholders.
2. Creator or runtime records feedback signals such as correction, do-not-say, suggested answer, or approval.
3. The suggestion engine turns public-safe feedback and repeated unknown questions into deterministic training drafts.
4. A creator reviews each draft and chooses approve, reject, or keep private.
5. Approved drafts update the representative KnowledgePack and create a version with before/after snapshots.
6. A version can be rolled back, restoring the KnowledgePack to the before snapshot.

## Safety Boundaries

- User conversation text is not automatically promoted into public knowledge.
- `publicSafe=false` feedback is ignored by the suggestion builder.
- Approval runs a deterministic release evaluation before publishing.
- The first evaluation gate blocks obviously unsafe guaranteed-outcome claims such as guaranteed revenue or earnings.
- Every publish stores a `CreatorTrainingVersion` row with `snapshotBefore`, `snapshotAfter`, and `evaluationReport`.
- Rollback restores `snapshotBefore` and marks the version as `ROLLED_BACK`.

## Workflow Path

`CREATOR_TRAINING_REVIEW` is the durable workflow kind for asynchronous suggestion generation.

The enqueue path is:

```text
Owner dashboard
  -> POST /api/dashboard/representatives/:slug/training/workflows
  -> enqueueCreatorTrainingReviewWorkflow
  -> WorkflowRun(kind=CREATOR_TRAINING_REVIEW)
  -> local runner or Temporal START outbox
  -> processCreatorTrainingReview
  -> buildCreatorTrainingSuggestions
```

The dedupe key is hourly per representative, so repeated clicks do not spam the queue, but later training cycles are still possible.

## Main Files

- `prisma/schema.prisma`: training source, feedback, suggestion, version, and workflow enum models.
- `packages/web-data/src/creator-training.ts`: source registry, feedback, suggestion generation, review, evaluation, rollback, and enqueue services.
- `packages/workflows/src/index.ts`: workflow kind, input schema, dedupe key, and dispatch target helpers.
- `apps/workflow-runner/src/runner.ts`: local/Temporal workflow execution for training review.
- `apps/web/app/dashboard/dashboard-training.tsx`: owner dashboard training cockpit.
- `apps/web/app/api/dashboard/representatives/[slug]/training`: dashboard API routes.

## Operator Notes

- Local runner mode processes due `WorkflowRun` rows directly.
- Temporal mode writes a `START` command to `WorkflowCommandOutbox`; the dispatcher starts Temporal using `externalWorkflowId` as the idempotency key.
- The business truth remains in Postgres. Temporal only handles durable orchestration, retry, and cancellation delivery.
- If a publish is wrong, use the dashboard rollback action or `rollbackCreatorTrainingVersion` to restore the previous KnowledgePack snapshot.
