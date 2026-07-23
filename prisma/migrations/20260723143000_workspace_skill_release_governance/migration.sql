CREATE TYPE "WorkspaceSkillReleaseStatus" AS ENUM ('INSTALLED', 'CANDIDATE', 'SUPERSEDED', 'REJECTED');

ALTER TYPE "EventType" ADD VALUE 'SKILL_UPDATE_DISCOVERED';
ALTER TYPE "EventType" ADD VALUE 'SKILL_VERSION_ADOPTED';
ALTER TYPE "EventType" ADD VALUE 'SKILL_VERSION_REJECTED';
ALTER TYPE "EventType" ADD VALUE 'SKILL_VERSION_ROLLED_BACK';
ALTER TYPE "EventType" ADD VALUE 'SKILL_ARCHIVED';
ALTER TYPE "EventType" ADD VALUE 'SKILL_RESTORED';

CREATE TABLE "WorkspaceSkillRelease" (
    "id" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "WorkspaceSkillReleaseStatus" NOT NULL,
    "displayName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "ownerHandle" TEXT,
    "verificationTier" TEXT,
    "capabilityTags" JSONB NOT NULL,
    "executesCode" BOOLEAN NOT NULL DEFAULT false,
    "provenanceDigest" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adoptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSkillRelease_pkey" PRIMARY KEY ("id")
);

INSERT INTO "WorkspaceSkillRelease" (
    "id",
    "installId",
    "version",
    "status",
    "displayName",
    "summary",
    "sourceUrl",
    "ownerHandle",
    "verificationTier",
    "capabilityTags",
    "executesCode",
    "discoveredAt",
    "adoptedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'wsr_' || md5(install."id" || ':' || BTRIM(install."installedVersion")),
    install."id",
    BTRIM(install."installedVersion"),
    'INSTALLED'::"WorkspaceSkillReleaseStatus",
    pack."displayName",
    pack."summary",
    pack."sourceUrl",
    pack."ownerHandle",
    pack."verificationTier",
    pack."capabilityTags",
    pack."executesCode",
    install."installedAt",
    install."installedAt",
    install."createdAt",
    install."updatedAt"
FROM "WorkspaceSkillInstall" AS install
JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
-- `SkillPack.version` is catalog metadata, not adoption evidence. An installed
-- release may only be created from a concrete legacy binding version projected
-- onto the workspace installation.
WHERE NULLIF(BTRIM(install."installedVersion"), '') IS NOT NULL;

-- Legacy `update_available` bindings carried the installed version on the
-- binding while `SkillPack.version` represented the discovered candidate.
-- Preserve both sides of that state transition so the decision migration can
-- create a real approval instead of leaving an install stuck without a
-- candidate release.
INSERT INTO "WorkspaceSkillRelease" (
    "id",
    "installId",
    "version",
    "status",
    "displayName",
    "summary",
    "sourceUrl",
    "ownerHandle",
    "verificationTier",
    "capabilityTags",
    "executesCode",
    "discoveredAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'wsr_candidate_' || md5(install."id" || ':' || BTRIM(pack."version")),
    install."id",
    BTRIM(pack."version"),
    'CANDIDATE'::"WorkspaceSkillReleaseStatus",
    pack."displayName",
    pack."summary",
    pack."sourceUrl",
    pack."ownerHandle",
    pack."verificationTier",
    pack."capabilityTags",
    pack."executesCode",
    install."updatedAt",
    install."updatedAt",
    install."updatedAt"
FROM "WorkspaceSkillInstall" AS install
JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
WHERE install."status" = 'UPDATE_AVAILABLE'
  AND NULLIF(BTRIM(pack."version"), '') IS NOT NULL
  AND NULLIF(BTRIM(install."installedVersion"), '') IS NOT NULL
  AND BTRIM(pack."version") <> BTRIM(install."installedVersion");

-- If the legacy row did not identify a distinct candidate, normalize it to
-- the only state that its release history can prove.
UPDATE "WorkspaceSkillInstall" AS install
SET
    "status" = 'INSTALLED'::"WorkspaceSkillInstallStatus"
WHERE install."status" = 'UPDATE_AVAILABLE'
  AND NOT EXISTS (
      SELECT 1
      FROM "WorkspaceSkillRelease" AS release
      WHERE release."installId" = install."id"
        AND release."status" = 'CANDIDATE'
  );

CREATE UNIQUE INDEX "WorkspaceSkillRelease_installId_version_key"
ON "WorkspaceSkillRelease"("installId", "version");

CREATE UNIQUE INDEX "WorkspaceSkillRelease_one_installed_per_install_key"
ON "WorkspaceSkillRelease"("installId")
WHERE "status" = 'INSTALLED';

CREATE INDEX "WorkspaceSkillRelease_installId_status_discoveredAt_idx"
ON "WorkspaceSkillRelease"("installId", "status", "discoveredAt");

ALTER TABLE "WorkspaceSkillRelease"
ADD CONSTRAINT "WorkspaceSkillRelease_installId_fkey"
FOREIGN KEY ("installId") REFERENCES "WorkspaceSkillInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
