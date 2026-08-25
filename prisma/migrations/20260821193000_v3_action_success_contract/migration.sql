BEGIN;

ALTER TABLE "ConversationPlanAction"
  ADD COLUMN "successContract" JSONB;

COMMIT;
