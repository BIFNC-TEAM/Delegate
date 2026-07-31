#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"
RUNTIME_ROOT="$(dirname "$ENV_FILE")"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

bash "${SCRIPT_DIR}/bootstrap.sh"
bash "${SCRIPT_DIR}/preflight.sh"
logto_acquire_local_operation_lock "${RUNTIME_ROOT}/operation.lock"
trap logto_release_local_operation_lock EXIT
bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 60 logto-postgres

TABLE_COUNT="$(
  bash "${SCRIPT_DIR}/compose.sh" exec -T logto-postgres \
    sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\'';"'
)"
TABLE_COUNT="${TABLE_COUNT//[[:space:]]/}"
if [[ ! "$TABLE_COUNT" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine whether the Logto database is empty.\n' >&2
  exit 3
fi
if (( TABLE_COUNT > 0 )); then
  printf '%s\n' \
    "The Logto database already contains ${TABLE_COUNT} public tables." \
    "Refusing to run the seed job twice. Use pnpm logto:local:up, or run the" \
    "reviewed alteration command for a version upgrade." >&2
  exit 3
fi

bash "${SCRIPT_DIR}/compose.sh" run --rm logto-seed
bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 90 logto
bash "${SCRIPT_DIR}/smoke.sh"
