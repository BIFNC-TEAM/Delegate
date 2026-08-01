ALTER TABLE "CreatorTrainingSuggestion"
  ADD COLUMN "originKey" TEXT;

UPDATE "CreatorTrainingSuggestion"
SET "originKey" = CASE
  WHEN "sourceId" IS NOT NULL
    THEN 'source:' || "sourceId" || ':' || LOWER("suggestionType"::TEXT)
  WHEN "feedbackSignalId" IS NOT NULL
    THEN 'feedback:' || "feedbackSignalId" || ':' || LOWER("suggestionType"::TEXT)
  WHEN "dedupeKey" LIKE 'unknown:%'
    THEN REGEXP_REPLACE("dedupeKey", ':[0-9a-f]{16}$', '')
  ELSE 'legacy:' || "id"
END;

WITH ranked_pending AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "representativeId", "originKey"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS pending_rank
  FROM "CreatorTrainingSuggestion"
  WHERE "status" = 'PENDING'
)
UPDATE "CreatorTrainingSuggestion" AS suggestion
SET "status" = 'SUPERSEDED'
FROM ranked_pending
WHERE suggestion."id" = ranked_pending."id"
  AND ranked_pending.pending_rank > 1;

ALTER TABLE "CreatorTrainingSuggestion"
  ALTER COLUMN "originKey" SET NOT NULL;

CREATE INDEX "CreatorTrainingSuggestion_representativeId_originKey_idx"
  ON "CreatorTrainingSuggestion"("representativeId", "originKey");

CREATE UNIQUE INDEX "CreatorTrainingSuggestion_one_pending_origin_key"
  ON "CreatorTrainingSuggestion"("representativeId", "originKey")
  WHERE "status" = 'PENDING';
