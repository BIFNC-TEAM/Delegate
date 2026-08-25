BEGIN;

ALTER TYPE "ConversationPlanActionStatus" ADD VALUE IF NOT EXISTS 'QUEUED';

CREATE TYPE "ExecutionAttemptPhase" AS ENUM (
  'CREATED',
  'CLAIMED',
  'CALL_PREPARED',
  'CALL_STARTED',
  'RESPONSE_RECEIVED',
  'VERIFYING',
  'FINISHED',
  'CANCELED_BEFORE_START',
  'FAILED_BEFORE_CALL',
  'OUTCOME_UNKNOWN'
);

ALTER TABLE "ToolExecution"
  ADD COLUMN "planActionId" TEXT,
  ADD COLUMN "planRevision" INTEGER,
  ADD COLUMN "executionEpoch" INTEGER,
  ADD COLUMN "attemptNumber" INTEGER,
  ADD COLUMN "attemptPhase" "ExecutionAttemptPhase",
  ADD COLUMN "executionOutboxId" TEXT,
  ADD COLUMN "transportOutcome" TEXT,
  ADD COLUMN "semanticOutcome" TEXT,
  ADD COLUMN "rawResultRef" TEXT;

CREATE UNIQUE INDEX "ToolExecution_executionOutboxId_key"
  ON "ToolExecution"("executionOutboxId");
CREATE UNIQUE INDEX "ToolExecution_planAction_attemptNumber_key"
  ON "ToolExecution"("planActionId", "attemptNumber");
CREATE INDEX "ToolExecution_planAction_phase_created_idx"
  ON "ToolExecution"("planActionId", "attemptPhase", "createdAt");
CREATE INDEX "ToolExecution_epoch_status_created_idx"
  ON "ToolExecution"("executionEpoch", "status", "createdAt");

ALTER TABLE "ToolExecution"
  ADD CONSTRAINT "ToolExecution_planActionId_fkey"
  FOREIGN KEY ("planActionId") REFERENCES "ConversationPlanAction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
