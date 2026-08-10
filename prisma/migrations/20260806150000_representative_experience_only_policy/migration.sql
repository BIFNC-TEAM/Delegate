BEGIN;

-- Earlier P0 constraints coupled automatic extraction to Contact Memory. The
-- current product supports Representative Experience as an independent,
-- de-identified 2x2 evidence stream, so automatic Web extraction may run when
-- either durable-memory type is enabled. Normalize only impossible legacy
-- combinations before replacing the structural guard.
UPDATE "RepresentativeMemoryPolicy"
   SET "autoExtract" = false,
       "webExtractEnabled" = false,
       "webRecallEnabled" = false,
       "revision" = "revision" + 1,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT "contactMemoryEnabled"
   AND NOT "representativeExperienceEnabled"
   AND ("autoExtract" OR "webExtractEnabled" OR "webRecallEnabled");

ALTER TABLE "RepresentativeMemoryPolicy"
  DROP CONSTRAINT "MemoryPolicy_safe_enablement_check",
  ADD CONSTRAINT "MemoryPolicy_safe_enablement_check" CHECK (
    (NOT "contactMemoryEnabled" OR "longTermMemoryEnabled")
    AND (NOT "representativeExperienceEnabled" OR "longTermMemoryEnabled")
    AND (NOT "contactMemoryCrossChannelEnabled" OR (
      "longTermMemoryEnabled" AND "contactMemoryEnabled"
    ))
    AND (NOT "autoExtract" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "webRecallEnabled" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "webExtractEnabled" OR (
      "longTermMemoryEnabled"
      AND "autoExtract"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
  );

COMMIT;
