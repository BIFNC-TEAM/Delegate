#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/delegate-workspace-skill-migration.XXXXXX)"
FIXTURE_CONTAINER="delegate-workspace-skill-migration-$$"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi

  if [[ -d "$FIXTURE_ROOT" && "$FIXTURE_ROOT" == /tmp/delegate-workspace-skill-migration.* ]]; then
    find "$FIXTURE_ROOT" -depth -delete
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 migration fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the disposable PostgreSQL 16 migration fixture.\n' >&2
  exit 2
}

mkdir -p \
  "$FIXTURE_ROOT/pre/prisma/migrations" \
  "$FIXTURE_ROOT/mid/prisma/migrations" \
  "$FIXTURE_ROOT/legacy/prisma/migrations" \
  "$FIXTURE_ROOT/full/prisma/migrations"

for STAGE in pre mid legacy full; do
  cp "$REPO_ROOT/prisma/schema.prisma" "$FIXTURE_ROOT/$STAGE/prisma/schema.prisma"
  cp \
    "$REPO_ROOT/prisma/migrations/migration_lock.toml" \
    "$FIXTURE_ROOT/$STAGE/prisma/migrations/migration_lock.toml"
done

for MIGRATION_DIR in "$REPO_ROOT"/prisma/migrations/20*; do
  MIGRATION_NAME="${MIGRATION_DIR##*/}"
  cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/full/prisma/migrations/$MIGRATION_NAME"

  if [[ "$MIGRATION_NAME" < "20260723113000_workspace_skill_governance" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/pre/prisma/migrations/$MIGRATION_NAME"
  fi

  if [[ "$MIGRATION_NAME" < "20260723220000_reconcile_legacy_multi_representative_skill_versions" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/mid/prisma/migrations/$MIGRATION_NAME"
  fi

  if [[ "$MIGRATION_NAME" < "20260723224000_workspace_skill_legacy_ambiguity_corrective" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/legacy/prisma/migrations/$MIGRATION_NAME"
  fi
done

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=workspace_skill_fixture_only \
  --env POSTGRES_DB=delegate_fixture \
  --publish 127.0.0.1::5432 \
  --health-cmd='pg_isready -U postgres -d delegate_fixture' \
  --health-interval=1s \
  --health-timeout=2s \
  --health-retries=30 \
  postgres:16-alpine >/dev/null
FIXTURE_CONTAINER_STARTED="true"

FIXTURE_READY="false"
for _ in {1..35}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$FIXTURE_CONTAINER")" == "healthy" ]]; then
    FIXTURE_READY="true"
    break
  fi
  sleep 1
done

if [[ "$FIXTURE_READY" != "true" ]]; then
  docker logs "$FIXTURE_CONTAINER"
  exit 3
fi

FIXTURE_PORT="$(
  docker port "$FIXTURE_CONTAINER" 5432/tcp |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
FIXTURE_DATABASE_URL="postgresql://postgres:workspace_skill_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_fixture"

printf 'phase=deploy_pre_workspace_skill_migrations\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/pre/prisma/schema.prisma" >/dev/null

printf 'phase=insert_legacy_fixture_matrix\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "Owner" ("id", "displayName", "updatedAt")
VALUES ('owner_fixture', 'Migration Fixture Owner', CURRENT_TIMESTAMP);

INSERT INTO "Representative" (
    "id",
    "ownerId",
    "slug",
    "displayName",
    "roleSummary",
    "tone",
    "allowedSkills",
    "actionGate",
    "languages",
    "freeScope",
    "paywalledIntents",
    "handoffPrompt",
    "updatedAt"
)
SELECT
    fixture."id",
    'owner_fixture',
    fixture."id",
    fixture."id",
    'fixture',
    'neutral',
    '[]'::JSONB,
    '{}'::JSONB,
    '["en"]'::JSONB,
    '[]'::JSONB,
    '[]'::JSONB,
    'handoff',
    CURRENT_TIMESTAMP
FROM (
    VALUES
        ('rep_en_valid'),
        ('rep_en_empty'),
        ('rep_me_null'),
        ('rep_me_blank'),
        ('rep_sc_installed'),
        ('rep_sc_update'),
        ('rep_vs_installed'),
        ('rep_vs_update'),
        ('rep_catalog_empty'),
        ('rep_clean_one'),
        ('rep_clean_two')
) AS fixture("id");

INSERT INTO "SkillPack" (
    "id",
    "source",
    "slug",
    "displayName",
    "summary",
    "version",
    "capabilityTags",
    "updatedAt"
)
VALUES
    ('skill_empty_nonempty', 'BUILTIN', 'empty-nonempty', 'Empty + valid', 'fixture', '9.0.0', '[]'::JSONB, CURRENT_TIMESTAMP),
    ('skill_multi_empty', 'BUILTIN', 'multi-empty', 'Multiple empty', 'fixture', '9.0.0', '[]'::JSONB, CURRENT_TIMESTAMP),
    ('skill_status_conflict', 'BUILTIN', 'status-conflict', 'Status conflict', 'fixture', '9.0.0', '[]'::JSONB, CURRENT_TIMESTAMP),
    ('skill_version_status', 'BUILTIN', 'version-status-conflict', 'Version + status conflict', 'fixture', '9.0.0', '[]'::JSONB, CURRENT_TIMESTAMP),
    ('skill_catalog_empty', 'BUILTIN', 'catalog-empty', 'Catalog only', 'fixture', '99.0.0', '[]'::JSONB, CURRENT_TIMESTAMP),
    ('skill_clean', 'BUILTIN', 'clean-history', 'Clean history', 'fixture', '9.0.0', '[]'::JSONB, CURRENT_TIMESTAMP);

INSERT INTO "RepresentativeSkillPack" (
    "id",
    "representativeId",
    "skillPackId",
    "enabled",
    "installStatus",
    "installedVersion",
    "installedAt",
    "createdAt",
    "updatedAt"
)
VALUES
    ('binding_en_valid', 'rep_en_valid', 'skill_empty_nonempty', true, 'installed', '1.0.0', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_en_empty', 'rep_en_empty', 'skill_empty_nonempty', true, 'installed', '   ', NULL, TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01'),
    ('binding_me_null', 'rep_me_null', 'skill_multi_empty', true, 'installed', NULL, NULL, TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_me_blank', 'rep_me_blank', 'skill_multi_empty', true, 'installed', '', NULL, TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01'),
    ('binding_sc_installed', 'rep_sc_installed', 'skill_status_conflict', true, 'installed', '1.0.0', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_sc_update', 'rep_sc_update', 'skill_status_conflict', true, 'update_available', '1.0.0', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01'),
    ('binding_vs_installed', 'rep_vs_installed', 'skill_version_status', true, 'installed', '1.0.0', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_vs_update', 'rep_vs_update', 'skill_version_status', true, 'update_available', '2.0.0', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01'),
    ('binding_catalog_empty', 'rep_catalog_empty', 'skill_catalog_empty', true, 'update_available', NULL, NULL, TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_clean_one', 'rep_clean_one', 'skill_clean', true, 'installed', '1.0.0', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-01'),
    ('binding_clean_two', 'rep_clean_two', 'skill_clean', true, 'installed', '1.0.0', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01');
SQL

printf 'phase=deploy_through_pre_quarantine_migration\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/mid/prisma/schema.prisma" >/dev/null

# Preserve the exact pre-reconciliation fixture in a second database. Its
# migration history will record the former 220 migration as already applied,
# then only the additive 2240 migration will be allowed to repair the manually
# reproduced old state.
docker exec "$FIXTURE_CONTAINER" \
  createdb -U postgres --template delegate_fixture delegate_corrective_fixture

printf 'phase=assert_preflight_reports_all_ambiguities\n'
PREFLIGHT_BEFORE="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/workspace-skill-legacy-version-conflicts.sql"
)"
printf '%s\n' "$PREFLIGHT_BEFORE"

PREFLIGHT_BEFORE_ROWS="$(
  printf '%s\n' "$PREFLIGHT_BEFORE" |
    awk 'NR > 1 && length($0) > 0 { count += 1 } END { print count + 0 }'
)"
[[ "$PREFLIGHT_BEFORE_ROWS" -eq 5 ]] || {
  printf 'Expected 5 preflight ambiguity groups, found %s.\n' "$PREFLIGHT_BEFORE_ROWS" >&2
  exit 4
}

printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'empty-nonempty' | grep -F 'missing_version' >/dev/null
printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'multi-empty' | grep -F 'missing_version' >/dev/null
printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'status-conflict' | grep -F 'status_conflict' >/dev/null
printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'version-status-conflict' | grep -F 'version_conflict' | grep -F 'status_conflict' >/dev/null
printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'catalog-empty' | grep -F 'missing_version' >/dev/null
if printf '%s\n' "$PREFLIGHT_BEFORE" | grep -F 'clean-history' >/dev/null; then
  printf 'Clean same-version history must not be reported as ambiguous.\n' >&2
  exit 4
fi

printf 'phase=deploy_quarantine_and_later_migrations\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma" >/dev/null

printf 'phase=assert_postflight_and_safe_state\n'
PREFLIGHT_AFTER="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/workspace-skill-legacy-version-conflicts.sql"
)"
PREFLIGHT_AFTER_ROWS="$(
  printf '%s\n' "$PREFLIGHT_AFTER" |
    awk 'NR > 1 && length($0) > 0 { count += 1 } END { print count + 0 }'
)"
[[ "$PREFLIGHT_AFTER_ROWS" -eq 0 ]] || {
  printf '%s\n' "$PREFLIGHT_AFTER" >&2
  printf 'Postflight must return zero ambiguity groups.\n' >&2
  exit 5
}

docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fixture$
DECLARE
    install_id TEXT;
BEGIN
    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'empty-nonempty';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" = '1.0.0'
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) THEN
        RAISE EXCEPTION 'empty+valid install did not select the concrete version under manual review';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_empty_nonempty'
          AND ("enabled" = true OR "installStatus" <> 'installed'
            OR "installedVersion" IS DISTINCT FROM '1.0.0')
    ) THEN
        RAISE EXCEPTION 'empty+valid bindings were not normalized and disabled';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '1.0.0'
          AND "status" = 'INSTALLED'
    ) OR EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '9.0.0'
    ) THEN
        RAISE EXCEPTION 'catalog version became adopted for empty+valid history';
    END IF;

    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'multi-empty';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" IS NULL
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) OR EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "status" IN ('INSTALLED', 'CANDIDATE')
    ) THEN
        RAISE EXCEPTION 'all-empty history retained an adopted or candidate release';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_multi_empty'
          AND ("enabled" = true OR "installStatus" <> 'available'
            OR "installedVersion" IS NOT NULL OR "installedAt" IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'all-empty bindings were not demoted and disabled';
    END IF;

    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'status-conflict';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" = '1.0.0'
          AND "status" = 'UPDATE_AVAILABLE'
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) THEN
        RAISE EXCEPTION 'same-version status conflict did not remain quarantined';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_status_conflict'
          AND ("enabled" = true OR "installStatus" <> 'update_available'
            OR "installedVersion" IS DISTINCT FROM '1.0.0')
    ) THEN
        RAISE EXCEPTION 'same-version status conflict bindings are not consistent and disabled';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '1.0.0' AND "status" = 'INSTALLED'
    ) OR NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '9.0.0' AND "status" = 'CANDIDATE'
    ) OR NOT EXISTS (
        SELECT 1 FROM "ApprovalRequest" AS approval
        JOIN "WorkspaceSkillRelease" AS release
          ON release."id" = approval."workspaceSkillReleaseId"
        WHERE release."installId" = install_id AND release."version" = '9.0.0'
          AND approval."status" = 'PENDING'
    ) THEN
        RAISE EXCEPTION 'safe catalog candidate approval was not preserved for status conflict';
    END IF;

    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'version-status-conflict';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" = '2.0.0'
          AND "status" = 'UPDATE_AVAILABLE'
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) OR NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '1.0.0' AND "status" = 'REJECTED'
    ) OR NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '2.0.0' AND "status" = 'INSTALLED'
    ) OR NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '9.0.0' AND "status" = 'CANDIDATE'
    ) THEN
        RAISE EXCEPTION 'version+status conflict did not retain safe release history';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_version_status'
          AND ("enabled" = true OR "installStatus" <> 'update_available'
            OR "installedVersion" IS DISTINCT FROM '2.0.0')
    ) THEN
        RAISE EXCEPTION 'version+status conflict bindings are not consistent and disabled';
    END IF;

    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'catalog-empty';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" IS NULL
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) OR EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease" WHERE "installId" = install_id
    ) OR EXISTS (
        SELECT 1 FROM "ApprovalRequest" AS approval
        JOIN "WorkspaceSkillRelease" AS release
          ON release."id" = approval."workspaceSkillReleaseId"
        WHERE release."installId" = install_id
    ) THEN
        RAISE EXCEPTION 'catalog-only version was treated as an adopted or reviewable release';
    END IF;

    SELECT install."id" INTO install_id
    FROM "WorkspaceSkillInstall" AS install
    JOIN "SkillPack" AS pack ON pack."id" = install."skillPackId"
    WHERE pack."slug" = 'clean-history';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = install_id AND "installedVersion" = '1.0.0'
          AND "reviewStatus" = 'APPROVED'
    ) OR EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_clean' AND "enabled" = false
    ) OR EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = install_id AND "version" = '9.0.0'
    ) THEN
        RAISE EXCEPTION 'clean same-version history was quarantined or adopted catalog metadata';
    END IF;
END
$fixture$;
SQL

EXPECTED_MIGRATION_COUNT="$(
  find "$FIXTURE_ROOT/full/prisma/migrations" -mindepth 1 -maxdepth 1 -type d |
    wc -l |
    tr -d ' '
)"
DATABASE_MIGRATION_COUNT="$(
  docker exec "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture -X --tuples-only --no-align \
    --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;'
)"
[[ "$DATABASE_MIGRATION_COUNT" -eq "$EXPECTED_MIGRATION_COUNT" ]] || {
  printf 'Expected %s applied migrations, found %s.\n' \
    "$EXPECTED_MIGRATION_COUNT" "$DATABASE_MIGRATION_COUNT" >&2
  exit 6
}

DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate status \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma" >/dev/null

printf 'phase=simulate_previously_applied_legacy_reconciliation\n'
CORRECTIVE_DATABASE_URL="postgresql://postgres:workspace_skill_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_corrective_fixture"

# The clone already contains every migration before 220. Mark 220 as applied
# without executing the current SQL, then deploy the remaining pre-corrective
# migration (2230). This models an environment whose historical checksum and
# data came from the former implementation.
DATABASE_URL="$CORRECTIVE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate resolve \
  --applied 20260723220000_reconcile_legacy_multi_representative_skill_versions \
  --schema "$FIXTURE_ROOT/legacy/prisma/schema.prisma" >/dev/null
DATABASE_URL="$CORRECTIVE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/legacy/prisma/schema.prisma" >/dev/null

docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_corrective_fixture \
  -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fixture$
DECLARE
    catalog_install_id TEXT;
    baseline_install_id TEXT;
BEGIN
    SELECT install."id" INTO catalog_install_id
    FROM "WorkspaceSkillInstall" AS install
    WHERE install."skillPackId" = 'skill_catalog_empty';

    -- Former backfill behavior could treat SkillPack.version as proof of an
    -- installed version even though every historical binding was empty.
    UPDATE "WorkspaceSkillInstall"
    SET
        "installedVersion" = '99.0.0',
        "installedAt" = TIMESTAMP '2026-01-01',
        "status" = 'INSTALLED',
        "reviewStatus" = 'APPROVED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = catalog_install_id;

    INSERT INTO "WorkspaceSkillRelease" (
        "id",
        "installId",
        "version",
        "status",
        "displayName",
        "summary",
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
        'release_old_catalog_derived',
        catalog_install_id,
        '99.0.0',
        'INSTALLED',
        pack."displayName",
        pack."summary",
        pack."capabilityTags",
        pack."executesCode",
        'system:migration:20260723220000',
        CURRENT_TIMESTAMP,
        'Selected by legacy multi-representative version reconciliation using the former catalog fallback.',
        CURRENT_TIMESTAMP,
        TIMESTAMP '2026-01-01',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    FROM "SkillPack" AS pack
    WHERE pack."id" = 'skill_catalog_empty'
    ON CONFLICT ("installId", "version") DO UPDATE
    SET
        "status" = EXCLUDED."status",
        "reviewedBy" = EXCLUDED."reviewedBy",
        "reviewedAt" = EXCLUDED."reviewedAt",
        "reviewNote" = EXCLUDED."reviewNote",
        "adoptedAt" = EXCLUDED."adoptedAt",
        "updatedAt" = EXCLUDED."updatedAt";

    INSERT INTO "ApprovalRequest" (
        "id",
        "representativeId",
        "workspaceSkillReleaseId",
        "status",
        "reason",
        "requestedActionSummary",
        "riskSummary",
        "requestedAt"
    )
    SELECT
        'approval_old_catalog_derived',
        'rep_catalog_empty',
        release."id",
        'PENDING',
        'legacy_fixture',
        'Erroneous approval for catalog-derived installed release',
        'Must be closed by the additive correction',
        CURRENT_TIMESTAMP
    FROM "WorkspaceSkillRelease" AS release
    WHERE release."installId" = catalog_install_id
      AND release."version" = '99.0.0'
    ON CONFLICT ("workspaceSkillReleaseId") DO UPDATE
    SET
        "status" = 'PENDING',
        "resolvedAt" = NULL,
        "resolvedBy" = NULL,
        "decisionNote" = NULL;

    SELECT install."id" INTO baseline_install_id
    FROM "WorkspaceSkillInstall" AS install
    WHERE install."skillPackId" = 'skill_status_conflict';

    -- The former reconciliation also normalized binding disagreement, making
    -- the original ambiguity invisible to the live preflight. Keep a valid
    -- concrete baseline plus a catalog candidate to prove the corrective
    -- migration quarantines the baseline without adopting the candidate.
    UPDATE "RepresentativeSkillPack"
    SET
        "workspaceInstallId" = baseline_install_id,
        "enabled" = true,
        "installStatus" = 'update_available',
        "installedVersion" = '1.0.0',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "skillPackId" = 'skill_status_conflict';

    UPDATE "WorkspaceSkillInstall"
    SET
        "installedVersion" = '1.0.0',
        "status" = 'UPDATE_AVAILABLE',
        "reviewStatus" = 'APPROVED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = baseline_install_id;

    UPDATE "WorkspaceSkillRelease"
    SET
        "status" = CASE
            WHEN "version" = '1.0.0' THEN 'INSTALLED'::"WorkspaceSkillReleaseStatus"
            ELSE "status"
        END,
        "reviewedBy" = CASE
            WHEN "version" = '1.0.0'
            THEN 'system:migration:20260723220000'
            ELSE "reviewedBy"
        END,
        "reviewedAt" = CASE
            WHEN "version" = '1.0.0'
            THEN CURRENT_TIMESTAMP
            ELSE "reviewedAt"
        END,
        "reviewNote" = CASE
            WHEN "version" = '1.0.0'
            THEN 'Selected by legacy multi-representative version reconciliation after normalizing the former conflict.'
            ELSE "reviewNote"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "installId" = baseline_install_id;
END
$fixture$;
SQL

CORRECTIVE_PREFLIGHT_BEFORE="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_corrective_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/workspace-skill-legacy-version-conflicts.sql"
)"
printf '%s\n' "$CORRECTIVE_PREFLIGHT_BEFORE"
printf '%s\n' "$CORRECTIVE_PREFLIGHT_BEFORE" |
  grep -F 'catalog-empty' |
  grep -F 'missing_version' >/dev/null
if printf '%s\n' "$CORRECTIVE_PREFLIGHT_BEFORE" |
  grep -F ',status-conflict,' >/dev/null; then
  printf 'Normalized old status conflict should be detectable only by the former migration marker.\n' >&2
  exit 7
fi

CORRECTIVE_MIGRATION_COUNT_BEFORE="$(
  docker exec "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_corrective_fixture \
    -X --tuples-only --no-align \
    --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;'
)"

printf 'phase=deploy_only_additive_corrective_migration\n'
DATABASE_URL="$CORRECTIVE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma" >/dev/null

CORRECTIVE_MIGRATION_COUNT_AFTER="$(
  docker exec "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_corrective_fixture \
    -X --tuples-only --no-align \
    --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;'
)"
[[ "$CORRECTIVE_MIGRATION_COUNT_AFTER" -eq $((CORRECTIVE_MIGRATION_COUNT_BEFORE + 1)) ]] || {
  printf 'Expected only one corrective migration; count changed from %s to %s.\n' \
    "$CORRECTIVE_MIGRATION_COUNT_BEFORE" "$CORRECTIVE_MIGRATION_COUNT_AFTER" >&2
  exit 8
}

docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_corrective_fixture \
  -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fixture$
DECLARE
    catalog_install_id TEXT;
    baseline_install_id TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE "migration_name" =
            '20260723224000_workspace_skill_legacy_ambiguity_corrective'
          AND "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
    ) THEN
        RAISE EXCEPTION 'additive corrective migration was not recorded';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM "WorkspaceSkillRelease"
        WHERE "reviewNote" ILIKE
            '%legacy multi-representative version reconciliation%'
    ) THEN
        RAISE EXCEPTION 'former reconciliation marker was not consumed';
    END IF;

    SELECT install."id" INTO catalog_install_id
    FROM "WorkspaceSkillInstall" AS install
    WHERE install."skillPackId" = 'skill_catalog_empty';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = catalog_install_id
          AND "installedVersion" IS NULL
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) THEN
        RAISE EXCEPTION 'unsupported catalog-derived installed version was not cleared';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = catalog_install_id
          AND "version" = '99.0.0'
          AND "status" = 'REJECTED'
          AND "reviewedBy" = 'system:migration:20260723224000'
    ) THEN
        RAISE EXCEPTION 'unsupported catalog-derived release was not rejected';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "ApprovalRequest"
        WHERE "id" = 'approval_old_catalog_derived'
          AND "status" = 'REJECTED'
          AND "resolvedAt" IS NOT NULL
          AND "resolvedBy" = 'system:migration:20260723224000'
    ) THEN
        RAISE EXCEPTION 'erroneous pending approval was not closed';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_catalog_empty'
          AND (
              "enabled" = true
              OR "installStatus" <> 'available'
              OR "installedVersion" IS NOT NULL
              OR "installedAt" IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'catalog-derived binding was not disabled and cleared';
    END IF;

    SELECT install."id" INTO baseline_install_id
    FROM "WorkspaceSkillInstall" AS install
    WHERE install."skillPackId" = 'skill_status_conflict';

    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillInstall"
        WHERE "id" = baseline_install_id
          AND "installedVersion" = '1.0.0'
          AND "status" = 'UPDATE_AVAILABLE'
          AND "reviewStatus" = 'NEEDS_REVIEW'
    ) THEN
        RAISE EXCEPTION 'marker-only valid baseline was not quarantined';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "RepresentativeSkillPack"
        WHERE "skillPackId" = 'skill_status_conflict'
          AND (
              "enabled" = true
              OR "installedVersion" IS DISTINCT FROM '1.0.0'
              OR "installStatus" <> 'update_available'
          )
    ) THEN
        RAISE EXCEPTION 'marker-only bindings were not disabled and normalized';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = baseline_install_id
          AND "version" = '1.0.0'
          AND "status" = 'INSTALLED'
    ) OR NOT EXISTS (
        SELECT 1 FROM "WorkspaceSkillRelease"
        WHERE "installId" = baseline_install_id
          AND "version" = '9.0.0'
          AND "status" = 'CANDIDATE'
    ) OR NOT EXISTS (
        SELECT 1
        FROM "ApprovalRequest" AS approval
        JOIN "WorkspaceSkillRelease" AS release
          ON release."id" = approval."workspaceSkillReleaseId"
        WHERE release."installId" = baseline_install_id
          AND release."version" = '9.0.0'
          AND approval."status" = 'PENDING'
    ) THEN
        RAISE EXCEPTION 'catalog candidate was adopted or its pending review was lost';
    END IF;
END
$fixture$;
SQL

CORRECTIVE_PREFLIGHT_AFTER="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_corrective_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/workspace-skill-legacy-version-conflicts.sql"
)"
CORRECTIVE_PREFLIGHT_AFTER_ROWS="$(
  printf '%s\n' "$CORRECTIVE_PREFLIGHT_AFTER" |
    awk 'NR > 1 && length($0) > 0 { count += 1 } END { print count + 0 }'
)"
[[ "$CORRECTIVE_PREFLIGHT_AFTER_ROWS" -eq 0 ]] || {
  printf '%s\n' "$CORRECTIVE_PREFLIGHT_AFTER" >&2
  printf 'Corrective postflight must return zero ambiguity groups.\n' >&2
  exit 9
}

printf 'workspace_skill_legacy_pg16_fixture=passed\n'
printf 'applied_migrations=%s\n' "$DATABASE_MIGRATION_COUNT"
printf 'corrective_only_migrations=1\n'
