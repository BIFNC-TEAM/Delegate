#!/usr/bin/env bash

set -Eeuo pipefail

TARGET="${1:-all}"
PSQL_BIN="${PSQL_BIN:-psql}"
CURRENT_INDEX="not-started"

usage() {
  printf '%s\n' \
    "Usage: scripts/logto-issuer-safe-index-operation.sh <target>" \
    "" \
    "Issuer targets: all | owner-lookup | owner-unique | audience-unique" \
    "Account targets: account-all | owner-account-unique | audience-account-unique" \
    "" \
    "Creates or verifies one expected index at a time, outside a transaction." \
    "Only a same-name INVALID index with the exact expected target and shape is" \
    "eligible for concurrent drop/rebuild. Wrong-shape and constraint-backed" \
    "indexes are always rejected. Account targets also reject VALID indexes so" \
    "an already-applied migration must be reconciled explicitly." \
    "" \
    "Connection options:" \
    "  DATABASE_URL=postgresql://...            use a local psql client" \
    "  PSQL_DOCKER_CONTAINER=name               use psql in that container" \
    "  PSQL_DOCKER_USER=postgres                optional container DB user" \
    "  PSQL_DOCKER_DATABASE=delegate_fixture    required container database"
}

fail() {
  printf 'Logto issuer-safe index operation: %s\n' "$1" >&2
  exit "${2:-1}"
}

on_error() {
  local exit_code=$?
  printf '%s\n' \
    "Logto issuer-safe index operation failed for ${CURRENT_INDEX}." \
    "A failed CREATE INDEX CONCURRENTLY can leave an INVALID index." \
    "Resolve the reported data/DDL conflict, then rerun this same target;" \
    "the operation will remove only that unusable index before rebuilding it." \
    >&2
  exit "$exit_code"
}
trap on_error ERR

case "$TARGET" in
  all|owner-lookup|owner-unique|audience-unique|account-all|owner-account-unique|audience-account-unique)
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    fail "unknown target: ${TARGET}"
    ;;
esac

if [[ -n "${PSQL_DOCKER_CONTAINER:-}" ]]; then
  command -v docker >/dev/null 2>&1 ||
    fail "docker is required when PSQL_DOCKER_CONTAINER is set."
  [[ -n "${PSQL_DOCKER_DATABASE:-}" ]] ||
    fail "PSQL_DOCKER_DATABASE must be set for container execution."

  psql_exec() {
    docker exec -i "$PSQL_DOCKER_CONTAINER" \
      psql \
      -U "${PSQL_DOCKER_USER:-postgres}" \
      -d "$PSQL_DOCKER_DATABASE" \
      -X \
      --set ON_ERROR_STOP=1 \
      "$@"
  }
else
  [[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL must be set."
  command -v "$PSQL_BIN" >/dev/null 2>&1 ||
    fail "psql client is missing: ${PSQL_BIN}"

  psql_exec() {
    "$PSQL_BIN" "$DATABASE_URL" \
      -X \
      --set ON_ERROR_STOP=1 \
      "$@"
  }
fi

index_state() {
  local index_name="$1"
  local table_name="$2"
  local expected_unique="$3"
  local predicate_kind="$4"
  local expected_columns="$5"
  local expected_opclasses="$6"

  psql_exec \
    --quiet \
    --tuples-only \
    --no-align \
    --set "index_name=${index_name}" \
    --set "table_name=${table_name}" \
    --set "expected_unique=${expected_unique}" \
    --set "predicate_kind=${predicate_kind}" \
    --set "expected_columns=${expected_columns}" \
    --set "expected_opclasses=${expected_opclasses}" \
    --file - <<'SQL'
WITH target_relation AS (
  SELECT to_regclass(:'table_name') AS target_oid
),
candidate AS (
  SELECT
    relation.relkind,
    relation.reloptions,
    index_state.indexrelid,
    index_state.indrelid,
    index_state.indisunique,
    index_state.indisprimary,
    index_state.indisexclusion,
    index_state.indimmediate,
    index_state.indnullsnotdistinct,
    index_state.indisvalid,
    index_state.indisready,
    index_state.indislive,
    index_state.indnatts,
    index_state.indnkeyatts,
    index_state.indkey,
    index_state.indclass,
    index_state.indcollation,
    index_state.indoption,
    index_state.indexprs,
    index_state.indpred,
    access_method.amname,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_state
      WHERE constraint_state.conindid = index_state.indexrelid
    ) AS has_constraint_dependency
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_index AS index_state
    ON index_state.indexrelid = relation.oid
  LEFT JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = relation.relam
  WHERE namespace.nspname = 'public'
    AND relation.relname = :'index_name'
),
classified AS (
  SELECT
    candidate.*,
    (
      candidate.indexrelid IS NOT NULL
      AND candidate.relkind = 'i'
      AND candidate.indrelid = target_relation.target_oid
      AND candidate.amname = 'btree'
      AND candidate.indisunique = :'expected_unique'::boolean
      AND NOT candidate.indisprimary
      AND NOT candidate.indisexclusion
      AND candidate.indimmediate
      AND NOT candidate.indnullsnotdistinct
      AND candidate.reloptions IS NULL
      AND candidate.indnatts =
        cardinality(string_to_array(:'expected_columns', ','))
      AND candidate.indnkeyatts =
        cardinality(string_to_array(:'expected_columns', ','))
      AND candidate.indexprs IS NULL
      AND (
        SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
        FROM unnest(candidate.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = candidate.indrelid
          AND attribute.attnum = key.attnum
        WHERE key.ordinality <= candidate.indnkeyatts
      ) = string_to_array(:'expected_columns', ',')
      AND (
        SELECT array_agg(
          opclass_namespace.nspname || '.' || opclass.opcname
          ORDER BY key.ordinality
        )
        FROM unnest(candidate.indclass)
          WITH ORDINALITY AS key(opclass_oid, ordinality)
        INNER JOIN pg_catalog.pg_opclass AS opclass
          ON opclass.oid = key.opclass_oid
        INNER JOIN pg_catalog.pg_namespace AS opclass_namespace
          ON opclass_namespace.oid = opclass.opcnamespace
        WHERE key.ordinality <= candidate.indnkeyatts
      ) = string_to_array(:'expected_opclasses', ',')
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(candidate.indoption) AS option_state(option_value)
        WHERE option_state.option_value <> 0
      )
      AND (
        SELECT array_agg(
          index_collation.collation_oid
          ORDER BY index_collation.ordinality
        )
        FROM unnest(candidate.indcollation)
          WITH ORDINALITY AS index_collation(collation_oid, ordinality)
        WHERE index_collation.ordinality <= candidate.indnkeyatts
      ) = (
        SELECT array_agg(attribute.attcollation ORDER BY key.ordinality)
        FROM unnest(candidate.indkey)
          WITH ORDINALITY AS key(attnum, ordinality)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = candidate.indrelid
          AND attribute.attnum = key.attnum
        WHERE key.ordinality <= candidate.indnkeyatts
      )
      AND (
        (
          :'predicate_kind' = 'none'
          AND candidate.indpred IS NULL
        )
        OR (
          :'predicate_kind' = 'issuer-not-null'
          AND regexp_replace(
            lower(pg_get_expr(candidate.indpred, candidate.indrelid)),
            '[^a-z]+',
            '',
            'g'
          ) = 'issuerisnotnull'
        )
      )
    ) AS shape_matches
  FROM candidate
  CROSS JOIN target_relation
)
SELECT CASE
  WHEN (SELECT target_oid FROM target_relation) IS NULL THEN 'missing-target'
  WHEN NOT EXISTS (SELECT 1 FROM classified) THEN 'absent'
  WHEN EXISTS (
    SELECT 1
    FROM classified
    WHERE indexrelid IS NULL
  ) THEN 'conflict'
  WHEN EXISTS (
    SELECT 1
    FROM classified
    WHERE has_constraint_dependency
  ) THEN 'constraint'
  WHEN EXISTS (
    SELECT 1
    FROM classified
    WHERE indisvalid
      AND indisready
      AND indislive
      AND shape_matches
  ) THEN 'valid'
  WHEN EXISTS (
    SELECT 1
    FROM classified
    WHERE shape_matches
      AND NOT (indisvalid AND indisready AND indislive)
  ) THEN 'invalid'
  ELSE 'conflict'
END;
SQL
}

print_index_details() {
  local index_name="$1"

  psql_exec \
    --quiet \
    --set "index_name=${index_name}" \
    --file - <<'SQL'
SELECT
  relation.relname AS index_name,
  relation.relkind,
  index_state.indisvalid,
  index_state.indisready,
  index_state.indislive,
  index_state.indisunique,
  (
    SELECT string_agg(constraint_state.conname, ',' ORDER BY constraint_state.conname)
    FROM pg_catalog.pg_constraint AS constraint_state
    WHERE constraint_state.conindid = relation.oid
  ) AS dependent_constraints,
  pg_get_indexdef(index_state.indexrelid) AS definition
FROM pg_catalog.pg_class AS relation
INNER JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_index AS index_state
  ON index_state.indexrelid = relation.oid
WHERE namespace.nspname = 'public'
  AND relation.relname = :'index_name';
SQL
}

apply_index() {
  local target="$1"
  local index_name
  local table_name
  local expected_unique
  local predicate_kind
  local expected_columns
  local expected_opclasses
  local valid_action
  local create_sql
  local migration_name

  case "$target" in
    owner-lookup)
      index_name="OwnerIdentityLink_provider_issuer_providerSubject_idx"
      table_name='public."OwnerIdentityLink"'
      expected_unique="false"
      predicate_kind="none"
      expected_columns="provider,issuer,providerSubject"
      expected_opclasses="pg_catalog.enum_ops,pg_catalog.text_ops,pg_catalog.text_ops"
      valid_action="reuse"
      migration_name="20260729143100_owner_logto_issuer_lookup_index"
      create_sql='CREATE INDEX CONCURRENTLY "OwnerIdentityLink_provider_issuer_providerSubject_idx" ON public."OwnerIdentityLink"("provider", "issuer", "providerSubject");'
      ;;
    owner-unique)
      index_name="OwnerIdentityLink_provider_issuer_providerSubject_key"
      table_name='public."OwnerIdentityLink"'
      expected_unique="true"
      predicate_kind="issuer-not-null"
      expected_columns="provider,issuer,providerSubject"
      expected_opclasses="pg_catalog.enum_ops,pg_catalog.text_ops,pg_catalog.text_ops"
      valid_action="reuse"
      migration_name="20260729143200_owner_logto_issuer_unique_index"
      create_sql='CREATE UNIQUE INDEX CONCURRENTLY "OwnerIdentityLink_provider_issuer_providerSubject_key" ON public."OwnerIdentityLink"("provider", "issuer", "providerSubject") WHERE "issuer" IS NOT NULL;'
      ;;
    audience-unique)
      index_name="IdentityLink_provider_issuer_providerSubject_key"
      table_name='public."IdentityLink"'
      expected_unique="true"
      predicate_kind="none"
      expected_columns="provider,issuer,providerSubject"
      expected_opclasses="pg_catalog.enum_ops,pg_catalog.text_ops,pg_catalog.text_ops"
      valid_action="reuse"
      migration_name="20260729143300_audience_logto_issuer_unique_index"
      create_sql='CREATE UNIQUE INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key" ON public."IdentityLink"("provider", "issuer", "providerSubject");'
      ;;
    owner-account-unique)
      index_name="Owner_accountId_key"
      table_name='public."Owner"'
      expected_unique="true"
      predicate_kind="none"
      expected_columns="accountId"
      expected_opclasses="pg_catalog.text_ops"
      valid_action="reject"
      migration_name="20260729143500_owner_account_unique_index"
      create_sql='CREATE UNIQUE INDEX CONCURRENTLY "Owner_accountId_key" ON public."Owner"("accountId");'
      ;;
    audience-account-unique)
      index_name="AudienceIdentity_accountId_key"
      table_name='public."AudienceIdentity"'
      expected_unique="true"
      predicate_kind="none"
      expected_columns="accountId"
      expected_opclasses="pg_catalog.text_ops"
      valid_action="reject"
      migration_name="20260729143600_audience_account_unique_index"
      create_sql='CREATE UNIQUE INDEX CONCURRENTLY "AudienceIdentity_accountId_key" ON public."AudienceIdentity"("accountId");'
      ;;
    *)
      fail "internal target error: ${target}"
      ;;
  esac

  CURRENT_INDEX="$index_name"
  local state
  state="$(
    index_state \
      "$index_name" \
      "$table_name" \
      "$expected_unique" \
      "$predicate_kind" \
      "$expected_columns" \
      "$expected_opclasses"
  )"

  case "$state" in
    valid)
      if [[ "$valid_action" == "reuse" ]]; then
        printf 'index=%s state=valid action=reuse\n' "$index_name"
      else
        print_index_details "$index_name" >&2
        fail \
          "index ${index_name} is already VALID; refusing recovery because migration state must be reconciled explicitly."
      fi
      ;;
    invalid)
      printf 'index=%s state=invalid action=drop-concurrently\n' "$index_name"
      psql_exec \
        --quiet \
        --command "DROP INDEX CONCURRENTLY public.\"${index_name}\";"
      printf 'index=%s state=absent action=create-concurrently\n' "$index_name"
      psql_exec --quiet --command "$create_sql"
      ;;
    absent)
      printf 'index=%s state=absent action=create-concurrently\n' "$index_name"
      psql_exec --quiet --command "$create_sql"
      ;;
    conflict)
      print_index_details "$index_name" >&2
      fail \
        "index ${index_name} exists with the wrong object type, table, or exact shape; inspect it manually."
      ;;
    constraint)
      print_index_details "$index_name" >&2
      fail \
        "index ${index_name} backs a constraint; refusing any automated drop or recovery."
      ;;
    missing-target)
      fail "expected target table ${table_name} does not exist."
      ;;
    *)
      fail "unexpected state '${state}' for ${index_name}."
      ;;
  esac

  state="$(
    index_state \
      "$index_name" \
      "$table_name" \
      "$expected_unique" \
      "$predicate_kind" \
      "$expected_columns" \
      "$expected_opclasses"
  )"
  [[ "$state" == "valid" ]] ||
    fail "index ${index_name} did not reach valid, ready, live state."

  printf 'index=%s state=valid migration=%s\n' \
    "$index_name" \
    "$migration_name"
}

if [[ "$TARGET" == "all" ]]; then
  apply_index owner-lookup
  apply_index owner-unique
  apply_index audience-unique
elif [[ "$TARGET" == "account-all" ]]; then
  apply_index owner-account-unique
  apply_index audience-account-unique
else
  apply_index "$TARGET"
fi
