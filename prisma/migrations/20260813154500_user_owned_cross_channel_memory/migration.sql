-- Cross-channel Contact Memory is a system capability gated by verified
-- audience consent. Owners retain control over whether Contact Memory exists,
-- but cannot independently disable a user's cross-channel preference.

BEGIN;

ALTER TABLE "RepresentativeMemoryPolicy"
  ALTER COLUMN "contactMemoryCrossChannelEnabled" SET DEFAULT true;

UPDATE "RepresentativeMemoryPolicy"
   SET "contactMemoryCrossChannelEnabled" = true,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "longTermMemoryEnabled" = true
   AND "contactMemoryEnabled" = true
   AND "contactMemoryCrossChannelEnabled" = false;

COMMIT;
