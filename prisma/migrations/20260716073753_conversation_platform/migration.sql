-- CreateEnum
CREATE TYPE "RepresentativeLifecycleState" AS ENUM ('DRAFT', 'CONFIGURING', 'READY', 'PUBLISHED', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RepresentativeChannelKind" AS ENUM ('WEB', 'MATRIX', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ConversationEpisodeStatus" AS ENUM ('ACTIVE', 'WAITING_USER', 'NEEDS_HUMAN', 'HUMAN_ACTIVE', 'RESOLVED', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationParticipantKind" AS ENUM ('AUDIENCE', 'REPRESENTATIVE', 'OPERATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('AUDIENCE', 'REPRESENTATIVE', 'OPERATOR', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "MessageContentType" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'SYSTEM', 'TOOL_RESULT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('ACCEPTED', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELED', 'EDITED', 'REDACTED');

-- CreateEnum
CREATE TYPE "GenerationRunStatus" AS ENUM ('QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'WAITING_HUMAN', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ConversationAssignmentStatus" AS ENUM ('ACTIVE', 'RELEASED', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "ReliableEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

-- ExtendEnum
ALTER TYPE "EventType" ADD VALUE 'REPRESENTATIVE_VERSION_PUBLISHED';
ALTER TYPE "EventType" ADD VALUE 'REPRESENTATIVE_VERSION_ACTIVATED';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "externalUserId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "activeEpisodeId" TEXT,
ADD COLUMN     "assignedOperatorId" TEXT,
ADD COLUMN     "externalConversationId" TEXT,
ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Representative" ADD COLUMN     "activeVersionId" TEXT,
ADD COLUMN     "lifecycleState" "RepresentativeLifecycleState" NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "RepresentativeVersion" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepresentativeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimePolicyOverlay" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "payload" JSONB NOT NULL,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimePolicyOverlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeChannelBinding" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "kind" "RepresentativeChannelKind" NOT NULL,
    "externalUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "displayName" TEXT,
    "configuration" JSONB,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativeChannelBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEpisode" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "representativeVersionId" TEXT,
    "sequence" INTEGER NOT NULL,
    "status" "ConversationEpisodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "summary" TEXT,
    "resolutionReason" TEXT,
    "pricingSnapshot" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" "ConversationParticipantKind" NOT NULL,
    "participantId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationChannelBinding" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "representativeBindingId" TEXT,
    "kind" "RepresentativeChannelKind" NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "externalThreadId" TEXT,
    "syncCursor" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationChannelBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "episodeId" TEXT,
    "channelBindingId" TEXT,
    "senderType" "MessageSenderType" NOT NULL,
    "senderId" TEXT,
    "senderDisplayName" TEXT,
    "contentType" "MessageContentType" NOT NULL DEFAULT 'TEXT',
    "text" TEXT,
    "content" JSONB,
    "clientMessageId" TEXT,
    "externalMessageId" TEXT,
    "replyToMessageId" TEXT,
    "threadRootMessageId" TEXT,
    "deliveryStatus" "MessageDeliveryStatus" NOT NULL DEFAULT 'ACCEPTED',
    "failureCode" TEXT,
    "failureReason" TEXT,
    "editedAt" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),
    "redactionReason" TEXT,
    "retentionExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRevision" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT,
    "content" JSONB,
    "editedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "objectKey" TEXT,
    "externalUrl" TEXT,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCitation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "knowledgeAssetId" TEXT,
    "knowledgeRevision" TEXT,
    "title" TEXT NOT NULL,
    "uri" TEXT,
    "excerpt" TEXT,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "episodeId" TEXT,
    "inputMessageId" TEXT NOT NULL,
    "outputMessageId" TEXT,
    "representativeVersionId" TEXT,
    "status" "GenerationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "contextSnapshot" JSONB,
    "runtimePolicySnapshot" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costCents" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationAssignment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "episodeId" TEXT,
    "operatorId" TEXT NOT NULL,
    "operatorName" TEXT NOT NULL,
    "status" "ConversationAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "ConversationAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationStateTransition" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "reason" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelEventInbox" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" "RepresentativeChannelKind" NOT NULL,
    "transactionId" TEXT,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ReliableEventStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelEventInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ReliableEventStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatrixVirtualUserBinding" (
    "id" TEXT NOT NULL,
    "matrixUserId" TEXT NOT NULL,
    "representativeId" TEXT,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatrixVirtualUserBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepresentativeVersion_representativeId_publishedAt_idx" ON "RepresentativeVersion"("representativeId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeVersion_representativeId_versionNumber_key" ON "RepresentativeVersion"("representativeId", "versionNumber");

-- CreateIndex
CREATE INDEX "RuntimePolicyOverlay_representativeId_enabled_priority_idx" ON "RuntimePolicyOverlay"("representativeId", "enabled", "priority");

-- CreateIndex
CREATE INDEX "RuntimePolicyOverlay_expiresAt_idx" ON "RuntimePolicyOverlay"("expiresAt");

-- CreateIndex
CREATE INDEX "RepresentativeChannelBinding_kind_status_updatedAt_idx" ON "RepresentativeChannelBinding"("kind", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeChannelBinding_representativeId_kind_key" ON "RepresentativeChannelBinding"("representativeId", "kind");

-- CreateIndex
CREATE INDEX "ConversationEpisode_conversationId_status_startedAt_idx" ON "ConversationEpisode"("conversationId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "ConversationEpisode_representativeVersionId_idx" ON "ConversationEpisode"("representativeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationEpisode_conversationId_sequence_key" ON "ConversationEpisode"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "ConversationParticipant_conversationId_joinedAt_idx" ON "ConversationParticipant"("conversationId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_kind_participantId_key" ON "ConversationParticipant"("conversationId", "kind", "participantId");

-- CreateIndex
CREATE INDEX "ConversationChannelBinding_conversationId_kind_idx" ON "ConversationChannelBinding"("conversationId", "kind");

-- CreateIndex
CREATE INDEX "ConversationChannelBinding_representativeBindingId_idx" ON "ConversationChannelBinding"("representativeBindingId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationChannelBinding_kind_externalConversationId_exte_key" ON "ConversationChannelBinding"("kind", "externalConversationId", "externalThreadId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_deliveryStatus_createdAt_idx" ON "Message"("conversationId", "deliveryStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Message_episodeId_createdAt_idx" ON "Message"("episodeId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_retentionExpiresAt_idx" ON "Message"("retentionExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_clientMessageId_key" ON "Message"("conversationId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelBindingId_externalMessageId_key" ON "Message"("channelBindingId", "externalMessageId");

-- CreateIndex
CREATE INDEX "MessageRevision_messageId_createdAt_idx" ON "MessageRevision"("messageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRevision_messageId_version_key" ON "MessageRevision"("messageId", "version");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_createdAt_idx" ON "MessageAttachment"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageCitation_messageId_createdAt_idx" ON "MessageCitation"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageCitation_knowledgeAssetId_idx" ON "MessageCitation"("knowledgeAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRun_idempotencyKey_key" ON "GenerationRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GenerationRun_conversationId_status_queuedAt_idx" ON "GenerationRun"("conversationId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "GenerationRun_episodeId_queuedAt_idx" ON "GenerationRun"("episodeId", "queuedAt");

-- CreateIndex
CREATE INDEX "ConversationAssignment_conversationId_status_assignedAt_idx" ON "ConversationAssignment"("conversationId", "status", "assignedAt");

-- CreateIndex
CREATE INDEX "ConversationAssignment_operatorId_status_assignedAt_idx" ON "ConversationAssignment"("operatorId", "status", "assignedAt");

-- CreateIndex
CREATE INDEX "ConversationStateTransition_conversationId_createdAt_idx" ON "ConversationStateTransition"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelEventInbox_status_availableAt_createdAt_idx" ON "ChannelEventInbox"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelEventInbox_transactionId_idx" ON "ChannelEventInbox"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelEventInbox_kind_externalEventId_key" ON "ChannelEventInbox"("kind", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_createdAt_idx" ON "OutboxEvent"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MatrixVirtualUserBinding_matrixUserId_key" ON "MatrixVirtualUserBinding"("matrixUserId");

-- CreateIndex
CREATE INDEX "MatrixVirtualUserBinding_representativeId_enabled_idx" ON "MatrixVirtualUserBinding"("representativeId", "enabled");

-- CreateIndex
CREATE INDEX "MatrixVirtualUserBinding_ownerId_enabled_idx" ON "MatrixVirtualUserBinding"("ownerId", "enabled");

-- CreateIndex
CREATE INDEX "Conversation_representativeId_state_lastMessageAt_idx" ON "Conversation"("representativeId", "state", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_representativeId_assignedOperatorId_lastMessag_idx" ON "Conversation"("representativeId", "assignedOperatorId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_representativeId_sourceChannel_externalConvers_idx" ON "Conversation"("representativeId", "sourceChannel", "externalConversationId");

-- CreateIndex
CREATE INDEX "Representative_ownerId_lifecycleState_updatedAt_idx" ON "Representative"("ownerId", "lifecycleState", "updatedAt");

-- CreateIndex
CREATE INDEX "Representative_activeVersionId_idx" ON "Representative"("activeVersionId");

-- AddForeignKey
ALTER TABLE "Representative" ADD CONSTRAINT "Representative_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "RepresentativeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeVersion" ADD CONSTRAINT "RepresentativeVersion_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimePolicyOverlay" ADD CONSTRAINT "RuntimePolicyOverlay_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeChannelBinding" ADD CONSTRAINT "RepresentativeChannelBinding_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEpisode" ADD CONSTRAINT "ConversationEpisode_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEpisode" ADD CONSTRAINT "ConversationEpisode_representativeVersionId_fkey" FOREIGN KEY ("representativeVersionId") REFERENCES "RepresentativeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationChannelBinding" ADD CONSTRAINT "ConversationChannelBinding_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationChannelBinding" ADD CONSTRAINT "ConversationChannelBinding_representativeBindingId_fkey" FOREIGN KEY ("representativeBindingId") REFERENCES "RepresentativeChannelBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelBindingId_fkey" FOREIGN KEY ("channelBindingId") REFERENCES "ConversationChannelBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadRootMessageId_fkey" FOREIGN KEY ("threadRootMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRevision" ADD CONSTRAINT "MessageRevision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_inputMessageId_fkey" FOREIGN KEY ("inputMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_outputMessageId_fkey" FOREIGN KEY ("outputMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_representativeVersionId_fkey" FOREIGN KEY ("representativeVersionId") REFERENCES "RepresentativeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAssignment" ADD CONSTRAINT "ConversationAssignment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAssignment" ADD CONSTRAINT "ConversationAssignment_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationStateTransition" ADD CONSTRAINT "ConversationStateTransition_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelEventInbox" ADD CONSTRAINT "ChannelEventInbox_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatrixVirtualUserBinding" ADD CONSTRAINT "MatrixVirtualUserBinding_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatrixVirtualUserBinding" ADD CONSTRAINT "MatrixVirtualUserBinding_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
