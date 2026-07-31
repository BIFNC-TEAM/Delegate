#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"
RUNTIME_ROOT="$(dirname "$ENV_FILE")"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

command -v node >/dev/null 2>&1 || {
  printf 'Node.js is required to validate local Logto endpoints.\n' >&2
  exit 2
}
command -v openssl >/dev/null 2>&1 || {
  printf 'OpenSSL is required to generate local Logto secrets.\n' >&2
  exit 2
}

if [[ -f "$ENV_FILE" ]]; then
  logto_load_env "$ENV_FILE"
  printf 'Logto local environment already exists and is valid: %s\n' "$ENV_FILE"
  exit 0
fi

umask 077
mkdir -p "$RUNTIME_ROOT"
TEMP_FILE="$(mktemp "${RUNTIME_ROOT}/logto.env.tmp.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT

DB_PASSWORD="$(openssl rand -hex 24)"
SECRET_VAULT_KEK="$(openssl rand -base64 32 | tr -d '\n')"

{
  printf '%s\n' \
    "LOGTO_OSS_IMAGE=svhd/logto:1.41.0" \
    "LOGTO_OSS_POSTGRES_IMAGE=postgres:17-alpine" \
    "LOGTO_OSS_ENDPOINT=http://127.0.0.1:3301" \
    "LOGTO_OSS_ADMIN_ENDPOINT=http://127.0.0.1:3302" \
    "LOGTO_OSS_CORE_PORT=3301" \
    "LOGTO_OSS_ADMIN_PORT=3302" \
    "LOGTO_OSS_DB_NAME=logto" \
    "LOGTO_OSS_DB_USER=logto" \
    "LOGTO_OSS_DB_PASSWORD=${DB_PASSWORD}" \
    "LOGTO_OSS_SECRET_VAULT_KEK=${SECRET_VAULT_KEK}" \
    "LOGTO_OSS_DATABASE_STATEMENT_TIMEOUT=30000" \
    "LOGTO_OSS_PRIVATE_KEY_ROTATION_GRACE_PERIOD=0"
} >"$TEMP_FILE"

logto_load_env "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT

printf '%s\n' \
  "Created local Logto environment: ${ENV_FILE}" \
  "These credentials are local-only and must never be promoted to production."
