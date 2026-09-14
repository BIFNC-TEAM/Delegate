BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('delegate:pi-legacy-schema-removal'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "GenerationRun"
    WHERE "delegationTaskId" IS NOT NULL
      AND "status" IN ('QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'WAITING_HUMAN')
  ) THEN
    RAISE EXCEPTION 'legacy drain blocked: active delegated GenerationRun rows remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ApprovalRequest"
    WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
      AND "status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'legacy drain blocked: pending delegated approvals remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ComputeSession"
    WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
      AND "endedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy drain blocked: ComputeSession release must complete first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DelegationTaskExternalEffect" effect
    LEFT JOIN "ConversationPlanAction" action
      ON action."id" = effect."planActionId"
    WHERE effect."status" IN (
      'WAITING_APPROVAL',
      'APPROVED',
      'EXECUTING',
      'RECONCILIATION_REQUIRED'
    )
      AND NOT (
        effect."status" = 'RECONCILIATION_REQUIRED'
        AND effect."callStartedAt" IS NOT NULL
        AND effect."responseSnapshot"->>'outcome' = 'failed'
        AND action."sideEffectClass" = 'NONE'
        AND action."capabilityKey" = 'mcp.deepwiki.ask_question'
      )
  ) THEN
    RAISE EXCEPTION 'legacy drain blocked: an external effect lacks an approved no-mutation reconciliation rule';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ConversationPlanAction"
    WHERE "status" = 'RECONCILIATION_REQUIRED'
      AND "sideEffectClass" <> 'NONE'
  ) THEN
    RAISE EXCEPTION 'legacy drain blocked: a reconciliation PlanAction can mutate business state';
  END IF;
END $$;

UPDATE "DelegationTaskExternalEffect" effect
SET
  "status" = 'FAILED',
  "failureReason" = 'pi_legacy_read_only_outcome_closed_as_failed',
  "reconciledAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "ConversationPlanAction" action
WHERE effect."planActionId" = action."id"
  AND effect."status" = 'RECONCILIATION_REQUIRED'
  AND effect."callStartedAt" IS NOT NULL
  AND effect."responseSnapshot"->>'outcome' = 'failed'
  AND action."sideEffectClass" = 'NONE'
  AND action."capabilityKey" = 'mcp.deepwiki.ask_question';

UPDATE "DelegationTaskExternalEffect"
SET
  "status" = 'CANCELED',
  "failureReason" = 'pi_legacy_schema_removal_not_started',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'PROPOSED'
  AND "callStartedAt" IS NULL
  AND "externalReferenceId" IS NULL
  AND "responseSnapshot" IS NULL
  AND "approvalRequestId" IS NULL;

UPDATE "ToolExecution"
SET
  "status" = 'CANCELED',
  "finishedAt" = CURRENT_TIMESTAMP,
  "executionLeaseToken" = NULL
WHERE (
    "planActionId" IS NOT NULL
    OR "delegationTaskId" IS NOT NULL
    OR "delegationTaskStepId" IS NOT NULL
  )
  AND "status" IN ('QUEUED', 'RUNNING', 'BLOCKED');

UPDATE "ConversationPlanAction"
SET
  "status" = 'FAILED',
  "failedAt" = COALESCE("failedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'RECONCILIATION_REQUIRED'
  AND "sideEffectClass" = 'NONE';

UPDATE "ConversationPlanAction"
SET
  "status" = 'CANCELED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN (
  'PLANNED',
  'AUTHORIZING',
  'WAITING_APPROVAL',
  'READY',
  'QUEUED',
  'EXECUTING',
  'VERIFYING'
);

UPDATE "ConversationTurnPlan"
SET
  "status" = 'CANCELED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('PROPOSED', 'VALIDATED', 'EXECUTING');

UPDATE "DelegationTaskStep"
SET
  "status" = 'CANCELED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN (
  'DRAFT',
  'READY',
  'WAITING_APPROVAL',
  'QUEUED',
  'RUNNING',
  'WAITING_INPUT',
  'BLOCKED'
);

UPDATE "DelegationTask"
SET
  "status" = 'CANCELED',
  "nextActionBy" = 'NONE',
  "blockingReason" = 'pi_legacy_schema_removal',
  "canceledAt" = COALESCE("canceledAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP,
  "version" = "version" + 1
WHERE "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED');

UPDATE "WorkflowRun"
SET
  "status" = 'CANCELED',
  "enginePhase" = 'CANCELED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "nextWakeAt" = NULL,
  "lastError" = 'pi_legacy_schema_removal',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE (
    "turnPlanId" IS NOT NULL
    OR "delegationTaskId" IS NOT NULL
    OR "delegationTaskStepId" IS NOT NULL
    OR "kind" = 'DELEGATION_EXECUTION'
  )
  AND "status" IN ('QUEUED', 'RUNNING');

COMMIT;
