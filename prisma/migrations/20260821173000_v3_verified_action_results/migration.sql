BEGIN;

CREATE TABLE "ActionResult" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "executionAttemptId" TEXT NOT NULL,
  "planRevision" INTEGER NOT NULL,
  "executionEpoch" INTEGER NOT NULL,
  "transportOutcome" TEXT NOT NULL,
  "semanticOutcome" TEXT NOT NULL,
  "output" JSONB,
  "outputSchemaHash" CHAR(64),
  "outputHash" CHAR(64),
  "securityFindings" JSONB NOT NULL,
  "evidenceBindings" JSONB NOT NULL,
  "artifactRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "externalEffectId" TEXT,
  "usageRecordIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "billingUnitIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failure" JSONB,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActionResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActionResult_executionAttemptId_key"
  ON "ActionResult"("executionAttemptId");
CREATE INDEX "ActionResult_plan_semantic_created_idx"
  ON "ActionResult"("planId", "semanticOutcome", "createdAt");
CREATE INDEX "ActionResult_action_verified_idx"
  ON "ActionResult"("actionId", "verifiedAt");
CREATE INDEX "ActionResult_externalEffectId_idx"
  ON "ActionResult"("externalEffectId");

ALTER TABLE "ActionResult" ADD CONSTRAINT "ActionResult_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ConversationTurnPlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActionResult" ADD CONSTRAINT "ActionResult_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "ConversationPlanAction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActionResult" ADD CONSTRAINT "ActionResult_executionAttemptId_fkey"
  FOREIGN KEY ("executionAttemptId") REFERENCES "ToolExecution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
