-- A terminally deleted shared memory must never be reactivated, but a later
-- explicit consent grant may create a new governed memory with the same
-- semantic coordinate. Active/suppressed rows remain uniquely serialized.

BEGIN;

DROP INDEX IF EXISTS "GovernedMemory_shared_semantic_key";
CREATE UNIQUE INDEX "GovernedMemory_shared_semantic_key"
  ON "GovernedMemory"(
    "representativeId",
    "audienceIdentityId",
    "category",
    "semanticKey"
  )
  WHERE "scope" = 'CONTACT_SHARED'
    AND "semanticKey" IS NOT NULL
    AND "status" IN ('ACTIVE', 'SUPPRESSED');

COMMIT;
