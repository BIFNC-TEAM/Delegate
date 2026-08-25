BEGIN;

ALTER TABLE "ApprovalRequest"
  ADD COLUMN "maximumApprovedEffect" JSONB;

COMMIT;
