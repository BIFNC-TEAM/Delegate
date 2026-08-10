-- CONTACT_SHARED was introduced after the original version constraint, whose
-- closed enum check accepted only REPRESENTATIVE and CONTACT_CHANNEL. Shared
-- Contact Memory leaves a channel-specific namespace, so require explicit,
-- auditable deidentification evidence instead of weakening that boundary.

BEGIN;

-- Do not invent deidentification evidence for any legacy candidate. No shared
-- version could previously pass the version CHECK, so fail closed by expiring
-- and purging any stranded candidate before tightening its constraint.
UPDATE "MemoryCandidate"
   SET "status" = 'EXPIRED',
       "safeText" = NULL,
       "summary" = NULL,
       "contentPurgedAt" = COALESCE("contentPurgedAt", CURRENT_TIMESTAMP),
       "reviewedAt" = COALESCE("reviewedAt", CURRENT_TIMESTAMP),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "scope" = 'CONTACT_SHARED'
   AND "status" IN ('PENDING_REVIEW', 'APPROVED')
   AND "deidentifiedAt" IS NULL;

ALTER TABLE "MemoryCandidate"
  DROP CONSTRAINT IF EXISTS "MemoryCandidate_deidentification_check";
ALTER TABLE "MemoryCandidate"
  ADD CONSTRAINT "MemoryCandidate_deidentification_check" CHECK (
    "scope" NOT IN ('REPRESENTATIVE', 'CONTACT_SHARED')
    OR "status" NOT IN ('PENDING_REVIEW', 'APPROVED')
    OR "contentPurgedAt" IS NOT NULL
    OR "deidentifiedAt" IS NOT NULL
  );

ALTER TABLE "GovernedMemoryVersion"
  DROP CONSTRAINT IF EXISTS "GovernedMemoryVersion_deidentification_check";
ALTER TABLE "GovernedMemoryVersion"
  ADD CONSTRAINT "GovernedMemoryVersion_deidentification_check" CHECK (
    (
      "scope" IN ('REPRESENTATIVE', 'CONTACT_SHARED')
      AND "deidentifiedAt" IS NOT NULL
      AND "deidentificationMethod" IS NOT NULL
      AND btrim("deidentificationMethod") <> ''
    ) OR (
      "scope" = 'CONTACT_CHANNEL'
      AND (("deidentifiedAt" IS NULL) = ("deidentificationMethod" IS NULL))
      AND (
        "deidentificationMethod" IS NULL
        OR btrim("deidentificationMethod") <> ''
      )
    )
  );

COMMIT;
