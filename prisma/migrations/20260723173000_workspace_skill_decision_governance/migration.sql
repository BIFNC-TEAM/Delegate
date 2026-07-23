CREATE TYPE "WorkspaceSkillUpdatePolicy" AS ENUM ('MANUAL', 'REVIEW_REQUIRED', 'PATCH_AUTO');
CREATE TYPE "WorkspaceSkillSignatureStatus" AS ENUM ('UNAVAILABLE', 'UNVERIFIED', 'VERIFIED', 'INVALID');

ALTER TYPE "EventType" ADD VALUE 'SKILL_UPDATE_POLICY_CHANGED';

ALTER TABLE "WorkspaceSkillInstall"
ADD COLUMN "updatePolicy" "WorkspaceSkillUpdatePolicy" NOT NULL DEFAULT 'REVIEW_REQUIRED';

ALTER TABLE "WorkspaceSkillRelease"
ADD COLUMN "signatureStatus" "WorkspaceSkillSignatureStatus" NOT NULL DEFAULT 'UNAVAILABLE',
ADD COLUMN "signatureAlgorithm" TEXT,
ADD COLUMN "signatureKeyId" TEXT,
ADD COLUMN "signatureValue" TEXT,
ADD COLUMN "sbomUrl" TEXT,
ADD COLUMN "attestationUrl" TEXT;

ALTER TABLE "ApprovalRequest"
ADD COLUMN "workspaceSkillReleaseId" TEXT;

CREATE UNIQUE INDEX "ApprovalRequest_workspaceSkillReleaseId_key"
ON "ApprovalRequest"("workspaceSkillReleaseId");

CREATE INDEX "EventAudit_representativeId_createdAt_idx"
ON "EventAudit"("representativeId", "createdAt");

ALTER TABLE "ApprovalRequest"
ADD CONSTRAINT "ApprovalRequest_workspaceSkillReleaseId_fkey"
FOREIGN KEY ("workspaceSkillReleaseId") REFERENCES "WorkspaceSkillRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
    'approval_skill_' || md5(release."id"),
    representative."id",
    release."id",
    'PENDING'::"ApprovalStatus",
    'skill_version_update_review',
    'Review ' || release."displayName" || ' v' || release."version",
    'Migrated candidate release. Publisher signature was not available during migration; owner review is required.',
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
      SELECT 1 FROM "ApprovalRequest" existing
      WHERE existing."workspaceSkillReleaseId" = release."id"
  );

-- From this point forward a workspace installation's mutable status is a
-- projection of its own release rows. `SkillPack.version` remains catalog
-- metadata and must not decide whether a particular workspace has an update.
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
