BEGIN;

ALTER TABLE "CreatorTrainingSuggestion"
  ADD COLUMN "originRevision" INTEGER;

WITH ranked_origin_suggestions AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "representativeId", "originKey"
      ORDER BY "createdAt" ASC, "id" ASC
    )::INTEGER AS "originRevision"
  FROM "CreatorTrainingSuggestion"
)
UPDATE "CreatorTrainingSuggestion" AS suggestion
SET "originRevision" = ranked."originRevision"
FROM ranked_origin_suggestions AS ranked
WHERE suggestion."id" = ranked."id";

ALTER TABLE "CreatorTrainingSuggestion"
  ALTER COLUMN "originRevision" SET NOT NULL;

DROP INDEX "CreatorTrainingSuggestion_representativeId_dedupeKey_key";

CREATE UNIQUE INDEX "CreatorTrainingSuggestion_representativeId_originKey_originRevision_key"
  ON "CreatorTrainingSuggestion"("representativeId", "originKey", "originRevision");

CREATE INDEX "CreatorTrainingSuggestion_representativeId_dedupeKey_idx"
  ON "CreatorTrainingSuggestion"("representativeId", "dedupeKey");

COMMIT;
