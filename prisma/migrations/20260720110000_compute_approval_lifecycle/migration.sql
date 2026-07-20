-- AlterEnum
ALTER TYPE "ConversationEpisodeStatus" ADD VALUE 'WAITING_APPROVAL';

-- AlterTable
ALTER TABLE "ApprovalRequest"
ADD COLUMN "generationRunId" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "decisionNote" TEXT,
ADD COLUMN "requestPayloadHash" TEXT,
ADD COLUMN "matchedPolicyRuleId" TEXT;

-- CreateIndex
CREATE INDEX "ApprovalRequest_generationRunId_status_idx" ON "ApprovalRequest"("generationRunId", "status");

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_generationRunId_fkey"
FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Persist isolation attributes so a less-isolated sandbox is never reused.
ALTER TABLE "SandboxLease"
ADD COLUMN "networkMode" "ComputeNetworkMode" NOT NULL DEFAULT 'NO_NETWORK',
ADD COLUMN "filesystemMode" "ComputeFilesystemMode" NOT NULL DEFAULT 'EPHEMERAL_FULL',
ADD COLUMN "baseImage" TEXT NOT NULL DEFAULT 'debian:bookworm-slim';

ALTER TABLE "ComputeSession" ADD COLUMN "generationRunId" TEXT;
CREATE INDEX "ComputeSession_generationRunId_createdAt_idx" ON "ComputeSession"("generationRunId", "createdAt");
ALTER TABLE "ComputeSession" ADD CONSTRAINT "ComputeSession_generationRunId_fkey"
FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
