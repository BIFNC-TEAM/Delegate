-- CreateEnum
CREATE TYPE "DelegationTaskKind" AS ENUM ('SERVICE_REQUEST', 'COMPUTE', 'BROWSER', 'MCP', 'WORKFLOW', 'EXTERNAL_ACTION');

-- CreateEnum
CREATE TYPE "DelegationTaskInitiatorType" AS ENUM ('AUDIENCE', 'OWNER', 'OPERATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DelegationTaskActorType" AS ENUM ('AUDIENCE', 'OWNER', 'OPERATOR', 'REPRESENTATIVE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DelegationTaskStatus" AS ENUM ('DRAFT', 'CLARIFYING', 'READY', 'AWAITING_APPROVAL', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'WAITING_FOR_OWNER', 'COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DelegationTaskNextActor" AS ENUM ('AUDIENCE', 'OWNER', 'OPERATOR', 'SYSTEM', 'NONE');

-- CreateEnum
CREATE TYPE "DelegationTaskStepKind" AS ENUM ('CLARIFICATION', 'PLAN', 'MODEL', 'COMPUTE', 'MCP', 'WORKFLOW', 'HUMAN_REVIEW', 'DELIVERY', 'EXTERNAL_ACTION');

-- CreateEnum
CREATE TYPE "DelegationTaskStepStatus" AS ENUM ('DRAFT', 'READY', 'WAITING_APPROVAL', 'QUEUED', 'RUNNING', 'WAITING_INPUT', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DelegationTaskInputKind" AS ENUM ('MESSAGE', 'MESSAGE_ATTACHMENT', 'KNOWLEDGE_ASSET', 'ARTIFACT', 'EXTERNAL_REFERENCE', 'STRUCTURED_DATA');

-- CreateEnum
CREATE TYPE "DelegationDataGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DelegationExternalEffectStatus" AS ENUM ('PROPOSED', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "DelegationTaskOutputKind" AS ENUM ('ARTIFACT', 'DELIVERABLE', 'EXTERNAL_EFFECT', 'SUMMARY');

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- AlterTable
ALTER TABLE "ComputeSession" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- AlterTable
ALTER TABLE "Deliverable" ADD COLUMN     "delegationTaskId" TEXT;

-- AlterTable
ALTER TABLE "EventAudit" ADD COLUMN     "delegationTaskId" TEXT;

-- AlterTable
ALTER TABLE "GenerationRun" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "delegationTaskId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "delegationTaskId" TEXT;

-- AlterTable
ALTER TABLE "ToolExecution" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "delegationTaskId" TEXT,
ADD COLUMN     "delegationTaskStepId" TEXT;

-- CreateTable
CREATE TABLE "DelegationTask" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "representativeVersionId" TEXT,
    "contactId" TEXT,
    "audienceIdentityId" TEXT,
    "originConversationId" TEXT,
    "originEpisodeId" TEXT,
    "kind" "DelegationTaskKind" NOT NULL DEFAULT 'SERVICE_REQUEST',
    "initiatorType" "DelegationTaskInitiatorType" NOT NULL,
    "initiatorId" TEXT,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "desiredOutcome" TEXT NOT NULL,
    "status" "DelegationTaskStatus" NOT NULL DEFAULT 'DRAFT',
    "nextActionBy" "DelegationTaskNextActor" NOT NULL DEFAULT 'SYSTEM',
    "blockingReason" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "planSummary" TEXT,
    "acceptanceCriteria" JSONB,
    "contextSnapshot" JSONB,
    "deadlineAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskInput" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "kind" "DelegationTaskInputKind" NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT,
    "label" TEXT NOT NULL,
    "mimeType" TEXT,
    "sha256" TEXT,
    "providedByType" "DelegationTaskActorType" NOT NULL,
    "providedById" TEXT,
    "authorizationRequired" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelegationTaskInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskDataGrant" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "taskInputId" TEXT,
    "grantorType" "DelegationTaskActorType" NOT NULL,
    "grantorId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purpose" TEXT NOT NULL,
    "status" "DelegationDataGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "policySnapshot" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationTaskDataGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskResourcePolicy" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "maxDurationMinutes" INTEGER NOT NULL DEFAULT 15,
    "maxCostCents" INTEGER,
    "maxCredits" INTEGER,
    "maxComputeMinutes" INTEGER,
    "maxToolCalls" INTEGER NOT NULL DEFAULT 1,
    "maxSteps" INTEGER NOT NULL DEFAULT 1,
    "maxArtifactBytes" INTEGER,
    "allowedCapabilities" "CapabilityKind"[] DEFAULT ARRAY[]::"CapabilityKind"[],
    "allowedSkillSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedMcpBindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedExternalAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "networkMode" "ComputeNetworkMode" NOT NULL DEFAULT 'NO_NETWORK',
    "filesystemMode" "ComputeFilesystemMode" NOT NULL DEFAULT 'WORKSPACE_ONLY',
    "requireApprovalForExternalSideEffects" BOOLEAN NOT NULL DEFAULT true,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationTaskResourcePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskStep" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "DelegationTaskStepKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "DelegationTaskStepStatus" NOT NULL DEFAULT 'DRAFT',
    "capability" "CapabilityKind",
    "skillSlug" TEXT,
    "mcpBindingId" TEXT,
    "externalAccountId" TEXT,
    "dependsOnStepIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "maxCostCents" INTEGER,
    "maxDurationSeconds" INTEGER,
    "inputSnapshot" JSONB,
    "outputSnapshot" JSONB,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationTaskStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskExternalEffect" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "delegationTaskStepId" TEXT,
    "approvalRequestId" TEXT,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "DelegationExternalEffectStatus" NOT NULL DEFAULT 'PROPOSED',
    "idempotencyKey" TEXT NOT NULL,
    "requestPayload" JSONB,
    "responseSnapshot" JSONB,
    "externalReferenceId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationTaskExternalEffect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskOutput" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "delegationTaskStepId" TEXT,
    "kind" "DelegationTaskOutputKind" NOT NULL,
    "artifactId" TEXT,
    "deliverableId" TEXT,
    "externalEffectId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelegationTaskOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationTaskEvent" (
    "id" TEXT NOT NULL,
    "delegationTaskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" "DelegationTaskActorType" NOT NULL,
    "actorId" TEXT,
    "fromStatus" "DelegationTaskStatus",
    "toStatus" "DelegationTaskStatus",
    "payload" JSONB,
    "previousHash" TEXT,
    "eventHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelegationTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTask_idempotencyKey_key" ON "DelegationTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DelegationTask_representativeId_status_updatedAt_idx" ON "DelegationTask"("representativeId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DelegationTask_contactId_status_updatedAt_idx" ON "DelegationTask"("contactId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DelegationTask_audienceIdentityId_status_updatedAt_idx" ON "DelegationTask"("audienceIdentityId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DelegationTask_originConversationId_createdAt_idx" ON "DelegationTask"("originConversationId", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationTask_nextActionBy_status_updatedAt_idx" ON "DelegationTask"("nextActionBy", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DelegationTask_deadlineAt_status_idx" ON "DelegationTask"("deadlineAt", "status");

-- CreateIndex
CREATE INDEX "DelegationTaskInput_delegationTaskId_createdAt_idx" ON "DelegationTaskInput"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationTaskInput_referenceType_referenceId_idx" ON "DelegationTaskInput"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "DelegationTaskDataGrant_delegationTaskId_status_createdAt_idx" ON "DelegationTaskDataGrant"("delegationTaskId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationTaskDataGrant_resourceType_resourceId_status_idx" ON "DelegationTaskDataGrant"("resourceType", "resourceId", "status");

-- CreateIndex
CREATE INDEX "DelegationTaskDataGrant_taskInputId_idx" ON "DelegationTaskDataGrant"("taskInputId");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskResourcePolicy_delegationTaskId_key" ON "DelegationTaskResourcePolicy"("delegationTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskStep_idempotencyKey_key" ON "DelegationTaskStep"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DelegationTaskStep_delegationTaskId_status_sequence_idx" ON "DelegationTaskStep"("delegationTaskId", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskStep_delegationTaskId_sequence_key" ON "DelegationTaskStep"("delegationTaskId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskExternalEffect_approvalRequestId_key" ON "DelegationTaskExternalEffect"("approvalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskExternalEffect_idempotencyKey_key" ON "DelegationTaskExternalEffect"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DelegationTaskExternalEffect_delegationTaskId_status_create_idx" ON "DelegationTaskExternalEffect"("delegationTaskId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationTaskExternalEffect_delegationTaskStepId_idx" ON "DelegationTaskExternalEffect"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "DelegationTaskExternalEffect_externalReferenceId_idx" ON "DelegationTaskExternalEffect"("externalReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskOutput_externalEffectId_key" ON "DelegationTaskOutput"("externalEffectId");

-- CreateIndex
CREATE INDEX "DelegationTaskOutput_delegationTaskId_isFinal_createdAt_idx" ON "DelegationTaskOutput"("delegationTaskId", "isFinal", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationTaskOutput_delegationTaskStepId_idx" ON "DelegationTaskOutput"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "DelegationTaskOutput_artifactId_idx" ON "DelegationTaskOutput"("artifactId");

-- CreateIndex
CREATE INDEX "DelegationTaskOutput_deliverableId_idx" ON "DelegationTaskOutput"("deliverableId");

-- CreateIndex
CREATE INDEX "DelegationTaskEvent_delegationTaskId_occurredAt_idx" ON "DelegationTaskEvent"("delegationTaskId", "occurredAt");

-- CreateIndex
CREATE INDEX "DelegationTaskEvent_eventType_occurredAt_idx" ON "DelegationTaskEvent"("eventType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationTaskEvent_delegationTaskId_sequence_key" ON "DelegationTaskEvent"("delegationTaskId", "sequence");

-- CreateIndex
CREATE INDEX "ApprovalRequest_delegationTaskId_status_requestedAt_idx" ON "ApprovalRequest"("delegationTaskId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_delegationTaskStepId_idx" ON "ApprovalRequest"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "Artifact_delegationTaskId_createdAt_idx" ON "Artifact"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_delegationTaskStepId_idx" ON "Artifact"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "ComputeSession_delegationTaskId_status_createdAt_idx" ON "ComputeSession"("delegationTaskId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ComputeSession_delegationTaskStepId_idx" ON "ComputeSession"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "Deliverable_delegationTaskId_createdAt_idx" ON "Deliverable"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "EventAudit_delegationTaskId_createdAt_idx" ON "EventAudit"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationRun_delegationTaskId_status_queuedAt_idx" ON "GenerationRun"("delegationTaskId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "GenerationRun_delegationTaskStepId_idx" ON "GenerationRun"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "LedgerEntry_delegationTaskId_createdAt_idx" ON "LedgerEntry"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_delegationTaskId_createdAt_idx" ON "Message"("delegationTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_delegationTaskId_status_createdAt_idx" ON "ToolExecution"("delegationTaskId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_delegationTaskStepId_idx" ON "ToolExecution"("delegationTaskStepId");

-- CreateIndex
CREATE INDEX "WorkflowRun_delegationTaskId_status_scheduledAt_idx" ON "WorkflowRun"("delegationTaskId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_delegationTaskStepId_idx" ON "WorkflowRun"("delegationTaskStepId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAudit" ADD CONSTRAINT "EventAudit_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeSession" ADD CONSTRAINT "ComputeSession_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeSession" ADD CONSTRAINT "ComputeSession_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_representativeVersionId_fkey" FOREIGN KEY ("representativeVersionId") REFERENCES "RepresentativeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_originConversationId_fkey" FOREIGN KEY ("originConversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTask" ADD CONSTRAINT "DelegationTask_originEpisodeId_fkey" FOREIGN KEY ("originEpisodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskInput" ADD CONSTRAINT "DelegationTaskInput_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskDataGrant" ADD CONSTRAINT "DelegationTaskDataGrant_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskDataGrant" ADD CONSTRAINT "DelegationTaskDataGrant_taskInputId_fkey" FOREIGN KEY ("taskInputId") REFERENCES "DelegationTaskInput"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskResourcePolicy" ADD CONSTRAINT "DelegationTaskResourcePolicy_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskStep" ADD CONSTRAINT "DelegationTaskStep_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskExternalEffect" ADD CONSTRAINT "DelegationTaskExternalEffect_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskExternalEffect" ADD CONSTRAINT "DelegationTaskExternalEffect_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskExternalEffect" ADD CONSTRAINT "DelegationTaskExternalEffect_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskOutput" ADD CONSTRAINT "DelegationTaskOutput_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskOutput" ADD CONSTRAINT "DelegationTaskOutput_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskOutput" ADD CONSTRAINT "DelegationTaskOutput_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskOutput" ADD CONSTRAINT "DelegationTaskOutput_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "Deliverable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskOutput" ADD CONSTRAINT "DelegationTaskOutput_externalEffectId_fkey" FOREIGN KEY ("externalEffectId") REFERENCES "DelegationTaskExternalEffect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationTaskEvent" ADD CONSTRAINT "DelegationTaskEvent_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_delegationTaskStepId_fkey" FOREIGN KEY ("delegationTaskStepId") REFERENCES "DelegationTaskStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_delegationTaskId_fkey" FOREIGN KEY ("delegationTaskId") REFERENCES "DelegationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "KnowledgeAssetRepresentative_representativeId_enabled_updatedAt" RENAME TO "KnowledgeAssetRepresentative_representativeId_enabled_updat_idx";
