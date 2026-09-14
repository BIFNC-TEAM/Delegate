# Pi legacy schema removal

Status: IMPLEMENTED AND APPLIED TO THE AUTHORIZED LOCAL TARGET. Group A
(legacy planner) and Group B (legacy delegation aggregate) are removed from
the application schema and from the localhost `delegate` database. No external
staging or production database was configured, so every future target still
requires its own read-only preflight, verified backup and maintenance approval.

## Verified starting state

The isolated database preflight at `2026-09-09T08:00:41Z` reported zero active
TurnPlans, DelegationTasks, delegated GenerationRuns, legacy WorkflowRuns and
legacy approvals. Eleven active non-delegated Pi runs were observations, not
blockers.

Database introspection found 55 foreign keys touching the legacy plan and
delegation roots. `DROP ... CASCADE` is prohibited because several referencing
tables remain part of the Pi product.

## Removal groups

### Group A — old planning tables

Delete after all source references are retired:

- `PlanExecutionFence`
- `ActionAuthorizationDecision`
- `ConversationPlanAction`
- `ConversationTurnPlan`
- plan-owned `BillableUnit` rows/table if no non-plan owner remains

Shared Pi tables must keep their rows and lose only legacy nullable coordinates:

- `GenerationRun.delegationTaskId/delegationTaskStepId`
- `WorkflowRun.turnPlanId/delegationTaskId/delegationTaskStepId`
- `ToolExecution.planActionId/delegationTaskId/delegationTaskStepId/externalEffectId`
- `ApprovalRequest.delegationTaskId/delegationTaskStepId`
- legacy plan coordinates on `ActionResult` and `MessageDeliveryAttempt`

### Group B — old delegation tables

Delete leaf-first after task APIs and workflow branches are retired:

- `DelegationTaskDataGrant`
- `DelegationTaskInput`
- `DelegationTaskResourcePolicy`
- `DelegationTaskOutput`
- `DelegationTaskEvent`
- `DelegationTaskExternalEffect`
- `DelegationTaskStep`
- `DelegationTask`

Remove nullable task coordinates from `Message`, `Artifact`, `Deliverable`,
`LedgerEntry`, `EventAudit`, `GenerationRun`, `ComputeSession`, `ToolExecution`,
`ApprovalRequest`, `WorkflowRun` and any remaining shared table. Preserve the
shared table itself.

## Completed source retirement

- Removed the old PlanAction-backed managed-document artifact service and its
  tests. Pi now delivers files through sandbox/artifact adapters.
- Removed the V3 PlanAction reconciliation loop and its tests from Workflow
  Runner.
- Removed both Dashboard DelegationTask mutation/detail API routes. The Inbox
  no longer renders links that open the legacy task drawer, and its active
  conversation/assignment/runs UI remains intact. Generated Next route types
  were refreshed after route deletion.
- Removed Workflow Runner's local and Temporal `DELEGATION_EXECUTION`
  workflow/activity, signal dispatch, durable transition implementation and
  their tests. Any stale START/SIGNAL command now fails explicitly with a
  retirement error instead of executing or falling back.
- Conversation intake no longer creates a DelegationTask. It atomically keeps
  the IntakeSubmission, Lead, Contact stage, collector reset and intake event,
  but returns no legacy service-request coordinate. The standalone service-
  request creator and its tests were removed.
- Compute approval completion no longer finalizes a DelegationTask, advances a
  legacy step, or requeues a V3 Composer. GenerationRun now exclusively owns
  its result delivery and wallet/entitlement release, including when an old
  nullable coordinate is present on historical data.
- Compute Broker now rejects new sessions carrying DelegationTask/step
  coordinates and rejects an old coordinated session again at policy load.
  The compatibility test asserts the retirement error before any ComputeSession
  or audit row is created.
- Approved-execution recovery no longer branches on a V3 PlanAction or waits
  for the retired PlanAction `ActionResult` aggregate. It reconciles the actual
  terminal ToolExecution for the GenerationRun approval. The V3-only semantic
  result test suite and planAction recovery filter were removed; normal
  interrupted-approval recovery remains covered.
- Compute Broker session creation, policy evaluation, approval resumption,
  MCP execution and billing no longer query or mutate PlanAction-owned state.
  MCP schema pins now come directly from the published representative runtime.
- Pi message delivery no longer loads a completed TurnPlan, freezes plan
  coordinates on delivery attempts, or exposes old TurnPlan progress.
- Removed `BillableUnit` runtime code and the old plan-owned billing exception.
- Removed the remaining pure V3 runtime modules (`turn-planning-v3`,
  `turn-outcomes`, `capability-compilation`, `capability-publication` and
  `action-results`) plus the unused natural-language Compute planner.
- Preserved the two live security responsibilities under neutral modules:
  untrusted artifact redaction now lives in `artifact-sanitization`, and the
  server-owned MCP trust allowlist now lives in `mcp-server-policy`.
- Removed the `delegation` Representative Setup DTO, Dashboard request fields,
  compatibility defaults, stale message-conflict branches and UI strings.

## Group A migration evidence

- Migration: `20260910100000_remove_legacy_planner`.
- Prisma validation and client generation passed after removing the planner
  models, shared-table plan coordinates and planner-only enums.
- Final fresh rehearsal database: all 170 migrations applied successfully.
- Upgrade rehearsal database: cloned from the isolated Agent test database,
  preflight passed with zero blockers, then the migration applied successfully.
- Post-upgrade verification returned `1|1|1|1|1|11`: the five queried legacy
  planner tables were absent and all 11 active Pi GenerationRuns remained.
- The preflight now uses a read-only catalog-aware SQL transaction, so the same
  command works both before and after Group A/Group B column removal.

## Group B migration evidence

- Migration: `20260910110000_remove_legacy_delegation`.
- Removed all eight DelegationTask aggregate tables, nullable coordinates from
  shared Pi tables, six Representative delegation settings and twelve legacy
  enums. `WorkflowKind` is rebuilt without `DELEGATION_EXECUTION`.
- Terminal legacy workflow rows are explicitly deleted before rebuilding the
  enum; active legacy workflow rows remain a hard migration blocker.
- The upgrade rehearsal preserved all 11 active Pi GenerationRuns while the
  DelegationTask, DelegationTaskStep and DelegationTaskExternalEffect tables
  were verified absent afterward.
- A fresh database successfully replayed all 170 migrations through Group A
  and Group B, including the recovered historical migration and the workspace
  Skill release migration.

Latest affected-module verification: runtime 57/57 pass; model-runtime 114
pass / 4 opt-in skip; web-data 1537 pass / 180 opt-in skip; Reps 292/292 pass;
Workflow Runner 33/33 pass; workflows 11/11 pass; conversation-worker 57/57
pass; Dashboard 312/312 pass; Compute Broker 245 pass / 4 opt-in skip; all 21
workspace package typechecks pass.
The lower totals reflect physical deletion of retired V3/Delegation tests, not
new skips.

## Production execution procedure

Do not point these commands at a deployment until a maintenance window and a
restorable backup have been confirmed.

1. Record the target fingerprint with `SELECT current_database(),
   current_user, inet_server_addr(), inet_server_port(), version();`.
2. Create and verify a PostgreSQL custom-format backup, for example
   `pg_dump --format=custom --no-owner --file=<approved-backup-path>
   "$DATABASE_URL"`, then run `pg_restore --list` against the artifact.
3. Run `pnpm agent:pi:legacy-preflight`. Any blocker aborts the deployment.
4. Run `pnpm prisma migrate status`, then `pnpm prisma migrate deploy`.
5. Run the preflight again. Confirm the planner and delegation tables return
   null from `to_regclass`, and compare active Pi GenerationRun counts with the
   value recorded before migration.
6. Verify direct answer, MCP, sandbox/file delivery and human handoff on the
   target deployment. A failed verification triggers application rollback and
   database restore from the approved backup; these destructive migrations do
   not have a synthetic down migration.

## Production execution readiness record — 2026-09-10

The first production-preparation pass found no production target in the
process environment or repository. The only configured application database
was the localhost development database `delegate`, with non-secret fingerprint
`54046c3e42d64d47`.

Initial read-only results incorrectly reported zero blockers because the first
catalog probe passed mixed-case table names to `to_regclass` without quoting;
PostgreSQL folded them to lowercase. The probe now joins `pg_class` and
`pg_namespace` using exact `relname` values. The corrected localhost result is:

- active TurnPlans: 40;
- active DelegationTasks: 5;
- active legacy WorkflowRuns: 40;
- active legacy ToolExecutions: 26;
- legacy ComputeSessions without `endedAt`: 99;
- unresolved external effects: 14;
- reconciliation-required PlanActions: 7;
- active Pi GenerationRuns: 33;
- pending repository migrations:
  `20260909090000_workspace_skill_release_instructions`,
  `20260910100000_remove_legacy_planner`, and
  `20260910110000_remove_legacy_delegation`;
- database-only migration:
  `20260804111000_memory_projection_write_recovery`;
- database record: applied successfully at `2026-08-04T02:53:28Z`, checksum
  `3fe221f9d3b928b0fe24e04b3aa80265167bc2281a31b4da81be191a2894296c`.

The missing migration SQL was not found in the current worktree, any Git ref,
or sibling project directories, but was recovered byte-for-byte from the
original 2026-08-04 Codex session log. The restored 8,075-byte file has SHA-256
`3fe221f9d3b928b0fe24e04b3aa80265167bc2281a31b4da81be191a2894296c`,
which exactly matches the applied database record. Migration history is now
consistent.

A custom-format backup of the localhost database was created before further
work at `/private/tmp/delegate-pre-legacy-cleanup-20260910T0343Z.dump`:

- size: 40,498,576 bytes;
- SHA-256: `e7901ae4f5bcf65f1e188d808e4954256ac5433000b962e7d93ba38990d36f01`;
- `pg_restore --list`: successful, 1,881 TOC entries including migration and
  core Pi table data.

The backup was restored into `delegate_preprod_rehearsal_20260910`. The
workspace-skill migration applied, then the Planner migration correctly
stopped at its active-plan guard. No write was made to the source `delegate`
database.

The unresolved-effect breakdown is safety-significant:

- 12 `PROPOSED` effects have no call start, remote reference, response or
  approval and may be mechanically canceled only after target confirmation;
- 2 `RECONCILIATION_REQUIRED` effects have call-start timestamps, response
  snapshots and approvals;
- 7 reconciliation-required PlanActions have failed executions with
  `transportOutcome=outcome_unknown`.

The last two groups require an explicit provider/Owner outcome decision before
any drain or destructive migration. They must not be silently canceled or
reported as successful.

Further read-only correlation established that both external effects belong to
the `deepwiki/ask_question` MCP binding and their PlanActions declare
`sideEffectClass=NONE`. Their persisted responses report `outcome=failed`, but
the historical transport outcome is `outcome_unknown`; five other
reconciliation-required actions are `response.compose` attempts with no
response snapshot. These facts make a no-business-mutation drain defensible
for this localhost dataset, but the target owner must still explicitly approve
terminalizing the historical records before they are deleted.

The repaired migration directory brings the repository chain to 170
migrations. A brand-new isolated PostgreSQL database replayed all 170
successfully after the stronger Planner/Delegation guards were added.

## Authorized localhost execution record — 2026-09-10

The user authorized maintenance against the disclosed localhost target with
non-secret fingerprint `54046c3e42d64d47`. This was not represented as an
external production deployment.

- A verified custom-format backup was retained at
  `/private/tmp/delegate-pre-legacy-cleanup-20260910T0343Z.dump` (40,498,576
  bytes, SHA-256
  `e7901ae4f5bcf65f1e188d808e4954256ac5433000b962e7d93ba38990d36f01`).
- The Compute Broker terminated 99/99 old sessions through its real terminate
  endpoint before it was stopped. No session was marked ended by direct SQL.
- The bounded drain closed exactly 2 failed read-only DeepWiki reconciliation
  effects, 12 unstarted proposed effects, 26 old executions, 7 reconciliation
  actions, 49 other active actions, 40 TurnPlans, 43 DelegationTask steps, 5
  DelegationTasks and 40 legacy WorkflowRuns. Its transaction guards rejected
  any unknown mutating effect.
- The post-drain preflight reported zero blockers and preserved all 33 active
  Pi GenerationRuns.
- `prisma migrate deploy` applied
  `20260909090000_workspace_skill_release_instructions`,
  `20260910100000_remove_legacy_planner` and
  `20260910110000_remove_legacy_delegation`. `prisma migrate status` then
  reported all 170 migrations up to date with no failed migration.
- Catalog verification confirmed `ConversationTurnPlan`,
  `ConversationPlanAction`, `DelegationTask` and `DelegationTaskStep` are
  absent. The second preflight remained blocker-free.
- Rebuilding the product exposed one stale Reps SSE dependency on the removed
  `taskProgress`/`turnProgress` contract. The stream now terminates from the
  authoritative Pi GenerationRun state, and the dead Planner/Delegation
  progress DTO and UI were removed.
- The last runtime-only `turn-planning` dependency was reduced to a neutral,
  tested `capability-schema` utility used by MCP schema pinning. The unused V2
  planning protocol and V3 release-gate modules/tests were deleted. Pi model
  configuration no longer reads or exports a dedicated Planner provider.
- The staging environment generator no longer emits the removed Planner model
  settings or V2/V3 rollout switches. A deployment contract test fails if any
  of those retired names is reintroduced; Conversation Worker continues to
  reject stale operator-provided switches rather than silently restoring an
  old execution path.
- The existing `.env.wechat.local` HTTPS callback overlay was required for the
  already-enabled WeChat Pay startup preflight. No credential was modified and
  payment processing was not disabled.
- Final HTTP probes returned 200 for Site, Dashboard, Reps readiness, Compute
  Broker, Workflow Runner health/readiness and Conversation Worker. Reps and
  Web Data typechecks passed; the affected regression tests passed 29/29;
  full Reps tests passed 292/292; full Web Data tests passed 1,537 with 180
  opt-in integration tests skipped. The final runtime/model/broker/worker pass
  was 57/57, 114 plus 4 opt-in skips, 245 plus 4 opt-in skips, and 57/57;
  their typechecks also passed. Staging deployment contracts passed 8/8.

## Migration gates

1. Preflight blockers must all be zero.
2. All runtime imports of the target Prisma models must be removed.
3. `prisma generate`, schema validation and full typecheck must pass before SQL
   is generated.
4. Migration SQL must explicitly drop foreign keys, indexes, columns, leaf
   tables, root tables and finally unused enums; no `CASCADE`.
5. Exercise both an upgraded copy of the isolated database and a fresh database.
6. Re-run Pi direct answer, MCP, sandbox/file delivery and handoff tests.
7. Production requires target fingerprint, backup confirmation and a second
   zero-blocker preflight immediately before deployment.
