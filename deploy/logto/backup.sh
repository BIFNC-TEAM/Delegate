#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"
RUNTIME_ROOT="$(dirname "$ENV_FILE")"
BACKUP_ROOT="${LOGTO_LOCAL_BACKUP_ROOT:-${RUNTIME_ROOT}/backups}"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

if [[ $# -ne 0 ]]; then
  printf 'Usage: pnpm logto:local:backup\n' >&2
  exit 2
fi

command -v openssl >/dev/null 2>&1 || {
  printf 'OpenSSL is required to checksum the local Logto backup.\n' >&2
  exit 2
}

bash "${SCRIPT_DIR}/bootstrap.sh"
bash "${SCRIPT_DIR}/preflight.sh"
logto_load_env "$ENV_FILE"
umask 077
mkdir -p "$BACKUP_ROOT"
logto_acquire_local_operation_lock "${RUNTIME_ROOT}/operation.lock"

TEMP_DIR="$(mktemp -d "${BACKUP_ROOT}/.backup.tmp.XXXXXX")"
cleanup() {
  if [[ -d "$TEMP_DIR" ]]; then
    find "$TEMP_DIR" -type f -delete 2>/dev/null || true
    rmdir "$TEMP_DIR" 2>/dev/null || true
  fi
  logto_release_local_operation_lock
}
trap cleanup EXIT

bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 60 logto-postgres

TABLE_COUNT="$(
  bash "${SCRIPT_DIR}/compose.sh" exec -T logto-postgres \
    sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\'';"'
)"
TABLE_COUNT="${TABLE_COUNT//[[:space:]]/}"
if [[ ! "$TABLE_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  printf 'The Logto database is not initialized; refusing an empty backup.\n' >&2
  exit 3
fi

bash "${SCRIPT_DIR}/compose.sh" exec -T logto-postgres \
  sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  >"${TEMP_DIR}/logto.dump"
cp "$ENV_FILE" "${TEMP_DIR}/logto.env"
chmod 600 "${TEMP_DIR}/logto.dump" "${TEMP_DIR}/logto.env"

DUMP_SHA256="$(
  openssl dgst -sha256 "${TEMP_DIR}/logto.dump" | awk '{print $NF}'
)"
ENV_SHA256="$(
  openssl dgst -sha256 "${TEMP_DIR}/logto.env" | awk '{print $NF}'
)"
CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BACKUP_NAME="$(date -u '+%Y%m%dT%H%M%SZ')"
FINAL_DIR="${BACKUP_ROOT}/${BACKUP_NAME}"
if [[ -e "$FINAL_DIR" ]]; then
  printf 'Backup destination already exists: %s\n' "$FINAL_DIR" >&2
  exit 3
fi

{
  printf 'format=delegate-logto-local-backup-v1\n'
  printf 'created_at=%s\n' "$CREATED_AT"
  printf 'logto_image=%s\n' "$LOGTO_OSS_IMAGE"
  printf 'postgres_image=%s\n' "$LOGTO_OSS_POSTGRES_IMAGE"
  printf 'database_name=%s\n' "$LOGTO_OSS_DB_NAME"
  printf 'dump_sha256=%s\n' "$DUMP_SHA256"
  printf 'env_sha256=%s\n' "$ENV_SHA256"
} >"${TEMP_DIR}/manifest"
chmod 600 "${TEMP_DIR}/manifest"

mv "$TEMP_DIR" "$FINAL_DIR"
TEMP_DIR=""
trap - EXIT
logto_release_local_operation_lock

bash "${SCRIPT_DIR}/verify-backup.sh" "$FINAL_DIR" --require-current-env
printf '%s\n' \
  "Created verified local Logto backup: ${FINAL_DIR}" \
  "The backup contains the database credential and Secret Vault KEK." \
  "Move a copy to an encrypted, access-controlled location before relying on it."
