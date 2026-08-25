BEGIN;

ALTER TABLE "DelegationTaskExternalEffect"
  ADD COLUMN "callAttemptId" TEXT,
  ADD COLUMN "executionLeaseTokenHash" CHAR(64),
  ADD COLUMN "callStartedAt" TIMESTAMP(3);

CREATE INDEX "DelegationTaskExternalEffect_callAttemptId_idx"
  ON "DelegationTaskExternalEffect"("callAttemptId");

COMMIT;
