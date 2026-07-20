-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'FOLLOWING_UP', 'PENDING_PAYMENT', 'WON', 'LOST', 'ARCHIVED');

-- AlterTable
ALTER TABLE "HandoffRequest" ADD COLUMN "episodeId" TEXT;

-- CreateTable
CREATE TABLE "ConversationReadState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationInternalNote" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "episodeId" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationInternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT,
    "episodeId" TEXT,
    "intakeSubmissionId" TEXT,
    "handoffRequestId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "estimatedValueCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "assignedOperatorId" TEXT,
    "assignedOperatorName" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReadState_conversationId_operatorId_key" ON "ConversationReadState"("conversationId", "operatorId");
CREATE INDEX "ConversationReadState_operatorId_lastReadAt_idx" ON "ConversationReadState"("operatorId", "lastReadAt");
CREATE INDEX "ConversationInternalNote_conversationId_createdAt_idx" ON "ConversationInternalNote"("conversationId", "createdAt");
CREATE INDEX "ConversationInternalNote_episodeId_createdAt_idx" ON "ConversationInternalNote"("episodeId", "createdAt");
CREATE INDEX "HandoffRequest_conversationId_episodeId_status_idx" ON "HandoffRequest"("conversationId", "episodeId", "status");
CREATE INDEX "Lead_representativeId_status_priority_updatedAt_idx" ON "Lead"("representativeId", "status", "priority", "updatedAt");
CREATE INDEX "Lead_contactId_status_updatedAt_idx" ON "Lead"("contactId", "status", "updatedAt");
CREATE INDEX "Lead_conversationId_status_updatedAt_idx" ON "Lead"("conversationId", "status", "updatedAt");
CREATE INDEX "Lead_assignedOperatorId_status_nextFollowUpAt_idx" ON "Lead"("assignedOperatorId", "status", "nextFollowUpAt");

-- AddForeignKey
ALTER TABLE "ConversationReadState" ADD CONSTRAINT "ConversationReadState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationInternalNote" ADD CONSTRAINT "ConversationInternalNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationInternalNote" ADD CONSTRAINT "ConversationInternalNote_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandoffRequest" ADD CONSTRAINT "HandoffRequest_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_intakeSubmissionId_fkey" FOREIGN KEY ("intakeSubmissionId") REFERENCES "IntakeSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_handoffRequestId_fkey" FOREIGN KEY ("handoffRequestId") REFERENCES "HandoffRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
