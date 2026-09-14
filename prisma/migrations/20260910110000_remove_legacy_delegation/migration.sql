BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DelegationTask"
    WHERE "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED')
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: active DelegationTask rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "GenerationRun"
    WHERE "delegationTaskId" IS NOT NULL
      AND "status" IN ('QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'WAITING_HUMAN')
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: active delegated GenerationRun rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "WorkflowRun"
    WHERE ("delegationTaskId" IS NOT NULL OR "kind" = 'DELEGATION_EXECUTION')
      AND "status" IN ('QUEUED', 'RUNNING')
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: active delegated WorkflowRun rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ApprovalRequest"
    WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
      AND "status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: pending delegated ApprovalRequest rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ToolExecution"
    WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
      AND "status" IN ('QUEUED', 'RUNNING', 'BLOCKED')
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: active task-owned ToolExecution rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ComputeSession"
    WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
      AND "endedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: active task-owned ComputeSession rows remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "DelegationTaskExternalEffect"
    WHERE "status" IN ('PROPOSED', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'RECONCILIATION_REQUIRED')
  ) THEN
    RAISE EXCEPTION 'legacy delegation removal blocked: unresolved external-effect rows remain';
  END IF;
END $$;

-- Terminal legacy workflow history has no Pi runtime consumer. Its command
-- outbox rows are removed by the existing WorkflowRun foreign-key action.
DELETE FROM "WorkflowRun" WHERE "kind" = 'DELEGATION_EXECUTION';

ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_delegationTaskId_fkey", DROP CONSTRAINT "ApprovalRequest_delegationTaskStepId_fkey";
ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_delegationTaskId_fkey", DROP CONSTRAINT "Artifact_delegationTaskStepId_fkey";
ALTER TABLE "ComputeSession" DROP CONSTRAINT "ComputeSession_delegationTaskId_fkey", DROP CONSTRAINT "ComputeSession_delegationTaskStepId_fkey";
ALTER TABLE "Deliverable" DROP CONSTRAINT "Deliverable_delegationTaskId_fkey";
ALTER TABLE "EventAudit" DROP CONSTRAINT "EventAudit_delegationTaskId_fkey";
ALTER TABLE "GenerationRun" DROP CONSTRAINT "GenerationRun_delegationTaskId_fkey", DROP CONSTRAINT "GenerationRun_delegationTaskStepId_fkey";
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_delegationTaskId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_delegationTaskId_fkey";
ALTER TABLE "ToolExecution" DROP CONSTRAINT "ToolExecution_delegationTaskId_fkey", DROP CONSTRAINT "ToolExecution_delegationTaskStepId_fkey", DROP CONSTRAINT "ToolExecution_externalEffectId_fkey";
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_delegationTaskId_fkey", DROP CONSTRAINT "WorkflowRun_delegationTaskStepId_fkey";

DROP INDEX "ApprovalRequest_delegationTaskId_status_requestedAt_idx";
DROP INDEX "ApprovalRequest_delegationTaskStepId_idx";
DROP INDEX "Artifact_delegationTaskId_createdAt_idx";
DROP INDEX "Artifact_delegationTaskStepId_idx";
DROP INDEX "ComputeSession_delegationTaskId_status_createdAt_idx";
DROP INDEX "ComputeSession_delegationTaskStepId_idx";
DROP INDEX "Deliverable_delegationTaskId_createdAt_idx";
DROP INDEX "EventAudit_delegationTaskId_createdAt_idx";
DROP INDEX "GenerationRun_delegationTaskId_status_queuedAt_idx";
DROP INDEX "GenerationRun_delegationTaskStepId_idx";
DROP INDEX "LedgerEntry_delegationTaskId_createdAt_idx";
DROP INDEX "Message_delegationTaskId_createdAt_idx";
DROP INDEX "ToolExecution_delegationTaskId_status_createdAt_idx";
DROP INDEX "ToolExecution_delegationTaskStepId_idx";
DROP INDEX "ToolExecution_externalEffectId_key";
DROP INDEX "WorkflowRun_delegationTaskId_status_scheduledAt_idx";
DROP INDEX "WorkflowRun_delegationTaskStepId_idx";

ALTER TABLE "ApprovalRequest" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId";
ALTER TABLE "Artifact" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId";
ALTER TABLE "ComputeSession" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId";
ALTER TABLE "Deliverable" DROP COLUMN "delegationTaskId";
ALTER TABLE "EventAudit" DROP COLUMN "delegationTaskId";
ALTER TABLE "GenerationRun" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId";
ALTER TABLE "LedgerEntry" DROP COLUMN "delegationTaskId";
ALTER TABLE "Message" DROP COLUMN "delegationTaskId";
ALTER TABLE "ToolExecution" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId", DROP COLUMN "externalEffectId";
ALTER TABLE "WorkflowRun" DROP COLUMN "delegationTaskId", DROP COLUMN "delegationTaskStepId";
ALTER TABLE "Representative"
  DROP COLUMN "delegationEnabled",
  DROP COLUMN "delegationNaturalLanguageEnabled",
  DROP COLUMN "delegationExplicitComputeEnabled",
  DROP COLUMN "delegationMaxSteps",
  DROP COLUMN "delegationMaxEstimatedTokens",
  DROP COLUMN "delegationKnowledgeScope";

DROP INDEX "DelegationTaskDataGrant_delegationTaskId_status_createdAt_idx";
DROP INDEX "DelegationTaskDataGrant_resourceType_resourceId_status_idx";
DROP INDEX "DelegationTaskDataGrant_taskInputId_idx";
DROP TABLE "DelegationTaskDataGrant";

DROP INDEX "DelegationTaskOutput_artifactId_idx";
DROP INDEX "DelegationTaskOutput_delegationTaskId_isFinal_createdAt_idx";
DROP INDEX "DelegationTaskOutput_delegationTaskStepId_idx";
DROP INDEX "DelegationTaskOutput_deliverableId_idx";
DROP INDEX "DelegationTaskOutput_externalEffectId_key";
DROP TABLE "DelegationTaskOutput";

DROP INDEX "DelegationTaskEvent_delegationTaskId_occurredAt_idx";
DROP INDEX "DelegationTaskEvent_delegationTaskId_sequence_key";
DROP INDEX "DelegationTaskEvent_eventType_occurredAt_idx";
DROP TABLE "DelegationTaskEvent";

DROP INDEX "DelegationTaskResourcePolicy_delegationTaskId_key";
DROP TABLE "DelegationTaskResourcePolicy";

DROP INDEX "DelegationTaskExternalEffect_approvalRequestId_key";
DROP INDEX "DelegationTaskExternalEffect_callAttemptId_idx";
DROP INDEX "DelegationTaskExternalEffect_delegationTaskId_status_create_idx";
DROP INDEX "DelegationTaskExternalEffect_delegationTaskStepId_idx";
DROP INDEX "DelegationTaskExternalEffect_externalReferenceId_idx";
DROP INDEX "DelegationTaskExternalEffect_idempotencyKey_key";
DROP TABLE "DelegationTaskExternalEffect";

DROP INDEX "DelegationTaskStep_delegationTaskId_sequence_key";
DROP INDEX "DelegationTaskStep_delegationTaskId_status_sequence_idx";
DROP INDEX "DelegationTaskStep_idempotencyKey_key";
DROP TABLE "DelegationTaskStep";

DROP INDEX "DelegationTaskInput_delegationTaskId_createdAt_idx";
DROP INDEX "DelegationTaskInput_referenceType_referenceId_idx";
DROP TABLE "DelegationTaskInput";

DROP INDEX "DelegationTask_audienceIdentityId_status_updatedAt_idx";
DROP INDEX "DelegationTask_contactId_status_updatedAt_idx";
DROP INDEX "DelegationTask_deadlineAt_status_idx";
DROP INDEX "DelegationTask_idempotencyKey_key";
DROP INDEX "DelegationTask_nextActionBy_status_updatedAt_idx";
DROP INDEX "DelegationTask_originConversationId_createdAt_idx";
DROP INDEX "DelegationTask_representativeId_status_updatedAt_idx";
DROP TABLE "DelegationTask";

DROP TYPE "DelegationTaskKind";
DROP TYPE "DelegationTaskInitiatorType";
DROP TYPE "DelegationTaskActorType";
DROP TYPE "DelegationTaskStatus";
DROP TYPE "DelegationTaskNextActor";
DROP TYPE "DelegationTaskStepKind";
DROP TYPE "DelegationTaskStepStatus";
DROP TYPE "DelegationTaskInputKind";
DROP TYPE "DelegationDataGrantStatus";
DROP TYPE "DelegationExternalEffectStatus";
DROP TYPE "DelegationTaskOutputKind";
DROP TYPE "DelegationKnowledgeScope";

ALTER TYPE "WorkflowKind" RENAME TO "WorkflowKind_legacy_delegation";
CREATE TYPE "WorkflowKind" AS ENUM (
  'HANDOFF_FOLLOW_UP',
  'APPROVAL_EXPIRATION',
  'CREATOR_TRAINING_REVIEW'
);
ALTER TABLE "WorkflowRun"
  ALTER COLUMN "kind" TYPE "WorkflowKind"
  USING ("kind"::text::"WorkflowKind");
DROP TYPE "WorkflowKind_legacy_delegation";

COMMIT;
