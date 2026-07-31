#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_COMPOSE_FILE="$SCRIPT_DIR/fixtures/account-appsession-postgres.compose.yml"
FIXTURE_PROJECT="delegate-account-session-pg16-${PPID}-$$-${RANDOM}"
FIXTURE_DATABASE="delegate_account_session_fixture"
FIXTURE_STACK_STARTED="false"
FIXTURE_POSTGRES_CONTAINER=""

cleanup() {
  if [[ "$FIXTURE_STACK_STARTED" == "true" ]]; then
    docker compose \
      --project-name "$FIXTURE_PROJECT" \
      --file "$FIXTURE_COMPOSE_FILE" \
      down \
      --volumes \
      --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'Account/AppSession PostgreSQL 16 fixture: %s\n' "$1" >&2
  exit "${2:-1}"
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker is required for the disposable PostgreSQL 16 fixture." 2
command -v pnpm >/dev/null 2>&1 ||
  fail "pnpm is required for the real Prisma service checks." 2

psql_fixture() {
  docker compose \
    --project-name "$FIXTURE_PROJECT" \
    --file "$FIXTURE_COMPOSE_FILE" \
    exec \
    --no-TTY \
    postgres \
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

run_index_operation() {
  PSQL_DOCKER_CONTAINER="$FIXTURE_POSTGRES_CONTAINER" \
  PSQL_DOCKER_DATABASE="$FIXTURE_DATABASE" \
  PSQL_DOCKER_USER=postgres \
    bash "$REPO_ROOT/scripts/logto-issuer-safe-index-operation.sh" "$@"
}

index_catalog_state() {
  local index_name="$1"

  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --set "index_name=${index_name}" \
    --file - <<'SQL'
SELECT
  index_state.indisvalid::text || '|' ||
  index_state.indisready::text || '|' ||
  index_state.indislive::text || '|' ||
  pg_get_indexdef(index_state.indexrelid)
FROM pg_catalog.pg_index AS index_state
INNER JOIN pg_catalog.pg_class AS relation
  ON relation.oid = index_state.indexrelid
INNER JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relname = :'index_name';
SQL
}

assert_failed_concurrent_index() {
  local index_name="$1"
  local state
  state="$(index_catalog_state "$index_name")"
  [[ -n "$state" && "$state" != true\|true\|true\|* ]] ||
    fail "failed concurrent build did not leave INVALID index ${index_name}."
  printf 'index=%s failed_state=%s\n' "$index_name" "$state"
}

assert_valid_index() {
  local index_name="$1"
  local expected_fragment="$2"
  local state
  state="$(index_catalog_state "$index_name")"
  [[ "$state" == true\|true\|true\|* ]] ||
    fail "index ${index_name} is not valid, ready, and live."
  printf '%s\n' "$state" | grep -F "$expected_fragment" >/dev/null ||
    fail "index ${index_name} does not have the expected definition."
}

FIXTURE_STACK_STARTED="true"
docker compose \
  --project-name "$FIXTURE_PROJECT" \
  --file "$FIXTURE_COMPOSE_FILE" \
  up \
  --detach \
  --wait \
  postgres >/dev/null

FIXTURE_POSTGRES_CONTAINER="$(
  docker compose \
    --project-name "$FIXTURE_PROJECT" \
    --file "$FIXTURE_COMPOSE_FILE" \
    ps \
    --quiet \
    postgres
)"
[[ -n "$FIXTURE_POSTGRES_CONTAINER" ]] ||
  fail "could not resolve the isolated PostgreSQL container."

FIXTURE_PORT="$(
  docker compose \
    --project-name "$FIXTURE_PROJECT" \
    --file "$FIXTURE_COMPOSE_FILE" \
    port postgres 5432 |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
[[ "$FIXTURE_PORT" =~ ^[0-9]+$ ]] ||
  fail "could not resolve the isolated host port."
FIXTURE_DATABASE_URL="postgresql://postgres:account_session_fixture_only@127.0.0.1:${FIXTURE_PORT}/${FIXTURE_DATABASE}"

printf 'phase=create_minimal_legacy_schema\n'
run_sql_file \
  "$REPO_ROOT/scripts/tests/fixtures/account-appsession-minimal-legacy.sql"

printf 'phase=apply_account_session_expand\n'
run_sql_file \
  "$REPO_ROOT/prisma/migrations/20260729143400_account_appsession_shadow_foundation/migration.sql"

printf 'phase=manufacture_owner_account_failed_cci\n'
psql_fixture --quiet --file - <<'SQL'
INSERT INTO "Account" ("id", "updatedAt")
VALUES ('index_owner_account', CURRENT_TIMESTAMP);

INSERT INTO "Owner" ("id", "accountId")
VALUES
  ('index_owner_a', 'index_owner_account'),
  ('index_owner_b', 'index_owner_account');
SQL
if run_sql_file \
  "$REPO_ROOT/prisma/migrations/20260729143500_owner_account_unique_index/migration.sql" \
  >/dev/null 2>&1; then
  fail "duplicate Owner.accountId rows should make migration 1435 CCI fail."
fi
assert_failed_concurrent_index "Owner_accountId_key"

printf 'phase=recover_owner_account_exact_invalid_index\n'
psql_fixture \
  --quiet \
  --command "DELETE FROM \"Owner\" WHERE \"id\" = 'index_owner_b';"
run_index_operation owner-account-unique
assert_valid_index "Owner_accountId_key" '"accountId"'

printf 'phase=reject_owner_account_valid_index\n'
OWNER_VALID_BEFORE="$(index_catalog_state "Owner_accountId_key")"
if OWNER_VALID_REJECTION="$(run_index_operation owner-account-unique 2>&1)"; then
  fail "account index recovery must reject an already VALID index."
fi
printf '%s\n' "$OWNER_VALID_REJECTION"
OWNER_VALID_AFTER="$(index_catalog_state "Owner_accountId_key")"
[[ "$OWNER_VALID_AFTER" == "$OWNER_VALID_BEFORE" ]] ||
  fail "VALID index rejection changed Owner_accountId_key."

printf 'phase=reject_and_preserve_owner_account_wrong_shape_invalid_index\n'
psql_fixture \
  --quiet \
  --command 'DROP INDEX CONCURRENTLY public."Owner_accountId_key";'
psql_fixture \
  --quiet \
  --command \
  "INSERT INTO \"Owner\" (\"id\", \"accountId\") VALUES ('index_owner_b', 'index_owner_account');"
if psql_fixture \
  --quiet \
  --command \
  'CREATE UNIQUE INDEX CONCURRENTLY "Owner_accountId_key" ON public."Owner"(lower("accountId"));' \
  >/dev/null 2>&1; then
  fail "wrong-shape Owner expression index should fail on duplicate accountId."
fi
assert_failed_concurrent_index "Owner_accountId_key"
psql_fixture \
  --quiet \
  --command "DELETE FROM \"Owner\" WHERE \"id\" = 'index_owner_b';"
OWNER_WRONG_SHAPE_BEFORE="$(index_catalog_state "Owner_accountId_key")"
printf '%s\n' "$OWNER_WRONG_SHAPE_BEFORE" |
  grep -F 'lower("accountId")' >/dev/null ||
  fail "wrong-shape Owner index fixture did not retain its expression."
if OWNER_WRONG_SHAPE_REJECTION="$(
  run_index_operation owner-account-unique 2>&1
)"; then
  fail "recovery must reject a same-name INVALID index with the wrong shape."
fi
printf '%s\n' "$OWNER_WRONG_SHAPE_REJECTION"
OWNER_WRONG_SHAPE_AFTER="$(index_catalog_state "Owner_accountId_key")"
[[ "$OWNER_WRONG_SHAPE_AFTER" == "$OWNER_WRONG_SHAPE_BEFORE" ]] ||
  fail "wrong-shape INVALID Owner index was removed or rewritten."

printf 'phase=reject_and_preserve_owner_account_constraint_dependency\n'
psql_fixture \
  --quiet \
  --command 'DROP INDEX CONCURRENTLY public."Owner_accountId_key";'
psql_fixture \
  --quiet \
  --command \
  'ALTER TABLE public."Owner" ADD CONSTRAINT "Owner_accountId_key" UNIQUE ("accountId");'
if OWNER_CONSTRAINT_REJECTION="$(
  run_index_operation owner-account-unique 2>&1
)"; then
  fail "recovery must reject a constraint-backed same-name index."
fi
printf '%s\n' "$OWNER_CONSTRAINT_REJECTION"
OWNER_CONSTRAINT_COUNT="$(
  psql_fixture \
    --quiet \
    --tuples-only \
    --no-align \
    --command \
    "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conname = 'Owner_accountId_key';"
)"
[[ "$OWNER_CONSTRAINT_COUNT" -eq 1 ]] ||
  fail "constraint-backed Owner index was removed or rewritten."
psql_fixture \
  --quiet \
  --command \
  'ALTER TABLE public."Owner" DROP CONSTRAINT "Owner_accountId_key";'
run_index_operation owner-account-unique
assert_valid_index "Owner_accountId_key" '"accountId"'

printf 'phase=manufacture_audience_account_failed_cci\n'
psql_fixture --quiet --file - <<'SQL'
INSERT INTO "Account" ("id", "updatedAt")
VALUES ('index_audience_account', CURRENT_TIMESTAMP);

INSERT INTO "AudienceIdentity" ("id", "status", "accountId")
VALUES
  ('index_audience_a', 'REGISTERED', 'index_audience_account'),
  ('index_audience_b', 'REGISTERED', 'index_audience_account');
SQL
if run_sql_file \
  "$REPO_ROOT/prisma/migrations/20260729143600_audience_account_unique_index/migration.sql" \
  >/dev/null 2>&1; then
  fail "duplicate AudienceIdentity.accountId rows should make migration 1436 CCI fail."
fi
assert_failed_concurrent_index "AudienceIdentity_accountId_key"

printf 'phase=recover_audience_account_exact_invalid_index\n'
psql_fixture \
  --quiet \
  --command \
  "DELETE FROM \"AudienceIdentity\" WHERE \"id\" = 'index_audience_b';"
run_index_operation audience-account-unique
assert_valid_index "AudienceIdentity_accountId_key" '"accountId"'

printf 'phase=cleanup_index_recovery_rows\n'
psql_fixture --quiet --file - <<'SQL'
DELETE FROM "Owner"
WHERE "id" = 'index_owner_a';

DELETE FROM "AudienceIdentity"
WHERE "id" = 'index_audience_a';

DELETE FROM "Account"
WHERE "id" IN ('index_owner_account', 'index_audience_account');
SQL

printf 'phase=run_database_invariants_and_real_prisma_services\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
DELEGATE_ACCOUNT_SESSION_POSTGRES_E2E=1 \
  pnpm --dir "$REPO_ROOT" \
    --filter @delegate/web-data \
    exec vitest run \
    tests/postgres-account-appsession-shadow.integration.test.ts

printf 'phase=account_appsession_shadow_pg16_complete\n'
