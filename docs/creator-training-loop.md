# Creator Training Loop

Delegate lets a creator keep improving a public digital representative without letting raw user chats rewrite public knowledge automatically.

The product loop is:

1. Creator registers source material such as URL, PDF, text, Notion, Drive, or website placeholders.
2. Creator or runtime records feedback signals such as correction, do-not-say, suggested answer, or approval.
3. The suggestion engine turns public-safe feedback and repeated unknown questions into deterministic training drafts.
4. A creator reviews each draft and chooses approve, reject, or keep private.
5. Approved drafts update the representative's editable knowledge draft and create a development revision with before/after snapshots.
6. The owner publishes a new immutable `RepresentativeVersion` separately before the change can affect public replies.
7. The latest development revision can be rolled back only while the knowledge draft still matches that revision's after snapshot.

## Safety Boundaries

- User conversation text is not automatically promoted into public knowledge.
- `publicSafe=false` feedback is ignored by the suggestion builder for every feedback type, including do-not-say signals.
- Approval always runs a deterministic evaluation on the server. Dashboard clients cannot submit or override the evaluation result.
- Training write routes derive `createdBy` and `reviewedBy` from the authenticated owner session through one actor resolver. Client-supplied actor fields are ignored.
- A repeated unanswered question remains a knowledge-gap prompt until the Owner writes a real public answer. Blank answers and legacy “creator-approved answer” placeholders are rejected on the server before any draft mutation.
- The first evaluation gate blocks obviously unsafe guaranteed-outcome claims such as guaranteed revenue or earnings.
- Only a `PENDING` suggestion can be reviewed. The transition is claimed atomically so repeated or concurrent review attempts cannot apply the same suggestion twice.
- Generated suggestion payloads are immutable. Changed evidence creates a successor and marks the previous pending draft as superseded; a partial unique index permits only one pending suggestion per representative and origin.
- Organization and every review action share the representative-scoped transaction advisory lock, so a suggestion cannot be superseded while it is being approved.
- KnowledgePack creation, setup edits, suggestion approval, and rollback use the same lock. The KnowledgePack revision token rejects stale full-form setup saves before any write.
- Applied knowledge documents use a stable origin-derived ID and replace prior documents from that origin, including legacy `training_<suggestionId>` entries.
- Every approved draft stores a `CreatorTrainingVersion` row with `snapshotBefore`, `snapshotAfter`, and `evaluationReport`. This is a development revision, not the immutable public representative version.
- Development revisions use a database-constrained, representative-scoped monotonic `revisionNumber`; transaction start timestamps do not define revision order.
- Rollback restores `snapshotBefore` and marks the version as `ROLLED_BACK` only when it is the latest applied revision and the current knowledge draft still equals `snapshotAfter`.
- Review and rollback actors are derived from the authenticated server session and persisted for audit; body-supplied actor fields are ignored.
- Setup CAS must succeed before knowledge-asset bindings are saved, preventing a 409 conflict from producing a partial save.
- Public pages and new conversations continue to use the active immutable `RepresentativeVersion` until the owner explicitly publishes a new version.

## Workflow Path

`CREATOR_TRAINING_REVIEW` is the durable workflow kind for asynchronous suggestion generation.

The enqueue path is:

```text
Owner dashboard
  -> GET /api/dashboard/representatives/:slug/training
  -> load the real review queue, revision history, input counts, and latest run
  -> POST /api/dashboard/representatives/:slug/training/workflows
  -> enqueueCreatorTrainingReviewWorkflow
  -> WorkflowRun(kind=CREATOR_TRAINING_REVIEW)
  -> local runner or Temporal START outbox
  -> processCreatorTrainingReview
  -> buildCreatorTrainingSuggestions
```

The dedupe key is hourly per representative, so repeated clicks do not spam the queue, but later training cycles are still possible.

All Dashboard training responses are marked `Cache-Control: private, no-store`.

## Status and Recovery Semantics

- A suggestion starts as `pending`. Reject and keep-private are terminal review choices in the current Dashboard; there is no restore action for either state.
- Approval uses an internal atomic `approved` claim and then settles as `published` in the training tables. Here, `published` means **applied to the editable KnowledgePack draft**. It does not mean that a public immutable `RepresentativeVersion` was created or activated.
- Each applied suggestion creates a `CreatorTrainingVersion`, which is a development revision snapshot. It is deliberately separate from `RepresentativeVersion`.
- Only the newest applied development revision can be reverted, and only while the current knowledge draft still equals that revision's recorded after-snapshot. This prevents a rollback from overwriting later manual or training edits.
- Reverting marks that development revision `rolled_back` and restores its before-snapshot to the editable knowledge draft. It does not change the active public representative version. If public behavior must change, the Owner must release a new `RepresentativeVersion`.
- In the governed-memory support area, disable prevents future use but currently has no restore action. Delete immediately clears the local summary, then moves through deletion pending to deleted or deletion failed. Stale pending work and due failures are recovered automatically with leases and exponential backoff; the Dashboard retry action is an additional recovery path. Deleted content is not recoverable from the Dashboard.

## Dashboard Product Boundary

The stable Dashboard URL remains `?view=memory` for backwards compatibility, but the user-facing module is named **Representative Development / 养成**.

The page:

- shows real source, feedback, suggestion, workflow, and revision data;
- presents suggestion payloads as human-readable FAQ, material, or policy previews rather than raw JSON;
- labels approval as writing to the knowledge draft, never as an immediate public release;
- links the owner to the representative release flow after a draft change is approved;
- includes a **Memory & Use / 记忆与使用** support area for the released-content projection switch, sync status, published-item count, and aggregate usage count;
- states that automatic chat capture is off and raw conversations are not automatically turned into memory;
- shows governed memories only as user-facing status plus a safe summary, with disable, delete, and failed-deletion retry actions;
- does not expose storage URIs, raw retrieval records, queries, ranking values, provider endpoints, or provider errors.

## Main Files

- `prisma/schema.prisma`: training source, feedback, suggestion, version, and workflow enum models.
- `packages/web-data/src/creator-training.ts`: source registry, feedback, suggestion generation, review, evaluation, rollback, and enqueue services.
- `packages/workflows/src/index.ts`: workflow kind, input schema, dedupe key, and dispatch target helpers.
- `apps/workflow-runner/src/runner.ts`: local/Temporal workflow execution for training review.
- `apps/web/app/dashboard/dashboard-training.tsx`: owner dashboard training cockpit.
- `apps/web/app/api/dashboard/representatives/[slug]/training`: dashboard API routes.

## Operator Notes

- Local runner mode processes due `WorkflowRun` rows directly.
- The same runner also processes durable released-context sync jobs and stale memory deletions. Sync jobs are written in the same database transaction as publish or activate, then claimed with a lease and retried with backoff.
- Sync completion updates the representative aggregate only when both the requested version is still active and the job is still the representative's latest sync job. A late job may settle its own history but cannot overwrite newer status.
- Temporal mode writes a `START` command to `WorkflowCommandOutbox`; the dispatcher starts Temporal using `externalWorkflowId` as the idempotency key.
- The business truth remains in Postgres. Temporal only handles durable orchestration, retry, and cancellation delivery.
- If the newest applied development revision is wrong and no later draft edit exists, use the Dashboard revert action or `rollbackCreatorTrainingVersion` to restore the previous KnowledgePack draft snapshot. Release a new public representative version separately if that correction must affect public replies.
