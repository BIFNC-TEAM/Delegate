CREATE TYPE "WorkspaceSkillInstallStatus" AS ENUM ('INSTALLED', 'UPDATE_AVAILABLE', 'ARCHIVED');
CREATE TYPE "WorkspaceSkillReviewStatus" AS ENUM ('APPROVED', 'NEEDS_REVIEW', 'REJECTED');

ALTER TYPE "EventType" ADD VALUE 'SKILL_INSTALLED';
ALTER TYPE "EventType" ADD VALUE 'SKILL_BINDING_CHANGED';

CREATE TABLE "WorkspaceSkillInstall" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "skillPackId" TEXT NOT NULL,
    "status" "WorkspaceSkillInstallStatus" NOT NULL DEFAULT 'INSTALLED',
    "reviewStatus" "WorkspaceSkillReviewStatus" NOT NULL DEFAULT 'APPROVED',
    "installedVersion" TEXT,
    "installedBy" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSkillInstall_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RepresentativeSkillPack" ADD COLUMN "workspaceInstallId" TEXT;

INSERT INTO "WorkspaceSkillInstall" (
    "id",
    "ownerId",
    "skillPackId",
    "status",
    "reviewStatus",
    "installedVersion",
    "installedBy",
    "installedAt",
    "createdAt",
    "updatedAt"
)
WITH "legacyBindings" AS (
    SELECT
        representative."ownerId",
        binding."skillPackId",
        binding."id" AS "bindingId",
        binding."installStatus",
        NULLIF(BTRIM(binding."installedVersion"), '') AS "installedVersion",
        binding."installedAt",
        binding."createdAt",
        binding."updatedAt"
    FROM "RepresentativeSkillPack" AS binding
    JOIN "Representative" AS representative
      ON representative."id" = binding."representativeId"
    WHERE binding."installStatus" IN ('installed', 'update_available')
),
"bindingFacts" AS (
    SELECT
        legacy."ownerId",
        legacy."skillPackId",
        COUNT(*) FILTER (
            WHERE legacy."installedVersion" IS NULL
        ) AS "missingVersionCount",
        COUNT(DISTINCT legacy."installedVersion") AS "distinctVersionCount",
        COUNT(DISTINCT legacy."installStatus") AS "distinctStatusCount"
    FROM "legacyBindings" AS legacy
    GROUP BY legacy."ownerId", legacy."skillPackId"
),
"rankedBindings" AS (
    SELECT
        legacy.*,
        ROW_NUMBER() OVER (
            PARTITION BY legacy."ownerId", legacy."skillPackId"
            -- Only a concrete legacy binding version can become the installed
            -- version. Missing versions never outrank valid historical data.
            ORDER BY
                (legacy."installedVersion" IS NOT NULL) DESC,
                legacy."updatedAt" DESC,
                legacy."bindingId" DESC
        ) AS "bindingRank"
    FROM "legacyBindings" AS legacy
)
SELECT
    'wsi_' || md5(ranked."ownerId" || ':' || ranked."skillPackId"),
    ranked."ownerId",
    ranked."skillPackId",
    CASE ranked."installStatus"
        WHEN 'update_available' THEN 'UPDATE_AVAILABLE'::"WorkspaceSkillInstallStatus"
        ELSE 'INSTALLED'::"WorkspaceSkillInstallStatus"
    END,
    CASE
        WHEN facts."missingVersionCount" > 0
          OR facts."distinctVersionCount" > 1
          OR facts."distinctStatusCount" > 1
        THEN 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
        WHEN ranked."installStatus" = 'update_available'
        THEN 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
        ELSE 'APPROVED'::"WorkspaceSkillReviewStatus"
    END,
    ranked."installedVersion",
    ranked."ownerId",
    COALESCE(ranked."installedAt", ranked."createdAt", ranked."updatedAt"),
    ranked."createdAt",
    ranked."updatedAt"
FROM "rankedBindings" AS ranked
JOIN "bindingFacts" AS facts
  ON facts."ownerId" = ranked."ownerId"
 AND facts."skillPackId" = ranked."skillPackId"
WHERE ranked."bindingRank" = 1;

UPDATE "RepresentativeSkillPack" AS binding
SET "workspaceInstallId" = install."id"
FROM "Representative" AS representative,
     "WorkspaceSkillInstall" AS install
WHERE representative."id" = binding."representativeId"
  AND install."ownerId" = representative."ownerId"
  AND install."skillPackId" = binding."skillPackId";

CREATE UNIQUE INDEX "WorkspaceSkillInstall_ownerId_skillPackId_key"
ON "WorkspaceSkillInstall"("ownerId", "skillPackId");

CREATE INDEX "WorkspaceSkillInstall_ownerId_status_updatedAt_idx"
ON "WorkspaceSkillInstall"("ownerId", "status", "updatedAt");

CREATE INDEX "WorkspaceSkillInstall_skillPackId_status_idx"
ON "WorkspaceSkillInstall"("skillPackId", "status");

CREATE INDEX "RepresentativeSkillPack_workspaceInstallId_enabled_idx"
ON "RepresentativeSkillPack"("workspaceInstallId", "enabled");

ALTER TABLE "WorkspaceSkillInstall"
ADD CONSTRAINT "WorkspaceSkillInstall_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceSkillInstall"
ADD CONSTRAINT "WorkspaceSkillInstall_skillPackId_fkey"
FOREIGN KEY ("skillPackId") REFERENCES "SkillPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RepresentativeSkillPack"
ADD CONSTRAINT "RepresentativeSkillPack_workspaceInstallId_fkey"
FOREIGN KEY ("workspaceInstallId") REFERENCES "WorkspaceSkillInstall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
