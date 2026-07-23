\set ON_ERROR_STOP on

-- Read-only preflight for the legacy representative -> workspace skill
-- collapse. A clean result is zero rows. Report every group where version or
-- status history is ambiguous; catalog SkillPack.version is never considered
-- evidence that a version was installed.
BEGIN TRANSACTION READ ONLY;

WITH "legacyBindings" AS (
    SELECT
        representative."ownerId",
        binding."skillPackId",
        pack."source",
        pack."slug",
        binding."id" AS "bindingId",
        binding."installStatus",
        representative."id" AS "representativeId",
        representative."slug" AS "representativeSlug",
        NULLIF(BTRIM(binding."installedVersion"), '') AS "version",
        binding."updatedAt"
    FROM "RepresentativeSkillPack" AS binding
    JOIN "Representative" AS representative
      ON representative."id" = binding."representativeId"
    JOIN "SkillPack" AS pack
      ON pack."id" = binding."skillPackId"
    WHERE binding."installStatus" IN ('installed', 'update_available')
),
"bindingFacts" AS (
    SELECT
        legacy."ownerId",
        legacy."skillPackId",
        MAX(legacy."source"::TEXT)::"SkillPackSource" AS "source",
        MAX(legacy."slug") AS "slug",
        COUNT(*) AS "bindingCount",
        COUNT(DISTINCT legacy."representativeId") AS "representativeCount",
        COUNT(*) FILTER (
            WHERE legacy."version" IS NULL
        ) AS "missingVersionBindingCount",
        COUNT(DISTINCT legacy."version") AS "distinctVersionCount",
        COALESCE(
            ARRAY_AGG(DISTINCT legacy."version" ORDER BY legacy."version")
              FILTER (WHERE legacy."version" IS NOT NULL),
            ARRAY[]::TEXT[]
        ) AS "versions",
        COUNT(DISTINCT legacy."installStatus") AS "distinctStatusCount",
        ARRAY_AGG(
            DISTINCT legacy."installStatus"
            ORDER BY legacy."installStatus"
        ) AS "installStatuses",
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
        legacy."version" AS "selectedVersion",
        legacy."bindingId" AS "selectedBindingId",
        legacy."representativeId" AS "selectedRepresentativeId",
        legacy."representativeSlug" AS "selectedRepresentativeSlug",
        legacy."installStatus" AS "selectedBindingStatus",
        legacy."updatedAt" AS "selectedBindingUpdatedAt"
    FROM "legacyBindings" AS legacy
    WHERE legacy."version" IS NOT NULL
    ORDER BY
        legacy."ownerId",
        legacy."skillPackId",
        legacy."updatedAt" DESC,
        legacy."bindingId" DESC
),
"conflicts" AS (
    SELECT
        facts.*,
        ARRAY_REMOVE(
            ARRAY[
                CASE
                    WHEN facts."missingVersionBindingCount" > 0
                    THEN 'missing_version'
                END,
                CASE
                    WHEN facts."distinctVersionCount" > 1
                    THEN 'version_conflict'
                END,
                CASE
                    WHEN facts."distinctStatusCount" > 1
                    THEN 'status_conflict'
                END
            ],
            NULL
        ) AS "issueCodes",
        winner."selectedVersion",
        winner."selectedBindingId",
        winner."selectedRepresentativeId",
        winner."selectedRepresentativeSlug",
        winner."selectedBindingStatus",
        winner."selectedBindingUpdatedAt"
    FROM "bindingFacts" AS facts
    LEFT JOIN "winnerBindings" AS winner
      ON winner."ownerId" = facts."ownerId"
     AND winner."skillPackId" = facts."skillPackId"
    WHERE facts."missingVersionBindingCount" > 0
       OR facts."distinctVersionCount" > 1
       OR facts."distinctStatusCount" > 1
)
SELECT
    conflict."ownerId",
    conflict."skillPackId",
    conflict."source",
    conflict."slug",
    conflict."issueCodes",
    conflict."bindingCount",
    conflict."representativeCount",
    conflict."missingVersionBindingCount",
    conflict."distinctVersionCount",
    conflict."versions",
    conflict."distinctStatusCount",
    conflict."installStatuses",
    conflict."installedStatusBindingCount",
    conflict."updateAvailableStatusBindingCount",
    conflict."selectedVersion",
    conflict."selectedBindingId",
    conflict."selectedRepresentativeId",
    conflict."selectedRepresentativeSlug",
    conflict."selectedBindingStatus",
    conflict."selectedBindingUpdatedAt",
    (
        SELECT COUNT(*)
        FROM (
            -- Existing installed or observed-version releases are reconciled.
            -- When no valid baseline exists, migrated catalog candidates are
            -- also rejected by the quarantine migration.
            SELECT release."version"
            FROM "WorkspaceSkillInstall" AS install
            JOIN "WorkspaceSkillRelease" AS release
              ON release."installId" = install."id"
            WHERE install."ownerId" = conflict."ownerId"
              AND install."skillPackId" = conflict."skillPackId"
              AND (
                  release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
                  OR release."version" = ANY(conflict."versions")
                  OR (
                      conflict."selectedVersion" IS NULL
                      AND release."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus"
                  )
              )
            UNION
            SELECT UNNEST(conflict."versions")
        ) AS "affectedReleases"
    ) AS "affectedReleaseCount",
    (
        SELECT COUNT(*)
        FROM "WorkspaceSkillInstall" AS install
        JOIN "WorkspaceSkillRelease" AS release
          ON release."installId" = install."id"
        JOIN "ApprovalRequest" AS approval
          ON approval."workspaceSkillReleaseId" = release."id"
        WHERE install."ownerId" = conflict."ownerId"
          AND install."skillPackId" = conflict."skillPackId"
          AND approval."status" = 'PENDING'::"ApprovalStatus"
          AND (
              release."status" = 'INSTALLED'::"WorkspaceSkillReleaseStatus"
              OR release."version" = ANY(conflict."versions")
              OR (
                  conflict."selectedVersion" IS NULL
                  AND release."status" = 'CANDIDATE'::"WorkspaceSkillReleaseStatus"
              )
          )
    ) AS "affectedPendingApprovalCount"
FROM "conflicts" AS conflict
ORDER BY conflict."ownerId", conflict."slug";

ROLLBACK;
