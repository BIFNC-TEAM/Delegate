BEGIN;

ALTER TABLE "CreatorTrainingVersion"
  ADD COLUMN "revisionNumber" INTEGER,
  ADD COLUMN "rolledBackBy" TEXT;

WITH candidate_versions AS (
  SELECT
    version."id",
    version."representativeId",
    version."publishedAt",
    version."createdAt",
    (
      version."status" = 'PUBLISHED'
      AND knowledge_pack."representativeId" IS NOT NULL
      AND version."snapshotAfter" = jsonb_build_object(
        'identitySummary', knowledge_pack."identitySummary",
        'faq', knowledge_pack."faq",
        'materials', knowledge_pack."materials",
        'policies', knowledge_pack."policies"
      )
    ) AS is_current_match
  FROM "CreatorTrainingVersion" AS version
  LEFT JOIN "KnowledgePack" AS knowledge_pack
    ON knowledge_pack."representativeId" = version."representativeId"
),
version_match_counts AS (
  SELECT
    candidate_versions.*,
    COUNT(*) FILTER (WHERE is_current_match) OVER (
      PARTITION BY "representativeId"
    ) AS current_match_count
  FROM candidate_versions
),
ranked_versions AS (
  SELECT
    "id",
    -- Historical commit order is not recoverable: publishedAt/createdAt use
    -- transaction timestamps. Prisma CUIDs are generated closer to the create
    -- call, so their lexical order is the best deterministic approximation.
    -- Only a unique published snapshot matching current KnowledgePack is safe
    -- to put last. Ambiguous matches fall back to the CUID approximation.
    -- Other rows must not be interpreted as an exact historical commit log.
    ROW_NUMBER() OVER (
      PARTITION BY "representativeId"
      ORDER BY
        CASE
          WHEN is_current_match AND current_match_count = 1
          THEN 1
          ELSE 0
        END ASC,
        "id" ASC,
        "publishedAt" ASC,
        "createdAt" ASC
    )::INTEGER AS "revisionNumber"
  FROM version_match_counts
)
UPDATE "CreatorTrainingVersion" AS version
SET "revisionNumber" = ranked_versions."revisionNumber"
FROM ranked_versions
WHERE version."id" = ranked_versions."id";

ALTER TABLE "CreatorTrainingVersion"
  ALTER COLUMN "revisionNumber" SET NOT NULL;

DROP INDEX "CreatorTrainingVersion_representativeId_publishedAt_idx";

CREATE UNIQUE INDEX "CreatorTrainingVersion_representativeId_revisionNumber_key"
  ON "CreatorTrainingVersion"("representativeId", "revisionNumber");

COMMIT;
