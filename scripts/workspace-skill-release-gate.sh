#!/usr/bin/env bash

set -Eeuo pipefail

MODE="preflight"
TARGET_ENVIRONMENT=""
BACKUP_PROOF=""
MAINTENANCE_CONFIRMED="false"
ALLOW_LOCAL_DEPLOY="false"
CONFLICTS_REVIEWED="false"
LOCK_TIMEOUT_MS="${WORKSPACE_SKILL_GATE_LOCK_TIMEOUT_MS:-5000}"
STATEMENT_TIMEOUT_MS="${WORKSPACE_SKILL_GATE_STATEMENT_TIMEOUT_MS:-300000}"
BACKUP_PROOF_MAX_AGE_HOURS="${WORKSPACE_SKILL_GATE_BACKUP_MAX_AGE_HOURS:-24}"
RESTORE_PROOF_MAX_AGE_HOURS="${WORKSPACE_SKILL_GATE_RESTORE_MAX_AGE_HOURS:-720}"
PSQL_BIN="${PSQL_BIN:-psql}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFLIGHT_SQL="${REPO_ROOT}/prisma/preflight/workspace-skill-legacy-version-conflicts.sql"
PRISMA_SCHEMA="${REPO_ROOT}/prisma/schema.prisma"
PRISMA_MIGRATIONS_ROOT="${REPO_ROOT}/prisma/migrations"
CHECKSUM_HELPER="${SCRIPT_DIR}/workspace-skill-migration-checksums.mjs"

usage() {
  cat <<'USAGE'
Usage:
  scripts/workspace-skill-release-gate.sh \
    --environment <local|staging|production> \
    --backup-proof </absolute/path/to/backup-proof.json> \
    [--mode <preflight|deploy>] \
    [--maintenance-confirmed] \
    [--conflicts-reviewed] \
    [--allow-local-deploy] \
    [--lock-timeout-ms <milliseconds>] \
    [--statement-timeout-ms <milliseconds>]

The default mode is preflight and performs only:
  1. backup/restore proof validation;
  2. a read-only checksum comparison for applied Prisma migrations;
  3. the read-only workspace-skill SQL preflight;
  4. `prisma migrate status`.

`--mode deploy` is rejected for every non-localhost database. Local deployment
also requires --maintenance-confirmed and --allow-local-deploy. When preflight
reports conflicts, --conflicts-reviewed is required as well.

Backup proof JSON contract:
  {
    "environment": "staging",
    "databaseTargetFingerprint": "<first 16 chars of sha256(protocol|host|port|database)>",
    "snapshotId": "<provider snapshot or backup artifact id>",
    "createdAt": "<ISO-8601 timestamp>",
    "restoreVerifiedAt": "<ISO-8601 timestamp>"
  }
USAGE
}

fail() {
  printf 'workspace-skill release gate: %s\n' "$1" >&2
  exit "${2:-2}"
}

require_positive_integer() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "${label} must be a positive integer."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      [[ $# -ge 2 ]] || fail "--environment requires a value."
      TARGET_ENVIRONMENT="$2"
      shift 2
      ;;
    --backup-proof)
      [[ $# -ge 2 ]] || fail "--backup-proof requires a value."
      BACKUP_PROOF="$2"
      shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || fail "--mode requires a value."
      MODE="$2"
      shift 2
      ;;
    --maintenance-confirmed)
      MAINTENANCE_CONFIRMED="true"
      shift
      ;;
    --conflicts-reviewed)
      CONFLICTS_REVIEWED="true"
      shift
      ;;
    --allow-local-deploy)
      ALLOW_LOCAL_DEPLOY="true"
      shift
      ;;
    --lock-timeout-ms)
      [[ $# -ge 2 ]] || fail "--lock-timeout-ms requires a value."
      LOCK_TIMEOUT_MS="$2"
      shift 2
      ;;
    --statement-timeout-ms)
      [[ $# -ge 2 ]] || fail "--statement-timeout-ms requires a value."
      STATEMENT_TIMEOUT_MS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "$TARGET_ENVIRONMENT" in
  local|staging|production) ;;
  "") fail "--environment must be provided explicitly." ;;
  *) fail "--environment must be local, staging, or production." ;;
esac

case "$MODE" in
  preflight|deploy) ;;
  *) fail "--mode must be preflight or deploy." ;;
esac

[[ -n "$BACKUP_PROOF" ]] || fail "--backup-proof must be provided explicitly."
[[ "$BACKUP_PROOF" = /* ]] || fail "--backup-proof must be an absolute path."
[[ -f "$BACKUP_PROOF" && -s "$BACKUP_PROOF" ]] ||
  fail "--backup-proof must point to a non-empty regular file."
[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL must be set."
[[ -f "$PREFLIGHT_SQL" ]] || fail "preflight SQL is missing: ${PREFLIGHT_SQL}"
[[ -f "$PRISMA_SCHEMA" ]] || fail "Prisma schema is missing: ${PRISMA_SCHEMA}"
[[ -d "$PRISMA_MIGRATIONS_ROOT" ]] ||
  fail "Prisma migrations directory is missing: ${PRISMA_MIGRATIONS_ROOT}"
[[ -f "$CHECKSUM_HELPER" ]] ||
  fail "migration checksum helper is missing: ${CHECKSUM_HELPER}"

require_positive_integer "lock timeout" "$LOCK_TIMEOUT_MS"
require_positive_integer "statement timeout" "$STATEMENT_TIMEOUT_MS"
require_positive_integer "backup proof max age" "$BACKUP_PROOF_MAX_AGE_HOURS"
require_positive_integer "restore proof max age" "$RESTORE_PROOF_MAX_AGE_HOURS"

command -v node >/dev/null 2>&1 || fail "node is required."

DATABASE_INFO="$(
  node <<'NODE'
const crypto = require("node:crypto");

function reject(message) {
  process.stderr.write(`workspace-skill release gate: ${message}\n`);
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(process.env.DATABASE_URL || "");
} catch {
  reject("DATABASE_URL is not a valid URL.");
}

if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  reject("DATABASE_URL must use the postgres or postgresql protocol.");
}

const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (!hostname) reject("DATABASE_URL must contain a hostname.");

const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
const port = parsed.port || "5432";
let database;
try {
  database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
} catch {
  reject("DATABASE_URL contains an invalid database name.");
}
if (!database) reject("DATABASE_URL must contain a database name.");

const isExplicitLocalhost = ["localhost", "127.0.0.1", "::1"].includes(hostname);
const targetIdentity = [protocol, hostname, port, database].join("|");
const fingerprint = crypto
  .createHash("sha256")
  .update(targetIdentity)
  .digest("hex")
  .slice(0, 16);
const masked =
  hostname.length <= 4
    ? "***"
    : `${hostname.slice(0, 2)}***${hostname.slice(-2)}`;

process.stdout.write(
  [isExplicitLocalhost ? "local" : "remote", fingerprint, masked].join("|"),
);
NODE
)" || fail "DATABASE_URL safety classification failed."

IFS="|" read -r DATABASE_HOST_CLASS DATABASE_HOST_FINGERPRINT DATABASE_HOST_MASKED <<<"$DATABASE_INFO"

if [[ "$TARGET_ENVIRONMENT" == "local" && "$DATABASE_HOST_CLASS" != "local" ]]; then
  fail "--environment local requires DATABASE_URL to use explicit localhost."
fi

if [[ "$TARGET_ENVIRONMENT" != "local" && "$DATABASE_HOST_CLASS" == "local" ]]; then
  fail "--environment ${TARGET_ENVIRONMENT} cannot target localhost."
fi

if [[ "$MODE" == "deploy" && "$DATABASE_HOST_CLASS" != "local" ]]; then
  fail "automatic deployment is restricted to explicit localhost; run the remote deployment manually through the approved maintenance workflow." 3
fi

BACKUP_PROOF_SUMMARY="$(
  node - "$BACKUP_PROOF" "$TARGET_ENVIRONMENT" "$DATABASE_HOST_FINGERPRINT" \
    "$BACKUP_PROOF_MAX_AGE_HOURS" "$RESTORE_PROOF_MAX_AGE_HOURS" <<'NODE'
const fs = require("node:fs");

function reject(message) {
  process.stderr.write(`workspace-skill release gate: backup proof rejected: ${message}\n`);
  process.exit(1);
}

const [
  ,
  ,
  proofPath,
  expectedEnvironment,
  expectedFingerprint,
  maxBackupAgeHoursRaw,
  maxRestoreAgeHoursRaw,
] = process.argv;

let proof;
try {
  proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
} catch {
  reject("the file must contain valid JSON.");
}

if (!proof || Array.isArray(proof) || typeof proof !== "object") {
  reject("the JSON root must be an object.");
}

if (proof.environment !== expectedEnvironment) {
  reject("environment does not match --environment.");
}

if (proof.databaseTargetFingerprint !== expectedFingerprint) {
  reject("databaseTargetFingerprint does not match DATABASE_URL.");
}

if (typeof proof.snapshotId !== "string" || proof.snapshotId.trim().length < 4) {
  reject("snapshotId must identify the provider snapshot or backup artifact.");
}

function requireRecentTimestamp(field, maxAgeHours) {
  const raw = proof[field];
  const timestamp = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(timestamp)) reject(`${field} must be a valid ISO-8601 timestamp.`);

  const ageMs = Date.now() - timestamp;
  if (ageMs < -5 * 60 * 1000) reject(`${field} cannot be in the future.`);
  if (ageMs > maxAgeHours * 60 * 60 * 1000) {
    reject(`${field} is older than the configured ${maxAgeHours}-hour limit.`);
  }
  return timestamp;
}

const createdAt = requireRecentTimestamp(
  "createdAt",
  Number(maxBackupAgeHoursRaw),
);
const restoreVerifiedAt = requireRecentTimestamp(
  "restoreVerifiedAt",
  Number(maxRestoreAgeHoursRaw),
);
if (restoreVerifiedAt + 5 * 60 * 1000 < createdAt) {
  reject("restoreVerifiedAt cannot predate createdAt.");
}
process.stdout.write("valid");
NODE
)" || fail "backup proof validation failed."

[[ "$BACKUP_PROOF_SUMMARY" == "valid" ]] || fail "backup proof validation failed."

if [[ "$MODE" == "deploy" ]]; then
  [[ "$MAINTENANCE_CONFIRMED" == "true" ]] ||
    fail "--mode deploy requires --maintenance-confirmed."
  [[ "$ALLOW_LOCAL_DEPLOY" == "true" ]] ||
    fail "--mode deploy requires --allow-local-deploy."
fi

command -v "$PSQL_BIN" >/dev/null 2>&1 ||
  fail "${PSQL_BIN} is required; use the documented Docker psql fallback when running the preflight manually."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required."

# Apply the timeout guardrails to the read-only preflight, migration status,
# and (for explicit localhost deployment only) Prisma migrate deploy.
export PGOPTIONS="${PGOPTIONS:+${PGOPTIONS} }-c lock_timeout=${LOCK_TIMEOUT_MS}ms -c statement_timeout=${STATEMENT_TIMEOUT_MS}ms"

run_preflight() {
  local preflight_csv

  preflight_csv="$(
    "$PSQL_BIN" "$DATABASE_URL" \
      -X \
      --quiet \
      --set ON_ERROR_STOP=1 \
      --csv \
      --pset footer=off \
      --file "$PREFLIGHT_SQL"
  )"

  printf '%s\n' "$preflight_csv"
  PREFLIGHT_CONFLICT_COUNT="$(
    printf '%s\n' "$preflight_csv" |
      awk 'NR > 1 && length($0) > 0 { count += 1 } END { print count + 0 }'
  )"
}

run_migration_checksum_gate() {
  local applied_migrations
  local query_code
  local checksum_output
  local checksum_code

  set +e
  applied_migrations="$(
    "$PSQL_BIN" "$DATABASE_URL" \
      -X \
      --quiet \
      --tuples-only \
      --no-align \
      --field-separator='|' \
      --set ON_ERROR_STOP=1 \
      --command \
        'SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name";'
  )"
  query_code=$?
  set -e

  if [[ "$query_code" -ne 0 ]]; then
    printf 'migration_checksum_status=error\n'
    fail "deployment blocked: applied migration checksums could not be read." 4
  fi

  set +e
  checksum_output="$(
    printf '%s\n' "$applied_migrations" |
      node "$CHECKSUM_HELPER" "$PRISMA_MIGRATIONS_ROOT"
  )"
  checksum_code=$?
  set -e

  if [[ "$checksum_code" -eq 0 ]]; then
    printf 'migration_checksum_status=match\n'
    return
  fi

  printf 'migration_checksum_status=mismatch\n'
  while IFS='|' read -r migration_name mismatch_reason; do
    [[ -n "$migration_name" ]] || continue
    printf 'migration_checksum_mismatch=%s reason=%s\n' \
      "$migration_name" "$mismatch_reason"
  done <<<"$checksum_output"
  fail "deployment blocked: an applied Prisma migration differs from the local immutable migration history; reconcile it through the approved manual workflow. There is no automatic override." 4
}

run_migration_status() {
  local status_code
  local status_output

  set +e
  status_output="$(
    pnpm --dir "$REPO_ROOT" exec prisma migrate status --schema "$PRISMA_SCHEMA" 2>&1
  )"
  status_code=$?
  set -e

  if [[ "$status_code" -eq 0 ]]; then
    MIGRATION_STATUS_KIND="up_to_date"
    printf 'migration_status=up_to_date\n'
  elif printf '%s\n' "$status_output" |
    grep -Eiq 'P3009|failed migration|migration(s)? (have|has) failed|migration[^[:space:]]*.*failed'; then
    MIGRATION_STATUS_KIND="failed"
    printf 'migration_status=failed\n'
  elif printf '%s\n' "$status_output" |
    grep -Eiq 'not yet been applied|pending migration|migration[^[:space:]]*.*pending'; then
    MIGRATION_STATUS_KIND="pending"
    printf 'migration_status=pending\n'
  else
    MIGRATION_STATUS_KIND="error"
    printf 'migration_status=error\n'
  fi

  MIGRATION_STATUS_CODE="$status_code"
}

printf 'mode=%s\n' "$MODE"
printf 'target_environment=%s\n' "$TARGET_ENVIRONMENT"
printf 'database_host=%s\n' "$DATABASE_HOST_MASKED"
printf 'database_host_fingerprint=%s\n' "$DATABASE_HOST_FINGERPRINT"
printf 'backup_proof=valid\n'
printf 'lock_timeout_ms=%s\n' "$LOCK_TIMEOUT_MS"
printf 'statement_timeout_ms=%s\n' "$STATEMENT_TIMEOUT_MS"

run_migration_checksum_gate
run_preflight
printf 'conflict_groups=%s\n' "$PREFLIGHT_CONFLICT_COUNT"
run_migration_status

if [[ "$MIGRATION_STATUS_KIND" == "failed" ]]; then
  fail "deployment blocked: Prisma reports a failed migration; resolve it before continuing." 4
fi

if [[ "$MIGRATION_STATUS_KIND" == "error" ]]; then
  fail "deployment blocked: Prisma migration status could not be classified; verify connectivity and migration history manually." 4
fi

if [[ "$MODE" == "preflight" ]]; then
  printf 'deployment=not_requested\n'
  exit 0
fi

if [[ "$PREFLIGHT_CONFLICT_COUNT" -ne 0 && "$CONFLICTS_REVIEWED" != "true" ]]; then
  fail "deployment blocked: conflict groups are expected migration input but require --conflicts-reviewed after owner/version review." 4
fi

printf 'deployment=local_explicit\n'
pnpm --dir "$REPO_ROOT" db:deploy

run_preflight
printf 'post_deploy_conflict_groups=%s\n' "$PREFLIGHT_CONFLICT_COUNT"
run_migration_status

if [[ "$PREFLIGHT_CONFLICT_COUNT" -ne 0 || "$MIGRATION_STATUS_KIND" != "up_to_date" ]]; then
  fail "post-deploy verification failed; keep write traffic disabled." 5
fi

printf 'post_deploy_gate=passed\n'
