-- The initial workspace-skill backfill collapsed representative-scoped rows
-- into one owner + skill installation. Legacy rows can disagree on version or
-- status, and some rows contain no concrete installed version at all.
--
-- A catalog `SkillPack.version` is never adoption evidence. Only a non-empty
-- legacy binding version can become the deterministic workspace winner. Every
-- ambiguous installation is quarantined for manual review and every related
-- binding is disabled. The newest valid binding wins by updatedAt DESC, id
-- DESC; when no valid binding exists, the installation has no installed
-- version or installed release.
CREATE TEMP TABLE "LegacyWorkspaceSkillAmbiguity"
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
        COUNT(*) FILTER (
            WHERE legacy."version" IS NULL
        ) AS "missingVersionBindingCount",
        COUNT(DISTINCT legacy."version") AS "distinctValidVersionCount",
        COUNT(DISTINCT legacy."installStatus") AS "distinctStatusCount",
        COUNT(*) FILTER (
            WHERE legacy."installStatus" = 'installed'
        ) AS "installedStatusBindingCount",
        COUNT(*) FILTER (
            WHERE legacy."installStatus" = 'update_available'
        ) AS "updateAvailableStatusBindingCount"
    FROM "legacyBindings" AS legacy
    GROUP BY legacy."ownerId", legacy."skillPackId"
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
    WHERE legacy."version" IS NOT NULL
    ORDER BY
        legacy."ownerId",
        legacy."skillPackId",
        legacy."updatedAt" DESC,
        legacy."bindingId" DESC
)
SELECT
    install."id" AS "installId",
    facts."ownerId",
    facts."skillPackId",
    facts."bindingCount",
    facts."missingVersionBindingCount",
    facts."distinctValidVersionCount",
    facts."distinctStatusCount",
    facts."installedStatusBindingCount",
    facts."updateAvailableStatusBindingCount",
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
    ) AS "issueCodes",
    winner."winnerBindingId",
    winner."winnerVersion",
    winner."winnerInstallStatus",
    winner."winnerInstalledAt",
    winner."winnerBindingUpdatedAt"
FROM "bindingFacts" AS facts
JOIN "WorkspaceSkillInstall" AS install
  ON install."ownerId" = facts."ownerId"
 AND install."skillPackId" = facts."skillPackId"
LEFT JOIN "winnerBindings" AS winner
  ON winner."ownerId" = facts."ownerId"
 AND winner."skillPackId" = facts."skillPackId"
WHERE facts."missingVersionBindingCount" > 0
   OR facts."distinctValidVersionCount" > 1
   OR facts."distinctStatusCount" > 1;

-- Keep one row per concrete historical version. Missing values are never
-- materialized as releases and never fall back to the catalog version.
CREATE TEMP TABLE "LegacyWorkspaceSkillVersionReconciliation"
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
    FROM "LegacyWorkspaceSkillAmbiguity" AS ambiguity
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

-- Free the one-installed-release invariant before selecting a winner. This
-- rejects both stale installed releases and any catalog-derived installed
-- release when no valid historical binding exists.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = 'REJECTED'::"WorkspaceSkillReleaseStatus",
    "reviewedBy" = 'system:migration:20260723220000',
    "reviewedAt" = CURRENT_TIMESTAMP,
    "reviewNote" =
        'Rejected during legacy workspace-skill ambiguity quarantine (' ||
        ARRAY_TO_STRING(ambiguity."issueCodes", ',') ||
        '). Only a non-empty historical binding can establish an installed version; catalog metadata is not adoption evidence.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillAmbiguity" AS ambiguity
WHERE release."installId" = ambiguity."installId"
  AND release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
  AND (
      ambiguity."winnerVersion" IS NULL
      OR release."version" <> ambiguity."winnerVersion"
  );

-- Without any valid historical binding there is no baseline from which a
-- catalog update can be evaluated. Reject migrated candidates as well.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = 'REJECTED'::"WorkspaceSkillReleaseStatus",
    "reviewedBy" = 'system:migration:20260723220000',
    "reviewedAt" = CURRENT_TIMESTAMP,
    "reviewNote" =
        'Rejected during legacy workspace-skill ambiguity quarantine (missing_version). No valid historical binding exists, so neither an installed release nor a catalog-derived update candidate can be trusted.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillAmbiguity" AS ambiguity
WHERE release."installId" = ambiguity."installId"
  AND ambiguity."winnerVersion" IS NULL
  AND release."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus";

-- Materialize only concrete versions observed on historical bindings.
-- SkillPack fields are descriptive catalog fallbacks; they do not determine
-- the release version or make the release runnable.
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
    'wsr_legacy_' || md5(reconciliation."installId" || ':' || reconciliation."version"),
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
    'system:migration:20260723220000',
    CURRENT_TIMESTAMP,
    CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN 'Selected from a concrete historical binding by updatedAt DESC, id DESC, then quarantined for manual review. Catalog version metadata was not used as adoption evidence.'
        ELSE 'Rejected as non-runnable legacy history. A different concrete historical binding version was selected deterministically; exact version metadata and trust evidence remain unavailable.'
    END,
    reconciliation."versionUpdatedAt",
    CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN reconciliation."winnerInstalledAt"
        ELSE NULL
    END,
    reconciliation."versionInstalledAt",
    CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillVersionReconciliation" AS reconciliation
JOIN "SkillPack" AS pack
  ON pack."id" = reconciliation."skillPackId"
ON CONFLICT ("installId", "version") DO NOTHING;

-- Existing releases retain their stored metadata and trust evidence. Only
-- lifecycle state is reconciled; every affected installation remains under
-- manual review and its bindings are disabled below.
UPDATE "WorkspaceSkillRelease" AS release
SET
    "status" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        ELSE 'REJECTED'::"WorkspaceSkillReleaseStatus"
    END,
    "reviewedBy" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(release."reviewedBy", 'system:migration:20260723220000')
        ELSE 'system:migration:20260723220000'
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
            'Selected from a concrete historical binding by updatedAt DESC, id DESC, then quarantined for manual review. Catalog version metadata was not used as adoption evidence.'
        )
        ELSE 'Rejected as non-runnable legacy history. A different concrete historical binding version was selected deterministically; exact version metadata and trust evidence remain unavailable.'
    END,
    "adoptedAt" = CASE
        WHEN reconciliation."version" = reconciliation."winnerVersion"
        THEN COALESCE(release."adoptedAt", reconciliation."winnerInstalledAt")
        ELSE release."adoptedAt"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillVersionReconciliation" AS reconciliation
WHERE release."installId" = reconciliation."installId"
  AND release."version" = reconciliation."version";

-- A pending decision may not point at a release that reconciliation just made
-- installed or permanently non-runnable. Unrelated, still-candidate catalog
-- updates remain pending when a valid historical baseline exists.
UPDATE "ApprovalRequest" AS approval
SET
    "status" = CASE
        WHEN release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        THEN 'EXPIRED'::"ApprovalStatus"
        ELSE 'REJECTED'::"ApprovalStatus"
    END,
    "resolvedAt" = CURRENT_TIMESTAMP,
    "resolvedBy" = 'system:migration:20260723220000',
    "decisionNote" = CASE
        WHEN release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
        THEN 'Expired by legacy workspace-skill ambiguity quarantine because a concrete historical binding became the selected baseline. This is not a trust approval; the installation still requires manual review.'
        ELSE 'Closed by legacy workspace-skill ambiguity quarantine; this release is retained as rejected, non-runnable history.'
    END
FROM "WorkspaceSkillRelease" AS release
JOIN "LegacyWorkspaceSkillAmbiguity" AS ambiguity
  ON ambiguity."installId" = release."installId"
WHERE approval."workspaceSkillReleaseId" = release."id"
  AND approval."status" = 'PENDING'::"ApprovalStatus"
  AND release."status" IN (
      'INSTALLED'::"WorkspaceSkillReleaseStatus",
      'REJECTED'::"WorkspaceSkillReleaseStatus"
  );

-- Preserve explicit rejection and archive decisions. Every other ambiguous
-- install is fail-closed under NEEDS_REVIEW. A catalog candidate may keep the
-- projected UPDATE_AVAILABLE status, but it is not adopted automatically.
UPDATE "WorkspaceSkillInstall" AS install
SET
    "installedVersion" = ambiguity."winnerVersion",
    -- This column is NOT NULL in the legacy schema. With no winner it remains
    -- historical audit metadata only; installedVersion, releases, review
    -- state, and disabled bindings are the runtime authority.
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
              AND candidate."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus"
        )
        THEN 'UPDATE_AVAILABLE'::"WorkspaceSkillInstallStatus"
        ELSE 'INSTALLED'::"WorkspaceSkillInstallStatus"
    END,
    "reviewStatus" = CASE
        WHEN install."reviewStatus" = 'REJECTED'::"WorkspaceSkillReviewStatus"
        THEN install."reviewStatus"
        ELSE 'NEEDS_REVIEW'::"WorkspaceSkillReviewStatus"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "LegacyWorkspaceSkillAmbiguity" AS ambiguity
WHERE install."id" = ambiguity."installId";

-- Quarantine the entire owner/skill surface. This includes catalog-only
-- `available` bindings so an already-enabled row cannot bypass the ambiguous
-- legacy installation.
UPDATE "RepresentativeSkillPack" AS binding
SET
    "enabled" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Representative" AS representative,
     "LegacyWorkspaceSkillAmbiguity" AS ambiguity
WHERE representative."id" = binding."representativeId"
  AND representative."ownerId" = ambiguity."ownerId"
  AND binding."skillPackId" = ambiguity."skillPackId";

-- Normalize legacy installed/update_available rows into a consistent,
-- disabled state. When no concrete version exists, demote them to `available`
-- and clear adoption fields instead of inventing a catalog-derived version.
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
              AND candidate."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus"
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
     "LegacyWorkspaceSkillAmbiguity" AS ambiguity
WHERE representative."id" = binding."representativeId"
  AND representative."ownerId" = ambiguity."ownerId"
  AND binding."skillPackId" = ambiguity."skillPackId"
  AND binding."installStatus" IN ('installed', 'update_available');

DROP TABLE "LegacyWorkspaceSkillVersionReconciliation";
DROP TABLE "LegacyWorkspaceSkillAmbiguity";
