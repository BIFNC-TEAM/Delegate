-- CreateEnum
CREATE TYPE "CreatorTrainingSourceKind" AS ENUM ('URL', 'PDF', 'TEXT', 'NOTION', 'DRIVE', 'WEBSITE');

-- AlterEnum
ALTER TYPE "WorkflowKind" ADD VALUE 'CREATOR_TRAINING_REVIEW';

-- CreateEnum
CREATE TYPE "CreatorTrainingSourceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreatorFeedbackSignalType" AS ENUM ('APPROVE', 'CORRECTION', 'DO_NOT_SAY', 'SUGGESTED_ANSWER');

-- CreateEnum
CREATE TYPE "CreatorTrainingSuggestionType" AS ENUM ('FAQ_UPDATE', 'POLICY_UPDATE', 'MATERIAL_UPDATE', 'TONE_RULE', 'SKILL_RECOMMENDATION', 'KNOWLEDGE_GAP');

-- CreateEnum
CREATE TYPE "CreatorTrainingSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PRIVATE', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "CreatorTrainingVersionStatus" AS ENUM ('PUBLISHED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "CreatorTrainingSource" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "kind" "CreatorTrainingSourceKind" NOT NULL,
    "status" "CreatorTrainingSourceStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "locator" TEXT,
    "contentText" TEXT,
    "metadata" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTrainingSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFeedbackSignal" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "turnId" TEXT,
    "signalType" "CreatorFeedbackSignalType" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "publicSafe" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "suggestedText" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFeedbackSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorTrainingSuggestion" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "sourceId" TEXT,
    "feedbackSignalId" TEXT,
    "suggestionType" "CreatorTrainingSuggestionType" NOT NULL,
    "status" "CreatorTrainingSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "draftPayload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTrainingSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorTrainingVersion" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "suggestionId" TEXT,
    "status" "CreatorTrainingVersionStatus" NOT NULL DEFAULT 'PUBLISHED',
    "title" TEXT NOT NULL,
    "snapshotBefore" JSONB NOT NULL,
    "snapshotAfter" JSONB NOT NULL,
    "evaluationReport" JSONB,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorTrainingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreatorTrainingSource_representativeId_status_updatedAt_idx" ON "CreatorTrainingSource"("representativeId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "CreatorTrainingSource_representativeId_kind_createdAt_idx" ON "CreatorTrainingSource"("representativeId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorFeedbackSignal_representativeId_status_createdAt_idx" ON "CreatorFeedbackSignal"("representativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorFeedbackSignal_conversationId_createdAt_idx" ON "CreatorFeedbackSignal"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorFeedbackSignal_turnId_createdAt_idx" ON "CreatorFeedbackSignal"("turnId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorTrainingSuggestion_representativeId_dedupeKey_key" ON "CreatorTrainingSuggestion"("representativeId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CreatorTrainingSuggestion_representativeId_status_createdAt_idx" ON "CreatorTrainingSuggestion"("representativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorTrainingSuggestion_sourceId_createdAt_idx" ON "CreatorTrainingSuggestion"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorTrainingSuggestion_feedbackSignalId_createdAt_idx" ON "CreatorTrainingSuggestion"("feedbackSignalId", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorTrainingVersion_representativeId_publishedAt_idx" ON "CreatorTrainingVersion"("representativeId", "publishedAt");

-- CreateIndex
CREATE INDEX "CreatorTrainingVersion_suggestionId_idx" ON "CreatorTrainingVersion"("suggestionId");

-- AddForeignKey
ALTER TABLE "CreatorTrainingSource" ADD CONSTRAINT "CreatorTrainingSource_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorFeedbackSignal" ADD CONSTRAINT "CreatorFeedbackSignal_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorFeedbackSignal" ADD CONSTRAINT "CreatorFeedbackSignal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorFeedbackSignal" ADD CONSTRAINT "CreatorFeedbackSignal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorFeedbackSignal" ADD CONSTRAINT "CreatorFeedbackSignal_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "ConversationTurn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTrainingSuggestion" ADD CONSTRAINT "CreatorTrainingSuggestion_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTrainingSuggestion" ADD CONSTRAINT "CreatorTrainingSuggestion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CreatorTrainingSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTrainingSuggestion" ADD CONSTRAINT "CreatorTrainingSuggestion_feedbackSignalId_fkey" FOREIGN KEY ("feedbackSignalId") REFERENCES "CreatorFeedbackSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTrainingVersion" ADD CONSTRAINT "CreatorTrainingVersion_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTrainingVersion" ADD CONSTRAINT "CreatorTrainingVersion_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "CreatorTrainingSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
