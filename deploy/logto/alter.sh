#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"
RUNTIME_ROOT="$(dirname "$ENV_FILE")"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

if [[ "${1-}" == "--" ]]; then
  shift
fi
if [[ "${1-}" != "--backup" || -z "${2-}" || $# -ne 2 ]]; then
  printf '%s\n' \
    "Usage: pnpm logto:local:alter -- --backup <backup-directory>" \
    "Create and verify a local backup before the one-shot alteration." >&2
  exit 2
fi
BACKUP_DIR="$2"

bash "${SCRIPT_DIR}/bootstrap.sh"
bash "${SCRIPT_DIR}/preflight.sh"
logto_acquire_local_operation_lock "${RUNTIME_ROOT}/operation.lock"
trap logto_release_local_operation_lock EXIT
bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 60 logto-postgres
bash "${SCRIPT_DIR}/verify-backup.sh" "$BACKUP_DIR" --require-current-env

TABLE_COUNT="$(
  bash "${SCRIPT_DIR}/compose.sh" exec -T logto-postgres \
    sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\'';"'
)"
TABLE_COUNT="${TABLE_COUNT//[[:space:]]/}"
if [[ ! "$TABLE_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' \
    "The Logto database is not initialized." \
    "Run pnpm logto:local:init instead of an alteration." >&2
  exit 3
fi

bash "${SCRIPT_DIR}/compose.sh" stop logto
printf 'Logto is stopped while the one-shot database alteration runs.\n'
if ! bash "${SCRIPT_DIR}/compose.sh" run --rm logto-alteration; then
  printf '%s\n' \
    "Logto alteration failed; the application remains stopped." \
    "Inspect the job output and restore/retry intentionally." >&2
  exit 4
fi

bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 90 logto
bash "${SCRIPT_DIR}/smoke.sh"
