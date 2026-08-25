-- Persist structured turn plans, per-action authorization history, and channel
-- delivery attempts before the runtime begins consuming the new protocol.
-- Keep the schema expansion atomic: a failed index or foreign key must not
-- leave enum values or partially-created protocol tables behind.
BEGIN;

ALTER TYPE "WorkflowKind" ADD VALUE IF NOT EXISTS 'DELEGATION_EXECUTION';
ALTER TYPE "WorkflowEnginePhase" ADD VALUE IF NOT EXISTS 'WAITING_SIGNAL';
ALTER TYPE "WorkflowCommandType" ADD VALUE IF NOT EXISTS 'SIGNAL';

CREATE TYPE "ConversationTurnPlanStatus" AS ENUM (
  'PROPOSED',
  'VALIDATED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'SUPERSEDED'
);

CREATE TYPE "ConversationPlanActionKind" AS ENUM (
  'RESPOND',
  'CLARIFY',
  'CAPABILITY',
  'HANDOFF',
  'REFUSE',
  'DELIVER'
);

CREATE TYPE "ConversationPlanActionStatus" AS ENUM (
  'PLANNED',
  'AUTHORIZING',
  'WAITING_APPROVAL',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "ConversationPlanSideEffectClass" AS ENUM (
  'NONE',
  'INTERNAL',
  'EXTERNAL_REVERSIBLE',
  'EXTERNAL_IRREVERSIBLE'
);

CREATE TYPE "ActionAuthorizationPhase" AS ENUM (
  'INITIAL',
  'POST_APPROVAL',
  'PRE_EXECUTION'
);

CREATE TYPE "MessageDeliveryAttemptStatus" AS ENUM (
  'QUEUED',
  'PROCESSING',
  'PROVIDER_ACCEPTED',
  'CONFIRMED',
  'FAILED',
  'CANCELED',
  'DEAD_LETTER'
);

CREATE TABLE "ConversationTurnPlan" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "representativeVersionId" TEXT,
  "conversationId" TEXT NOT NULL,
  "generationRunId" TEXT,
  "inputMessageId" TEXT NOT NULL,
  "delegationTaskId" TEXT,
  "supersedesPlanId" TEXT,
  "schemaVersion" TEXT NOT NULL DEFAULT 'turn-plan.v2',
  "promptVersion" TEXT NOT NULL,
  "capabilityCatalogHash" CHAR(64) NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "ConversationTurnPlanStatus" NOT NULL DEFAULT 'PROPOSED',
  "mode" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "language" TEXT,
  "requestHash" CHAR(64) NOT NULL,
  "plannerProvider" TEXT,
  "plannerModel" TEXT,
  "planSnapshot" JSONB NOT NULL,
  "completionCriteria" JSONB,
  "validationResult" JSONB,
  "shadowMode" BOOLEAN NOT NULL DEFAULT true,
  "validatedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationTurnPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationPlanAction" (
  "id" TEXT NOT NULL,
  "turnPlanId" TEXT NOT NULL,
  "delegationTaskId" TEXT,
  "delegationTaskStepId" TEXT,
  "sequence" INTEGER NOT NULL,
  "actionKey" TEXT NOT NULL,
  "kind" "ConversationPlanActionKind" NOT NULL,
  "capability" "CapabilityKind",
  "capabilityKey" TEXT NOT NULL,
  "capabilityVersion" TEXT NOT NULL,
  "capabilityDefinitionHash" CHAR(64) NOT NULL,
  "sideEffectClass" "ConversationPlanSideEffectClass" NOT NULL DEFAULT 'NONE',
  "status" "ConversationPlanActionStatus" NOT NULL DEFAULT 'PLANNED',
  "arguments" JSONB NOT NULL,
  "argumentsHash" CHAR(64) NOT NULL,
  "argumentProvenance" JSONB NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "expectedOutput" JSONB,
  "expectedOutputSchema" JSONB NOT NULL,
  "completionCriteria" JSONB,
  "onFailure" TEXT NOT NULL,
  "dependsOnActionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "idempotencyKey" TEXT NOT NULL,
  "requestPayloadHash" CHAR(64),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationPlanAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActionAuthorizationDecision" (
  "id" TEXT NOT NULL,
  "planActionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "phase" "ActionAuthorizationPhase" NOT NULL,
  "decision" "PolicyDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "policySnapshot" JSONB,
  "policySnapshotHash" CHAR(64),
  "requestPayloadHash" CHAR(64),
  "matchedRuleId" TEXT,
  "evaluatedBy" TEXT NOT NULL DEFAULT 'policy-engine',
  "validUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionAuthorizationDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageDeliveryAttempt" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "channelBindingId" TEXT,
  "planActionId" TEXT,
  "attemptNumber" INTEGER NOT NULL,
  "status" "MessageDeliveryAttemptStatus" NOT NULL DEFAULT 'QUEUED',
  "transport" "ChannelTransport",
  "sourceProvider" "ChannelSourceProvider",
  "connectionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "externalMessageId" TEXT,
  "failureCode" TEXT,
  "failureReason" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkflowRun" ADD COLUMN "turnPlanId" TEXT;

CREATE UNIQUE INDEX "ConversationTurnPlan_conversation_message_revision_key"
  ON "ConversationTurnPlan"("conversationId", "inputMessageId", "revision");
CREATE UNIQUE INDEX "ConversationTurnPlan_generationRun_revision_key"
  ON "ConversationTurnPlan"("generationRunId", "revision");
CREATE INDEX "ConversationTurnPlan_representative_status_created_idx"
  ON "ConversationTurnPlan"("representativeId", "status", "createdAt");
CREATE INDEX "ConversationTurnPlan_conversation_status_created_idx"
  ON "ConversationTurnPlan"("conversationId", "status", "createdAt");
CREATE INDEX "ConversationTurnPlan_task_status_idx"
  ON "ConversationTurnPlan"("delegationTaskId", "status");
CREATE INDEX "ConversationTurnPlan_supersedesPlanId_idx"
  ON "ConversationTurnPlan"("supersedesPlanId");
CREATE INDEX "ConversationTurnPlan_requestHash_idx"
  ON "ConversationTurnPlan"("requestHash");
CREATE INDEX "ConversationTurnPlan_planHash_idx"
  ON "ConversationTurnPlan"("planHash");

CREATE UNIQUE INDEX "ConversationPlanAction_idempotencyKey_key"
  ON "ConversationPlanAction"("idempotencyKey");
CREATE UNIQUE INDEX "ConversationPlanAction_plan_sequence_key"
  ON "ConversationPlanAction"("turnPlanId", "sequence");
CREATE UNIQUE INDEX "ConversationPlanAction_plan_actionKey_key"
  ON "ConversationPlanAction"("turnPlanId", "actionKey");
CREATE INDEX "ConversationPlanAction_status_created_idx"
  ON "ConversationPlanAction"("status", "createdAt");
CREATE INDEX "ConversationPlanAction_task_status_idx"
  ON "ConversationPlanAction"("delegationTaskId", "status");
CREATE INDEX "ConversationPlanAction_step_idx"
  ON "ConversationPlanAction"("delegationTaskStepId");

CREATE UNIQUE INDEX "ActionAuthorizationDecision_action_sequence_key"
  ON "ActionAuthorizationDecision"("planActionId", "sequence");
CREATE INDEX "ActionAuthorizationDecision_action_phase_created_idx"
  ON "ActionAuthorizationDecision"("planActionId", "phase", "createdAt");
CREATE INDEX "ActionAuthorizationDecision_decision_created_idx"
  ON "ActionAuthorizationDecision"("decision", "createdAt");

CREATE UNIQUE INDEX "MessageDeliveryAttempt_idempotencyKey_key"
  ON "MessageDeliveryAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "MessageDeliveryAttempt_leaseToken_key"
  ON "MessageDeliveryAttempt"("leaseToken");
CREATE UNIQUE INDEX "MessageDeliveryAttempt_message_attempt_key"
  ON "MessageDeliveryAttempt"("messageId", "attemptNumber");
CREATE INDEX "MessageDeliveryAttempt_status_available_created_idx"
  ON "MessageDeliveryAttempt"("status", "availableAt", "createdAt");
CREATE INDEX "MessageDeliveryAttempt_conversation_status_created_idx"
  ON "MessageDeliveryAttempt"("conversationId", "status", "createdAt");
CREATE INDEX "MessageDeliveryAttempt_binding_status_created_idx"
  ON "MessageDeliveryAttempt"("channelBindingId", "status", "createdAt");
CREATE INDEX "MessageDeliveryAttempt_planAction_idx"
  ON "MessageDeliveryAttempt"("planActionId");
CREATE INDEX "WorkflowRun_turnPlanId_status_scheduledAt_idx"
  ON "WorkflowRun"("turnPlanId", "status", "scheduledAt");

ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_representativeVersionId_fkey"
  FOREIGN KEY ("representativeVersionId") REFERENCES "RepresentativeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_generationRunId_fkey"
  FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_inputMessageId_fkey"
  FOREIGN KEY ("inputMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_delegationTaskId_fkey"
  FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationTurnPlan"
  ADD CONSTRAINT "ConversationTurnPlan_supersedesPlanId_fkey"
  FOREIGN KEY ("supersedesPlanId") REFERENCES "ConversationTurnPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationPlanAction"
  ADD CONSTRAINT "ConversationPlanAction_turnPlanId_fkey"
  FOREIGN KEY ("turnPlanId") REFERENCES "ConversationTurnPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationPlanAction"
  ADD CONSTRAINT "ConversationPlanAction_delegationTaskId_fkey"
  FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationPlanAction"
  ADD CONSTRAINT "ConversationPlanAction_delegationTaskStepId_fkey"
  FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ActionAuthorizationDecision"
  ADD CONSTRAINT "ActionAuthorizationDecision_planActionId_fkey"
  FOREIGN KEY ("planActionId") REFERENCES "ConversationPlanAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageDeliveryAttempt"
  ADD CONSTRAINT "MessageDeliveryAttempt_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageDeliveryAttempt"
  ADD CONSTRAINT "MessageDeliveryAttempt_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageDeliveryAttempt"
  ADD CONSTRAINT "MessageDeliveryAttempt_channelBindingId_fkey"
  FOREIGN KEY ("channelBindingId") REFERENCES "ConversationChannelBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MessageDeliveryAttempt"
  ADD CONSTRAINT "MessageDeliveryAttempt_planActionId_fkey"
  FOREIGN KEY ("planActionId") REFERENCES "ConversationPlanAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_turnPlanId_fkey"
  FOREIGN KEY ("turnPlanId") REFERENCES "ConversationTurnPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
