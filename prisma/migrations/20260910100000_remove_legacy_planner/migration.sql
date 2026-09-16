BEGIN;

-- The Pi runtime cannot resume planner drafts. Cancel only plans that have
-- never entered an executable/approval state and have no live downstream
-- effects. Any genuinely active legacy work continues to fail closed below.
WITH cancelable_plans AS (
  SELECT plan."id"
  FROM "ConversationTurnPlan" AS plan
  WHERE plan."status" IN ('PROPOSED', 'VALIDATED')
    AND NOT EXISTS (
      SELECT 1
      FROM "ConversationPlanAction" AS action
      WHERE action."turnPlanId" = plan."id"
        AND action."status" NOT IN ('PLANNED', 'CANCELED', 'SKIPPED', 'SUCCEEDED', 'FAILED')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "ConversationPlanAction" AS action
      JOIN "ToolExecution" AS execution
        ON execution."planActionId" = action."id"
      WHERE action."turnPlanId" = plan."id"
        AND execution."status" IN ('QUEUED', 'RUNNING', 'BLOCKED')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "WorkflowRun" AS workflow
      WHERE workflow."turnPlanId" = plan."id"
        AND workflow."status" IN ('QUEUED', 'RUNNING')
    )
)
UPDATE "ConversationPlanAction" AS action
SET "status" = 'CANCELED',
    "updatedAt" = CURRENT_TIMESTAMP
FROM cancelable_plans
WHERE action."turnPlanId" = cancelable_plans."id"
  AND action."status" = 'PLANNED';

UPDATE "ConversationTurnPlan" AS plan
SET "status" = 'CANCELED',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE plan."status" IN ('PROPOSED', 'VALIDATED')
  AND NOT EXISTS (
    SELECT 1
    FROM "ConversationPlanAction" AS action
    WHERE action."turnPlanId" = plan."id"
      AND action."status" NOT IN ('CANCELED', 'SKIPPED', 'SUCCEEDED', 'FAILED')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "ConversationPlanAction" AS action
    JOIN "ToolExecution" AS execution
      ON execution."planActionId" = action."id"
    WHERE action."turnPlanId" = plan."id"
      AND execution."status" IN ('QUEUED', 'RUNNING', 'BLOCKED')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "WorkflowRun" AS workflow
    WHERE workflow."turnPlanId" = plan."id"
      AND workflow."status" IN ('QUEUED', 'RUNNING')
  );

-- Refuse to remove the legacy planner while it can still own live work.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ConversationTurnPlan"
    WHERE "status" IN ('PROPOSED', 'VALIDATED', 'EXECUTING')
  ) THEN
    RAISE EXCEPTION 'legacy planner removal blocked: active ConversationTurnPlan rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ToolExecution"
    WHERE "planActionId" IS NOT NULL
      AND "status" IN ('QUEUED', 'RUNNING', 'BLOCKED')
  ) THEN
    RAISE EXCEPTION 'legacy planner removal blocked: active plan-owned ToolExecution rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ConversationPlanAction"
    WHERE "status" = 'RECONCILIATION_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'legacy planner removal blocked: reconciliation-required PlanAction rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "WorkflowRun"
    WHERE "turnPlanId" IS NOT NULL
      AND "status" IN ('QUEUED', 'RUNNING')
  ) THEN
    RAISE EXCEPTION 'legacy planner removal blocked: active plan-owned WorkflowRun rows remain';
  END IF;
END $$;

-- Remove foreign keys from Pi-owned/shared tables first.
ALTER TABLE "MessageDeliveryAttempt"
  DROP CONSTRAINT "MessageDeliveryAttempt_planId_fkey",
  DROP CONSTRAINT "MessageDeliveryAttempt_planActionId_fkey";
ALTER TABLE "ToolExecution"
  DROP CONSTRAINT "ToolExecution_planActionId_fkey";
ALTER TABLE "DelegationTaskExternalEffect"
  DROP CONSTRAINT "DelegationTaskExternalEffect_planActionId_fkey";
ALTER TABLE "WorkflowRun"
  DROP CONSTRAINT "WorkflowRun_turnPlanId_fkey";

DROP INDEX "MessageDeliveryAttempt_planId_planRevision_executionEpoch_status_idx";
DROP INDEX "MessageDeliveryAttempt_planAction_idx";
DROP INDEX "ToolExecution_executionOutboxId_key";
DROP INDEX "ToolExecution_planAction_attemptNumber_key";
DROP INDEX "ToolExecution_planAction_phase_created_idx";
DROP INDEX "ToolExecution_epoch_status_created_idx";
DROP INDEX "DelegationTaskExternalEffect_planAction_status_created_idx";
DROP INDEX "WorkflowRun_turnPlanId_status_scheduledAt_idx";

ALTER TABLE "MessageDeliveryAttempt"
  DROP COLUMN "planId",
  DROP COLUMN "planActionId",
  DROP COLUMN "planRevision",
  DROP COLUMN "executionEpoch";
ALTER TABLE "ToolExecution"
  DROP COLUMN "planActionId",
  DROP COLUMN "planRevision",
  DROP COLUMN "executionEpoch",
  DROP COLUMN "attemptNumber",
  DROP COLUMN "attemptPhase",
  DROP COLUMN "executionOutboxId",
  DROP COLUMN "billingAdmission";
ALTER TABLE "DelegationTaskExternalEffect"
  DROP COLUMN "planActionId";
ALTER TABLE "WorkflowRun"
  DROP COLUMN "turnPlanId";

-- Drop planner-owned leaf tables and their non-primary indexes explicitly.
DROP INDEX "ActionResult_executionAttemptId_key";
DROP INDEX "ActionResult_plan_semantic_created_idx";
DROP INDEX "ActionResult_action_verified_idx";
DROP INDEX "ActionResult_externalEffectId_idx";
DROP TABLE "ActionResult";

DROP INDEX "ActionAuthorizationDecision_action_sequence_key";
DROP INDEX "ActionAuthorizationDecision_action_phase_created_idx";
DROP INDEX "ActionAuthorizationDecision_decision_created_idx";
DROP TABLE "ActionAuthorizationDecision";

DROP INDEX "BillableUnit_idempotencyKey_key";
DROP INDEX "BillableUnit_plan_status_created_idx";
DROP INDEX "BillableUnit_action_status_idx";
DROP INDEX "BillableUnit_accounts_status_idx";
DROP INDEX "BillableUnit_owner_status_idx";
DROP TABLE "BillableUnit";

DROP INDEX "PlanExecutionFence_activePlanId_key";
DROP INDEX "PlanExecutionFence_activePlan_revision_idx";
DROP INDEX "PlanExecutionFence_epoch_updated_idx";
DROP TABLE "PlanExecutionFence";

DROP INDEX "ConversationPlanAction_idempotencyKey_key";
DROP INDEX "ConversationPlanAction_plan_sequence_key";
DROP INDEX "ConversationPlanAction_plan_actionKey_key";
DROP INDEX "ConversationPlanAction_status_created_idx";
DROP INDEX "ConversationPlanAction_task_status_idx";
DROP INDEX "ConversationPlanAction_step_idx";
DROP TABLE "ConversationPlanAction";

DROP INDEX "ConversationTurnPlan_conversation_message_revision_key";
DROP INDEX "ConversationTurnPlan_generationRun_revision_key";
DROP INDEX "ConversationTurnPlan_scopeKey_revision_key";
DROP INDEX "ConversationTurnPlan_representative_status_created_idx";
DROP INDEX "ConversationTurnPlan_conversation_status_created_idx";
DROP INDEX "ConversationTurnPlan_task_status_idx";
DROP INDEX "ConversationTurnPlan_supersedesPlanId_idx";
DROP INDEX "ConversationTurnPlan_requestHash_idx";
DROP INDEX "ConversationTurnPlan_planHash_idx";
DROP TABLE "ConversationTurnPlan";

DROP TYPE "ExecutionAttemptPhase";
DROP TYPE "BillableUnitStatus";
DROP TYPE "ConversationTurnPlanStatus";
DROP TYPE "ConversationPlanActionKind";
DROP TYPE "ConversationPlanActionStatus";
DROP TYPE "ConversationPlanSideEffectClass";
DROP TYPE "ActionAuthorizationPhase";

COMMIT;
