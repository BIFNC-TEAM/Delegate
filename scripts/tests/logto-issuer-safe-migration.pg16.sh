#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/delegate-logto-issuer-safe.XXXXXX)"
FIXTURE_CONTAINER="delegate-logto-issuer-safe-${PPID}-$$-${RANDOM}"
FIXTURE_DATABASE="delegate_logto_issuer_fixture"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi

  if [[ -d "$FIXTURE_ROOT" && "$FIXTURE_ROOT" == /tmp/delegate-logto-issuer-safe.* ]]; then
    find "$FIXTURE_ROOT" -depth -delete
  fi
}
trap cleanup EXIT

fail() {
  printf 'Logto issuer-safe PostgreSQL 16 fixture: %s\n' "$1" >&2
  exit "${2:-1}"
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker is required for the disposable PostgreSQL 16 fixture." 2

psql_fixture() {
  docker exec -i "$FIXTURE_CONTAINER" \
    psql \
    -U postgres \
    -d "$FIXTURE_DATABASE" \
    -X \
    --set ON_ERROR_STOP=1 \
    "$@"
}

run_sql_file() {
  local sql_file="$1"
  psql_fixture --file - < "$sql_file"
}

capture_preflight() {
  psql_fixture \
    --quiet \
    --csv \
    --pset footer=off \
    --file - \
    < "$REPO_ROOT/prisma/preflight/logto-account-identity-conflicts.sql"
}

assert_blocker_count() {
  local report="$1"
  local expected="$2"
  local actual
  actual="$(
    printf '%s\n' "$report" |
      awk -F, '$1 == "BLOCKER" { count += 1 } END { print count + 0 }'
  )"
  [[ "$actual" -eq "$expected" ]] ||
    fail "expected ${expected} BLOCKER rows, found ${actual}."
}

assert_metric() {
  local output="$1"
  local metric="$2"
  local expected="$3"
  printf '%s\n' "$output" |
    grep -Fx "${metric},${expected}" >/dev/null ||
    fail "expected backfill metric ${metric}=${expected}."
}

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=logto_issuer_fixture_only \
  --env "POSTGRES_DB=${FIXTURE_DATABASE}" \
  --publish 127.0.0.1::5432 \
  --health-cmd="pg_isready -U postgres -d ${FIXTURE_DATABASE}" \
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
  fail "PostgreSQL 16 container did not become healthy." 3
fi

FIXTURE_PORT="$(
  docker port "$FIXTURE_CONTAINER" 5432/tcp |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
[[ "$FIXTURE_PORT" =~ ^[0-9]+$ ]] ||
  fail "could not resolve the isolated host port."
printf 'phase=postgres16_ready container=%s port=%s\n' \
  "$FIXTURE_CONTAINER" \
  "$FIXTURE_PORT"

printf 'phase=create_minimal_legacy_schema\n'
psql_fixture --quiet --file - <<'SQL'
CREATE TYPE "OwnerIdentityLinkProvider" AS ENUM (
  'LOGTO',
  'EMAIL',
  'PHONE',
  'TELEGRAM'
);

CREATE TYPE "IdentityLinkProvider" AS ENUM (
  'WEB_ANONYMOUS',
  'LOGTO',
  'EMAIL',
  'PHONE',
  'TELEGRAM',
  'MATRIX',
  'PAYMENT_EXTERNAL_USER'
);

CREATE TYPE "AudienceIdentityStatus" AS ENUM (
  'ANONYMOUS',
  'REGISTERED',
  'MERGED',
  'DISABLED'
);

CREATE TABLE "Organization" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE
);

CREATE TABLE "Owner" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT,
  "displayName" TEXT NOT NULL
);

CREATE TABLE "OrganizationMember" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL UNIQUE
);

CREATE TABLE "OwnerIdentityLink" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "provider" "OwnerIdentityLinkProvider" NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "email" TEXT,
  "metadata" JSONB,
  CONSTRAINT "OwnerIdentityLink_provider_providerSubject_key"
    UNIQUE ("provider", "providerSubject")
);

CREATE TABLE "AudienceIdentity" (
  "id" TEXT PRIMARY KEY,
  "status" "AudienceIdentityStatus" NOT NULL,
  "mergedIntoId" TEXT
);

CREATE TABLE "IdentityLink" (
  "id" TEXT PRIMARY KEY,
  "audienceIdentityId" TEXT NOT NULL,
  "provider" "IdentityLinkProvider" NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "issuer" TEXT NOT NULL DEFAULT 'delegate',
  "metadata" JSONB,
  CONSTRAINT "IdentityLink_provider_providerSubject_key"
    UNIQUE ("provider", "providerSubject")
);
SQL

printf 'phase=insert_legacy_identity_evidence\n'
psql_fixture --quiet --file - <<'SQL'
INSERT INTO "Owner" ("id", "displayName")
VALUES
  ('owner_evidence_a', 'Owner evidence A'),
  ('owner_evidence_b', 'Owner evidence B'),
  ('owner_unresolved', 'Owner unresolved');

INSERT INTO "OwnerIdentityLink" (
  "id",
  "ownerId",
  "provider",
  "providerSubject",
  "email",
  "metadata"
)
VALUES
  (
    'owner_link_evidence_a',
    'owner_evidence_a',
    'LOGTO',
    'owner-subject-a',
    'owner-a@example.test',
    '{"issuer":" https://legacy-a.example.test/oidc "}'::jsonb
  ),
  (
    'owner_link_evidence_b',
    'owner_evidence_b',
    'LOGTO',
    'owner-subject-b',
    'owner-b@example.test',
    '{"issuer":"http://legacy-b.example.test"}'::jsonb
  ),
  (
    'owner_link_unresolved',
    'owner_unresolved',
    'LOGTO',
    'owner-subject-unresolved',
    'owner-unresolved@example.test',
    '{"issuer":"delegate"}'::jsonb
  );

INSERT INTO "AudienceIdentity" ("id", "status")
VALUES
  ('audience_evidence_a', 'REGISTERED'),
  ('audience_evidence_b', 'REGISTERED'),
  ('audience_unresolved', 'REGISTERED'),
  ('audience_matrix_control', 'REGISTERED');

INSERT INTO "IdentityLink" (
  "id",
  "audienceIdentityId",
  "provider",
  "providerSubject",
  "issuer",
  "metadata"
)
VALUES
  (
    'audience_link_evidence_a',
    'audience_evidence_a',
    'LOGTO',
    'audience-subject-a',
    'delegate',
    '{"issuer":" https://legacy-a.example.test/oidc "}'::jsonb
  ),
  (
    'audience_link_evidence_b',
    'audience_evidence_b',
    'LOGTO',
    'audience-subject-b',
    'delegate',
    '{"issuer":"http://legacy-b.example.test"}'::jsonb
  ),
  (
    'audience_link_unresolved',
    'audience_unresolved',
    'LOGTO',
    'audience-subject-unresolved',
    'delegate',
    '{"issuer":"not-a-url"}'::jsonb
  ),
  (
    'audience_link_matrix_control',
    'audience_matrix_control',
    'MATRIX',
    '@fixture:matrix.example.test',
    'matrix://matrix.example.test',
    '{"issuer":"https://must-not-be-copied.example.test"}'::jsonb
  );
SQL

printf 'phase=preflight_before_expand\n'
PREFLIGHT_BEFORE="$(capture_preflight)"
printf '%s\n' "$PREFLIGHT_BEFORE"
assert_blocker_count "$PREFLIGHT_BEFORE" 4
printf '%s\n' "$PREFLIGHT_BEFORE" |
  grep -F 'OWNER_LOGTO_ISSUER_REQUIRED' |
  grep -F 'owner_link_unresolved' >/dev/null
printf '%s\n' "$PREFLIGHT_BEFORE" |
  grep -F 'AUDIENCE_LOGTO_ISSUER_REQUIRED' |
  grep -F 'audience_link_evidence_a' >/dev/null
if printf '%s\n' "$PREFLIGHT_BEFORE" |
  grep -F 'OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED' >/dev/null; then
  fail "pre-expand schema must not report a physical issuer-column backfill."
fi

printf 'phase=apply_expand_migration\n'
run_sql_file \
  "$REPO_ROOT/prisma/migrations/20260729143000_logto_issuer_safe_legacy_identity/migration.sql" \
  >/dev/null

OWNER_ISSUER_COLUMN="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      SELECT is_nullable || '|' || data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'OwnerIdentityLink'
        AND column_name = 'issuer';
    "
)"
[[ "$OWNER_ISSUER_COLUMN" == "YES|text" ]] ||
  fail "expand migration did not add the nullable text issuer column."

printf 'phase=preflight_after_expand_before_backfill\n'
PREFLIGHT_EXPANDED="$(capture_preflight)"
printf '%s\n' "$PREFLIGHT_EXPANDED"
assert_blocker_count "$PREFLIGHT_EXPANDED" 9
printf '%s\n' "$PREFLIGHT_EXPANDED" |
  grep -F 'OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED' |
  grep -F 'owner_link_evidence_a' >/dev/null

printf 'phase=run_bounded_backfill_pass_1\n'
BACKFILL_PASS_1="$(
  psql_fixture \
    --quiet \
    --csv \
    --pset footer=off \
    --set batch_size=1 \
    --file - \
    < "$REPO_ROOT/prisma/backfill/logto-issuer-safe-legacy.sql"
)"
printf '%s\n' "$BACKFILL_PASS_1"
assert_metric "$BACKFILL_PASS_1" owner_identity_links_updated 1
assert_metric "$BACKFILL_PASS_1" audience_identity_links_updated 1

printf 'phase=run_bounded_backfill_pass_2\n'
BACKFILL_PASS_2="$(
  psql_fixture \
    --quiet \
    --csv \
    --pset footer=off \
    --set batch_size=1 \
    --file - \
    < "$REPO_ROOT/prisma/backfill/logto-issuer-safe-legacy.sql"
)"
printf '%s\n' "$BACKFILL_PASS_2"
assert_metric "$BACKFILL_PASS_2" owner_identity_links_updated 1
assert_metric "$BACKFILL_PASS_2" audience_identity_links_updated 1

printf 'phase=run_bounded_backfill_idempotency_pass\n'
BACKFILL_PASS_3="$(
  psql_fixture \
    --quiet \
    --csv \
    --pset footer=off \
    --set batch_size=1 \
    --file - \
    < "$REPO_ROOT/prisma/backfill/logto-issuer-safe-legacy.sql"
)"
printf '%s\n' "$BACKFILL_PASS_3"
assert_metric "$BACKFILL_PASS_3" owner_identity_links_updated 0
assert_metric "$BACKFILL_PASS_3" audience_identity_links_updated 0

printf 'phase=assert_evidence_only_issuer_outcomes\n'
ISSUER_OUTCOMES="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --field-separator '|' \
    --file - <<'SQL'
SELECT 'owner', "id", coalesce("issuer", '<null>')
FROM "OwnerIdentityLink"
ORDER BY "id";

SELECT 'audience', "id", "issuer"
FROM "IdentityLink"
ORDER BY "id";
SQL
)"
printf '%s\n' "$ISSUER_OUTCOMES"
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'owner|owner_link_evidence_a|https://legacy-a.example.test/oidc' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'owner|owner_link_evidence_b|http://legacy-b.example.test' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'owner|owner_link_unresolved|<null>' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'audience|audience_link_evidence_a|https://legacy-a.example.test/oidc' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'audience|audience_link_evidence_b|http://legacy-b.example.test' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'audience|audience_link_unresolved|delegate' >/dev/null
printf '%s\n' "$ISSUER_OUTCOMES" |
  grep -Fx 'audience|audience_link_matrix_control|matrix://matrix.example.test' >/dev/null

printf 'phase=preflight_after_backfill\n'
PREFLIGHT_AFTER="$(capture_preflight)"
printf '%s\n' "$PREFLIGHT_AFTER"
assert_blocker_count "$PREFLIGHT_AFTER" 3
printf '%s\n' "$PREFLIGHT_AFTER" |
  grep -F 'OWNER_LOGTO_ISSUER_REQUIRED' |
  grep -F 'owner_link_unresolved' >/dev/null
printf '%s\n' "$PREFLIGHT_AFTER" |
  grep -F 'OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED' |
  grep -F 'owner_link_unresolved' >/dev/null
printf '%s\n' "$PREFLIGHT_AFTER" |
  grep -F 'AUDIENCE_LOGTO_ISSUER_REQUIRED' |
  grep -F 'audience_link_unresolved' >/dev/null
if printf '%s\n' "$PREFLIGHT_AFTER" |
  grep -E 'owner_link_evidence_[ab]|audience_link_evidence_[ab]' >/dev/null; then
  fail "evidence-resolved rows must not remain in the preflight report."
fi

printf 'phase=apply_concurrent_index_migrations\n'
for MIGRATION_NAME in \
  20260729143100_owner_logto_issuer_lookup_index \
  20260729143200_owner_logto_issuer_unique_index \
  20260729143300_audience_logto_issuer_unique_index
do
  run_sql_file \
    "$REPO_ROOT/prisma/migrations/${MIGRATION_NAME}/migration.sql" \
    >/dev/null
done

VALID_INDEX_COUNT="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --file - <<'SQL'
SELECT count(*)
FROM pg_catalog.pg_index AS index_state
INNER JOIN pg_catalog.pg_class AS relation
  ON relation.oid = index_state.indexrelid
WHERE relation.relname IN (
  'OwnerIdentityLink_provider_issuer_providerSubject_idx',
  'OwnerIdentityLink_provider_issuer_providerSubject_key',
  'IdentityLink_provider_issuer_providerSubject_key'
)
  AND index_state.indisvalid
  AND index_state.indisready
  AND index_state.indislive;
SQL
)"
[[ "$VALID_INDEX_COUNT" -eq 3 ]] ||
  fail "expected all three issuer-safe indexes to be valid, ready, and live."

printf 'phase=verify_index_operation_recognizes_all_migrations\n'
INDEX_OPERATION_VALID="$(
  PSQL_DOCKER_CONTAINER="$FIXTURE_CONTAINER" \
  PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
    bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" all
)"
printf '%s\n' "$INDEX_OPERATION_VALID"
REUSED_INDEX_COUNT="$(
  printf '%s\n' "$INDEX_OPERATION_VALID" |
    awk -F'action=' '/state=valid action=reuse/ { count += 1 } END { print count + 0 }'
)"
[[ "$REUSED_INDEX_COUNT" -eq 3 ]] ||
  fail "index operation did not recognize all three migration definitions."

printf 'phase=manufacture_failed_concurrent_unique_index\n'
psql_fixture \
  --quiet \
  --command \
  'DROP INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key";'
psql_fixture \
  --quiet \
  --command \
  'ALTER TABLE "IdentityLink" DROP CONSTRAINT "IdentityLink_provider_providerSubject_key";'
psql_fixture --quiet --file - <<'SQL'
INSERT INTO "AudienceIdentity" ("id", "status")
VALUES ('audience_duplicate_recovery', 'REGISTERED');

INSERT INTO "IdentityLink" (
  "id",
  "audienceIdentityId",
  "provider",
  "providerSubject",
  "issuer",
  "metadata"
)
VALUES (
  'audience_link_duplicate_recovery',
  'audience_duplicate_recovery',
  'LOGTO',
  'audience-subject-a',
  'https://legacy-a.example.test/oidc',
  '{}'::jsonb
);
SQL

if run_sql_file \
  "$REPO_ROOT/prisma/migrations/20260729143300_audience_logto_issuer_unique_index/migration.sql" \
  >/dev/null 2>&1; then
  fail "duplicate exact principals should make the concurrent unique build fail."
fi

INVALID_INDEX_STATE="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      SELECT index_state.indisvalid::text || '|' ||
        index_state.indisready::text
      FROM pg_catalog.pg_index AS index_state
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = index_state.indexrelid
      WHERE relation.relname =
        'IdentityLink_provider_issuer_providerSubject_key';
    "
)"
[[ "$INVALID_INDEX_STATE" != "true|true" && -n "$INVALID_INDEX_STATE" ]] ||
  fail "failed concurrent build did not leave an unusable index to recover."
printf 'index=IdentityLink_provider_issuer_providerSubject_key state=%s\n' \
  "$INVALID_INDEX_STATE"

printf 'phase=remove_fixture_conflict_and_restore_legacy_key\n'
psql_fixture --quiet --file - <<'SQL'
DELETE FROM "IdentityLink"
WHERE "id" = 'audience_link_duplicate_recovery';

DELETE FROM "AudienceIdentity"
WHERE "id" = 'audience_duplicate_recovery';

ALTER TABLE "IdentityLink"
ADD CONSTRAINT "IdentityLink_provider_providerSubject_key"
UNIQUE ("provider", "providerSubject");
SQL

printf 'phase=recover_invalid_concurrent_index\n'
PSQL_DOCKER_CONTAINER="$FIXTURE_CONTAINER" \
PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
  bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" \
    audience-unique

printf 'phase=verify_recovery_is_idempotent\n'
RECOVERY_RETRY="$(
  PSQL_DOCKER_CONTAINER="$FIXTURE_CONTAINER" \
  PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
    bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" \
      audience-unique
)"
printf '%s\n' "$RECOVERY_RETRY"
printf '%s\n' "$RECOVERY_RETRY" |
  grep -F 'state=valid action=reuse' >/dev/null

printf 'phase=reject_wrong_shape_invalid_index\n'
psql_fixture \
  --quiet \
  --command \
  'DROP INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key";'
psql_fixture --quiet --file - <<'SQL'
INSERT INTO "IdentityLink" (
  "id",
  "audienceIdentityId",
  "provider",
  "providerSubject",
  "issuer",
  "metadata"
)
VALUES (
  'audience_link_wrong_shape_duplicate',
  'audience_evidence_a',
  'LOGTO',
  'audience-subject-wrong-shape',
  'https://legacy-a.example.test/oidc',
  '{}'::jsonb
);
SQL

if psql_fixture \
  --quiet \
  --command \
  'CREATE UNIQUE INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key" ON "IdentityLink"("provider", "issuer", "audienceIdentityId");' \
  >/dev/null 2>&1; then
  fail "the wrong-shape duplicate fixture should make its concurrent build fail."
fi

psql_fixture --quiet --file - <<'SQL'
DELETE FROM "IdentityLink"
WHERE "id" = 'audience_link_wrong_shape_duplicate';
SQL

if PSQL_DOCKER_CONTAINER="$FIXTURE_CONTAINER" \
  PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
    bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" \
      audience-unique >/dev/null 2>&1; then
  fail "recovery must reject a same-name INVALID index with the wrong shape."
fi

WRONG_SHAPE_INDEX_STATE="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      SELECT
        index_state.indisvalid::text || '|' ||
        index_state.indisready::text || '|' ||
        pg_get_indexdef(index_state.indexrelid)
      FROM pg_catalog.pg_index AS index_state
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = index_state.indexrelid
      WHERE relation.relname =
        'IdentityLink_provider_issuer_providerSubject_key';
    "
)"
printf 'wrong_shape_index=%s\n' "$WRONG_SHAPE_INDEX_STATE"
printf '%s\n' "$WRONG_SHAPE_INDEX_STATE" |
  grep -F '"audienceIdentityId"' >/dev/null ||
  fail "recovery removed or rewrote the wrong-shape INVALID index."

psql_fixture \
  --quiet \
  --command \
  'DROP INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key";'
PSQL_DOCKER_CONTAINER="$FIXTURE_CONTAINER" \
PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
  bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" \
    audience-unique

FINAL_INDEX_STATES="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --field-separator '|' \
    --file - <<'SQL'
SELECT
  relation.relname,
  index_state.indisvalid,
  index_state.indisready,
  index_state.indislive
FROM pg_catalog.pg_index AS index_state
INNER JOIN pg_catalog.pg_class AS relation
  ON relation.oid = index_state.indexrelid
WHERE relation.relname IN (
  'OwnerIdentityLink_provider_issuer_providerSubject_idx',
  'OwnerIdentityLink_provider_issuer_providerSubject_key',
  'IdentityLink_provider_issuer_providerSubject_key'
)
ORDER BY relation.relname;
SQL
)"
printf '%s\n' "$FINAL_INDEX_STATES"
FINAL_VALID_COUNT="$(
  printf '%s\n' "$FINAL_INDEX_STATES" |
    awk -F'|' '$2 == "t" && $3 == "t" && $4 == "t" { count += 1 } END { print count + 0 }'
)"
[[ "$FINAL_VALID_COUNT" -eq 3 ]] ||
  fail "recovered index set is not fully valid, ready, and live."

printf 'Logto issuer-safe PostgreSQL 16 migration fixture passed.\n'
