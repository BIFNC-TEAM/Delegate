ALTER TABLE "ComputeSession"
  ADD COLUMN "generationOutboxId" TEXT,
  ADD COLUMN "generationLeaseAttempt" INTEGER;

ALTER TABLE "ToolExecution"
  ADD COLUMN "generationOutboxId" TEXT,
  ADD COLUMN "generationLeaseAttempt" INTEGER,
  ADD COLUMN "requestPayloadHash" TEXT,
  ADD COLUMN "responseSnapshot" JSONB,
  ADD COLUMN "executionLeaseToken" TEXT,
  ADD COLUMN "billingFinalizedAt" TIMESTAMP(3),
  ADD COLUMN "billingSnapshot" JSONB;

CREATE UNIQUE INDEX "ComputeSession_generationOutboxId_key"
  ON "ComputeSession"("generationOutboxId");

CREATE UNIQUE INDEX "ToolExecution_generationOutboxId_key"
  ON "ToolExecution"("generationOutboxId");

CREATE UNIQUE INDEX "ToolExecution_executionLeaseToken_key"
  ON "ToolExecution"("executionLeaseToken");
