-- Memory System T2: fail closed for every legacy memory row that remained
-- recallable. Legacy rows are not promoted into the governed memory tables.

BEGIN;

UPDATE "OpenVikingMemoryRecord"
SET
  "status" = 'SUPPRESSED'::"OpenVikingMemoryStatus",
  "suppressedAt" = COALESCE("suppressedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'ACTIVE'::"OpenVikingMemoryStatus";

COMMIT;
