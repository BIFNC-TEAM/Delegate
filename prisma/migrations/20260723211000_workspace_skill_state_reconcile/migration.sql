-- Corrective, idempotent reconciliation for environments where the earlier
-- workspace release migrations were already applied before candidate
-- backfilling and release-row state projection were introduced.
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
    'wsr_reconciled_' || md5(install."id" || ':' || pack."version"),
    install."id",
    pack."version",
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
  AND pack."version" IS NOT NULL
  AND install."installedVersion" IS NOT NULL
  AND pack."version" <> install."installedVersion"
  AND NOT EXISTS (
      SELECT 1
      FROM "WorkspaceSkillRelease" AS release
      WHERE release."installId" = install."id"
        AND release."version" = pack."version"
  )
ON CONFLICT ("installId", "version") DO NOTHING;

INSERT INTO "ApprovalRequest" (
    "id",
    "representativeId",
    "workspaceSkillReleaseId",
    "status",
    "reason",
    "requestedActionSummary",
    "riskSummary",
    "requestedAt",
    "requestPayloadHash",
    "matchedPolicyRuleId"
)
SELECT
    'approval_skill_reconciled_' || md5(release."id"),
    representative."id",
    release."id",
    'PENDING'::"ApprovalStatus",
    'skill_version_update_review',
    'Review ' || release."displayName" || ' v' || release."version",
    'Reconciled legacy candidate release. Registry trust evidence was unavailable during migration; owner review is required.',
    release."discoveredAt",
    release."provenanceDigest",
    'workspace-skill:review_required'
FROM "WorkspaceSkillRelease" AS release
JOIN "WorkspaceSkillInstall" AS install ON install."id" = release."installId"
JOIN LATERAL (
    SELECT rep."id"
    FROM "Representative" AS rep
    WHERE rep."ownerId" = install."ownerId"
    ORDER BY rep."createdAt" ASC
    LIMIT 1
) AS representative ON TRUE
WHERE release."status" = 'CANDIDATE'
  AND NOT EXISTS (
      SELECT 1
      FROM "ApprovalRequest" AS existing
      WHERE existing."workspaceSkillReleaseId" = release."id"
  )
ON CONFLICT ("workspaceSkillReleaseId") DO NOTHING;

UPDATE "WorkspaceSkillInstall" AS install
SET
    "status" = CASE
        WHEN EXISTS (
            SELECT 1
            FROM "WorkspaceSkillRelease" AS release
            WHERE release."installId" = install."id"
              AND release."status" = 'CANDIDATE'
        )
        THEN 'UPDATE_AVAILABLE'::"WorkspaceSkillInstallStatus"
        ELSE 'INSTALLED'::"WorkspaceSkillInstallStatus"
    END,
    "reviewStatus" = CASE
        WHEN EXISTS (
            SELECT 1
            FROM "WorkspaceSkillRelease" AS release
            WHERE release."installId" = install."id"
              AND release."status" = 'CANDIDATE'
        )
        THEN 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
        ELSE 'APPROVED'::"WorkspaceSkillReviewStatus"
    END
WHERE install."status" <> 'ARCHIVED';
