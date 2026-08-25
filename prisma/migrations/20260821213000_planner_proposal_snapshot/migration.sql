BEGIN;

ALTER TABLE "ConversationTurnPlan"
  ADD COLUMN "plannerProposalSnapshot" JSONB;

COMMIT;
