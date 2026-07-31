#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

command -v docker >/dev/null 2>&1 || {
  printf 'Docker Compose is required for the local Logto stack.\n' >&2
  exit 2
}
docker compose version >/dev/null
logto_load_env "$ENV_FILE"
bash "${SCRIPT_DIR}/compose.sh" config --quiet

printf '%s\n' \
  "Logto local preflight passed." \
  "image=${LOGTO_OSS_IMAGE}" \
  "core=${LOGTO_OSS_ENDPOINT}" \
  "admin=${LOGTO_OSS_ADMIN_ENDPOINT}" \
  "database=dedicated internal PostgreSQL (not host-published)"
