BEGIN;

ALTER TABLE "ConversationPlanAction"
  ADD COLUMN "authorizationPhase" "ActionAuthorizationPhase",
  ADD COLUMN "effectiveDecision" "PolicyDecision",
  ADD COLUMN "authorizationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "authorizationPolicyVersion" TEXT;

ALTER TABLE "ToolExecution"
  ADD COLUMN "externalEffectId" TEXT,
  ADD COLUMN "billingAdmission" JSONB;

ALTER TABLE "DelegationTaskExternalEffect"
  ADD COLUMN "planActionId" TEXT;

CREATE UNIQUE INDEX "ToolExecution_externalEffectId_key"
  ON "ToolExecution"("externalEffectId");
CREATE INDEX "DelegationTaskExternalEffect_planAction_status_created_idx"
  ON "DelegationTaskExternalEffect"("planActionId", "status", "createdAt");

ALTER TABLE "ToolExecution"
  ADD CONSTRAINT "ToolExecution_externalEffectId_fkey"
  FOREIGN KEY ("externalEffectId") REFERENCES "DelegationTaskExternalEffect"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DelegationTaskExternalEffect"
  ADD CONSTRAINT "DelegationTaskExternalEffect_planActionId_fkey"
  FOREIGN KEY ("planActionId") REFERENCES "ConversationPlanAction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
