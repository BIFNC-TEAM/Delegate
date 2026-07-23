-- Additive corrective migration for databases that may already have applied
-- earlier revisions of the workspace-skill backfill migrations.
--
-- Two inputs are fail-closed:
--   1. ambiguity still visible on legacy representative bindings; and
--   2. a release carrying the exact review-note marker emitted by the former
--      multi-representative reconciliation.
--
-- The second input matters because the former reconciliation could normalize
-- conflicting bindings and thereby hide the original ambiguity from a later
-- read-only preflight. The current 20260723220000 migration deliberately uses
-- a different marker, so this migration has no data effect on a fresh chain
-- once the current reconciliation has already converged the rows.
CREATE TEMP TABLE "LegacyWorkspaceSkillCorrectiveAmbiguity"
AS
WITH "legacyBindings" AS (
    SELECT
        representative."ownerId",
        binding."skillPackId",
        binding."id" AS "bindingId",
        binding."installStatus",
        NULLIF(BTRIM(binding."installedVersion"), '') AS "version",
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
        COUNT(*) AS "bindingCount",
        COUNT(*) FILTER (WHERE legacy."version" IS NULL)
            AS "missingVersionBindingCount",
        COUNT(DISTINCT legacy."version") AS "distinctValidVersionCount",
        COUNT(DISTINCT legacy."installStatus") AS "distinctStatusCount"
    FROM "legacyBindings" AS legacy
    GROUP BY legacy."ownerId", legacy."skillPackId"
),
"liveAmbiguity" AS (
    SELECT
        facts."ownerId",
        facts."skillPackId",
        ARRAY_REMOVE(
            ARRAY[
                CASE
                    WHEN facts."missingVersionBindingCount" > 0
                    THEN 'missing_version'
                END,
                CASE
                    WHEN facts."distinctValidVersionCount" > 1
                    THEN 'version_conflict'
                END,
                CASE
                    WHEN facts."distinctStatusCount" > 1
                    THEN 'status_conflict'
                END
            ],
            NULL
        ) AS "issueCodes"
    FROM "bindingFacts" AS facts
    WHERE facts."missingVersionBindingCount" > 0
       OR facts."distinctValidVersionCount" > 1
       OR facts."distinctStatusCount" > 1
),
"formerReconciliationMarker" AS (
    SELECT DISTINCT
        install."ownerId",
        install."skillPackId"
    FROM "WorkspaceSkillInstall" AS install
    JOIN "WorkspaceSkillRelease" AS release
      ON release."installId" = install."id"
    WHERE release."reviewNote" ILIKE
        '%legacy multi-representative version reconciliation%'
),
"affectedKeys" AS (
    SELECT
        live."ownerId",
        live."skillPackId",
        live."issueCodes"
    FROM "liveAmbiguity" AS live

    UNION

    SELECT
        marker."ownerId",
        marker."skillPackId",
        ARRAY['former_reconciliation_marker']::TEXT[] AS "issueCodes"
    FROM "formerReconciliationMarker" AS marker
),
"affected" AS (
    SELECT
        keys."ownerId",
        keys."skillPackId",
        ARRAY_AGG(DISTINCT issue."code" ORDER BY issue."code")
            AS "issueCodes"
    FROM "affectedKeys" AS keys
    CROSS JOIN LATERAL UNNEST(keys."issueCodes") AS issue("code")
    GROUP BY keys."ownerId", keys."skillPackId"
),
"winnerBindings" AS (
    SELECT DISTINCT ON (legacy."ownerId", legacy."skillPackId")
        legacy."ownerId",
        legacy."skillPackId",
        legacy."bindingId" AS "winnerBindingId",
        legacy."version" AS "winnerVersion",
        legacy."installStatus" AS "winnerInstallStatus",
        COALESCE(
            legacy."installedAt",
            legacy."createdAt",
            legacy."updatedAt"
        ) AS "winnerInstalledAt",
        legacy."updatedAt" AS "winnerBindingUpdatedAt"
    FROM "legacyBindings" AS legacy
    JOIN "affected" AS affected
      ON affected."ownerId" = legacy."ownerId"
     AND affected."skillPackId" = legacy."skillPackId"
    WHERE legacy."version" IS NOT NULL
    ORDER BY
        legacy."ownerId",
        legacy."skillPackId",
        legacy."updatedAt" DESC,
        legacy."bindingId" DESC
)
SELECT
    install."id" AS "installId",
    affected."ownerId",
    affected."skillPackId",
    affected."issueCodes",
    winner."winnerBindingId",
    winner."winnerVersion",
    winner."winnerInstallStatus",
    winner."winnerInstalledAt",
    winner."winnerBindingUpdatedAt"
FROM "affected" AS affected
JOIN "WorkspaceSkillInstall" AS install
  ON install."ownerId" = affected."ownerId"
 AND install."skillPackId" = affected."skillPackId"
LEFT JOIN "winnerBindings" AS winner
  ON winner."ownerId" = affected."ownerId"
 AND winner."skillPackId" = affected."skillPackId";

-- Retain one piece of history per concrete binding version. Empty bindings
-- are never converted to releases and never inherit SkillPack.version.
CREATE TEMP TABLE "LegacyWorkspaceSkillCorrectiveVersions"
AS
WITH "validBindings" AS (
    SELECT
        ambiguity."installId",
        ambiguity."ownerId",
        ambiguity."skillPackId",
        ambiguity."winnerVersion",
        ambiguity."winnerInstalledAt",
        binding."id" AS "bindingId",
        BTRIM(binding."installedVersion") AS "version",
        COALESCE(
            binding."installedAt",
            binding."createdAt",
            binding."updatedAt"
        ) AS "versionInstalledAt",
        binding."updatedAt" AS "versionUpdatedAt"
    FROM "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
    JOIN "Representative" AS representative
      ON representative."ownerId" = ambiguity."ownerId"
    JOIN "RepresentativeSkillPack" AS binding
      ON binding."representativeId" = representative."id"
     AND binding."skillPackId" = ambiguity."skillPackId"
    WHERE binding."installStatus" IN ('installed', 'update_available')
      AND NULLIF(BTRIM(binding."installedVersion"), '') IS NOT NULL
)
SELECT DISTINCT ON (valid."installId", valid."version")
    valid."installId",
    valid."ownerId",
    valid."skillPackId",
    valid."version",
    valid."versionInstalledAt",
    valid."versionUpdatedAt",
    valid."winnerVersion",
    valid."winnerInstalledAt"
FROM "validBindings" AS valid
ORDER BY
    valid."installId",
    valid."version",
    valid."versionUpdatedAt" DESC,
    valid."bindingId" DESC;

-- Consume the former marker before lifecycle reconciliation. This preserves
-- the audit fact while ensuring an already-converged database is a true no-op
-- if the SQL is evaluated again during a recovery rehearsal.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "reviewedBy" = 'system:migration:20260723224000',
    "reviewedAt" = CURRENT_TIMESTAMP,
    "reviewNote" =
        'Former legacy multi-representative reconciliation marker consumed by the additive fail-closed correction.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE release."installId" = ambiguity."installId"
  AND release."reviewNote" ILIKE
      '%legacy multi-representative version reconciliation%';

-- Release the one-installed-release invariant before selecting the only
-- baseline supported by a concrete binding.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = 'REJECTED'::"WorkspaceSkillReleaseStatus",
    "reviewedBy" = 'system:migration:20260723224000',
    "reviewedAt" = CURRENT_TIMESTAMP,
    "reviewNote" =
        'Rejected by additive legacy workspace-skill ambiguity correction (' ||
        ARRAY_TO_STRING(ambiguity."issueCodes", ',') ||
        '). Catalog metadata is not adoption evidence.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE release."installId" = ambiguity."installId"
  AND release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
  AND (
      ambiguity."winnerVersion" IS NULL
      OR release."version" <> ambiguity."winnerVersion"
  );

-- No concrete binding means there is no trusted installed baseline and no
-- basis for an automatically migrated candidate.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = 'REJECTED'::"WorkspaceSkillReleaseStatus",
    "reviewedBy" = 'system:migration:20260723224000',
    "reviewedAt" = CURRENT_TIMESTAMP,
    "reviewNote" =
        'Rejected by additive legacy workspace-skill ambiguity correction. No concrete historical binding supports this installed or candidate version.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE release."installId" = ambiguity."installId"
  AND ambiguity."winnerVersion" IS NULL
  AND release."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus";

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
    "reviewedBy",
    "reviewedAt",
    "reviewNote",
    "discoveredAt",
    "adoptedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'wsr_legacy_corrective_' ||
        md5(reconciliation."installId" || ':' || reconciliation."version"),
    reconciliation."installId",
    reconciliation."version",
    CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        ELSE 'REJECTED'::"WorkspaceSkillReleaseStatus"
    END,
    pack."displayName",
    pack."summary",
    pack."sourceUrl",
    pack."ownerHandle",
    pack."verificationTier",
    pack."capabilityTags",
    pack."executesCode",
    'system:migration:20260723224000',
    CURRENT_TIMESTAMP,
    CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN 'Selected from a concrete historical binding, then disabled and quarantined for manual review by the additive correction.'
        ELSE 'Retained as rejected legacy history by the additive correction.'
    END,
    reconciliation."versionUpdatedAt",
    CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN reconciliation."winnerInstalledAt"
        ELSE NULL
    END,
    reconciliation."versionInstalledAt",
    CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveVersions" AS reconciliation
JOIN "SkillPack" AS pack
  ON pack."id" = reconciliation."skillPackId"
ON CONFLICT ("installId", "version") DO NOTHING;

UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        ELSE 'REJECTED'::"WorkspaceSkillReleaseStatus"
    END,
    "reviewedBy" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(release."reviewedBy", 'system:migration:20260723224000')
        ELSE 'system:migration:20260723224000'
    END,
    "reviewedAt" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(release."reviewedAt", CURRENT_TIMESTAMP)
        ELSE CURRENT_TIMESTAMP
    END,
    "reviewNote" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(
            release."reviewNote",
            'Selected from a concrete historical binding, then disabled and quarantined for manual review by the additive correction.'
        )
        ELSE 'Retained as rejected legacy history by the additive correction.'
    END,
    "adoptedAt" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(release."adoptedAt", reconciliation."winnerInstalledAt")
        ELSE release."adoptedAt"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveVersions" AS reconciliation
WHERE release."installId" = reconciliation."installId"
  AND release."version" = reconciliation."version";

-- An approval cannot remain pending for an installed or rejected release.
-- An unrelated candidate for a newer catalog version remains pending only
-- when a concrete installed baseline exists.
UPDATE "ApprovalRequest" AS approval
SET
    "status" = CASE
        WHEN release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        THEN 'EXPIRED'::"ApprovalStatus"
        ELSE 'REJECTED'::"ApprovalStatus"
    END,
    "resolvedAt" = CURRENT_TIMESTAMP,
    "resolvedBy" = 'system:migration:20260723224000',
    "decisionNote" = CASE
        WHEN release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        THEN 'Expired by additive legacy correction because this version became the quarantined baseline; this is not a trust approval.'
        ELSE 'Rejected by additive legacy correction because the release is non-runnable history.'
    END
FROM "WorkspaceSkillRelease" AS release
JOIN "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
  ON ambiguity."installId" = release."installId"
WHERE approval."workspaceSkillReleaseId" = release."id"
  AND approval."status" = 'PENDING'::"ApprovalStatus"
  AND release."status" IN (
      'INSTALLED'::"WorkspaceSkillReleaseStatus",
      'REJECTED'::"WorkspaceSkillReleaseStatus"
  );

UPDATE "WorkspaceSkillInstall" AS install
SET
    "installedVersion" = ambiguity."winnerVersion",
    -- WorkspaceSkillInstall.installedAt is NOT NULL in the legacy schema.
    -- When there is no winner it remains audit metadata only; every runtime
    -- authority field below is cleared or fail-closed.
    "installedAt" = COALESCE(
        ambiguity."winnerInstalledAt",
        install."installedAt"
    ),
    "status" = CASE
        WHEN install."status" = 'ARCHIVED'::"WorkspaceSkillInstallStatus"
        THEN install."status"
        WHEN EXISTS (
            SELECT 1
            FROM "WorkspaceSkillRelease" AS candidate
            WHERE candidate."installId" = install."id"
              AND candidate."status" =
                  'CANDIDATE'::"WorkspaceSkillReleaseStatus"
        )
        THEN 'UPDATE_AVAILABLE'::"WorkspaceSkillInstallStatus"
        ELSE 'INSTALLED'::"WorkspaceSkillInstallStatus"
    END,
    "reviewStatus" = CASE
        WHEN install."reviewStatus" =
            'REJECTED'::"WorkspaceSkillReviewStatus"
        THEN install."reviewStatus"
        ELSE 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE install."id" = ambiguity."installId";

-- Disable every binding for the affected owner/skill pair, including any
-- catalog-only `available` binding that could otherwise bypass quarantine.
UPDATE "RepresentativeSkillPack" AS binding
SET
    "enabled" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Representative" AS representative,
     "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE representative."id" = binding."representativeId"
  AND representative."ownerId" = ambiguity."ownerId"
  AND binding."skillPackId" = ambiguity."skillPackId";

UPDATE "RepresentativeSkillPack" AS binding
SET
    "workspaceInstallId" = ambiguity."installId",
    "installStatus" = CASE
        WHEN ambiguity."winnerVersion" IS NULL
        THEN 'available'
        WHEN EXISTS (
            SELECT 1
            FROM "WorkspaceSkillRelease" AS candidate
            WHERE candidate."installId" = ambiguity."installId"
              AND candidate."status" =
                  'CANDIDATE'::"WorkspaceSkillReleaseStatus"
        )
        THEN 'update_available'
        ELSE 'installed'
    END,
    "installedVersion" = ambiguity."winnerVersion",
    "installedAt" = CASE
        WHEN ambiguity."winnerVersion" IS NULL
        THEN NULL
        ELSE ambiguity."winnerInstalledAt"
    END,
    "enabled" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Representative" AS representative,
     "LegacyWorkspaceSkillCorrectiveAmbiguity" AS ambiguity
WHERE representative."id" = binding."representativeId"
  AND representative."ownerId" = ambiguity."ownerId"
  AND binding."skillPackId" = ambiguity."skillPackId"
  AND binding."installStatus" IN ('installed', 'update_available');

DROP TABLE "LegacyWorkspaceSkillCorrectiveVersions";
DROP TABLE "LegacyWorkspaceSkillCorrectiveAmbiguity";
