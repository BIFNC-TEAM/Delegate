-- Add the V3 plan identity and execution-fence contract without rewriting any
-- existing V2 plan snapshot. V2 rows keep protocolVersion=2 and a NULL scope.
BEGIN;

ALTER TABLE "ConversationTurnPlan"
  ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "scopeKey" TEXT,
  ADD COLUMN "scopeSnapshot" JSONB,
  ADD COLUMN "executionEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "plannerProposalHash" CHAR(64),
  ADD COLUMN "validationPolicyVersion" TEXT;

ALTER TABLE "ConversationPlanAction"
  ADD COLUMN "dependencyPolicy" JSONB,
  ADD COLUMN "activationPolicy" JSONB,
  ADD COLUMN "failurePolicy" JSONB;

CREATE TABLE "PlanExecutionFence" (
  "scopeKey" TEXT NOT NULL,
  "activePlanId" TEXT NOT NULL,
  "activeRevision" INTEGER NOT NULL,
  "executionEpoch" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlanExecutionFence_pkey" PRIMARY KEY ("scopeKey")
);

CREATE UNIQUE INDEX "ConversationTurnPlan_scopeKey_revision_key"
  ON "ConversationTurnPlan"("scopeKey", "revision");
CREATE UNIQUE INDEX "PlanExecutionFence_activePlanId_key"
  ON "PlanExecutionFence"("activePlanId");
CREATE INDEX "PlanExecutionFence_activePlan_revision_idx"
  ON "PlanExecutionFence"("activePlanId", "activeRevision");
CREATE INDEX "PlanExecutionFence_epoch_updated_idx"
  ON "PlanExecutionFence"("executionEpoch", "updatedAt");

ALTER TABLE "PlanExecutionFence"
  ADD CONSTRAINT "PlanExecutionFence_activePlanId_fkey"
  FOREIGN KEY ("activePlanId") REFERENCES "ConversationTurnPlan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
