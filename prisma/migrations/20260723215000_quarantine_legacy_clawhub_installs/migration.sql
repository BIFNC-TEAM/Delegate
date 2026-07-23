-- Existing ClawHub rows predate exact-version Registry and manifest evidence.
-- Quarantine them until a trusted release is installed through the new flow.
UPDATE "WorkspaceSkillInstall" AS install
SET "reviewStatus" = 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
FROM "SkillPack" AS pack
WHERE pack."id" = install."skillPackId"
  AND pack."source" = 'CLAWHUB'::"SkillPackSource"
  AND NOT EXISTS (
      SELECT 1
      FROM "WorkspaceSkillRelease" AS release
      WHERE release."installId" = install."id"
        AND release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        AND release."registryTrustEligible" = true
  );

UPDATE "RepresentativeSkillPack" AS binding
SET "enabled" = false
FROM "WorkspaceSkillInstall" AS install,
     "SkillPack" AS pack
WHERE binding."workspaceInstallId" = install."id"
  AND pack."id" = install."skillPackId"
  AND pack."source" = 'CLAWHUB'::"SkillPackSource"
  AND NOT EXISTS (
      SELECT 1
      FROM "WorkspaceSkillRelease" AS release
      WHERE release."installId" = install."id"
        AND release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        AND release."registryTrustEligible" = true
  );
