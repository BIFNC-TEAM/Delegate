-- Compute credits were a transitional resource-budget model. Public service
-- usage is authorized by free/service units, while execution cost remains an
-- internal cents-based ledger signal.

DELETE FROM "LedgerEntry"
WHERE "kind" IN ('PLAN_DEBIT', 'SPONSOR_CREDIT');

ALTER TABLE "Conversation"
DROP COLUMN IF EXISTS "computeBudgetRemainingCredits";

ALTER TABLE "Wallet"
DROP COLUMN IF EXISTS "balanceCredits",
DROP COLUMN IF EXISTS "sponsorPoolCredit";

ALTER TABLE "DelegationTaskResourcePolicy"
DROP COLUMN IF EXISTS "maxCredits";

ALTER TABLE "LedgerEntry"
DROP COLUMN IF EXISTS "creditDelta";

ALTER TYPE "LedgerEntryKind" RENAME TO "LedgerEntryKind_legacy_compute_credits";

CREATE TYPE "LedgerEntryKind" AS ENUM (
  'MODEL_USAGE',
  'COMPUTE_MINUTES',
  'STORAGE_BYTES',
  'ARTIFACT_EGRESS',
  'BROWSER_MINUTES',
  'MCP_CALLS'
);

ALTER TABLE "LedgerEntry"
ALTER COLUMN "kind" TYPE "LedgerEntryKind"
USING ("kind"::text::"LedgerEntryKind");

DROP TYPE "LedgerEntryKind_legacy_compute_credits";
