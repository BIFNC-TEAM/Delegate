#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"

if [[ "${1-}" == "--" ]]; then
  shift
fi
if [[ -z "${1-}" || $# -gt 2 ]]; then
  printf 'Usage: %s <backup-directory> [--require-current-env]\n' "$0" >&2
  exit 2
fi
BACKUP_DIR="$1"
REQUIRE_CURRENT_ENV="${2-}"
if [[ -n "$REQUIRE_CURRENT_ENV" && "$REQUIRE_CURRENT_ENV" != "--require-current-env" ]]; then
  printf 'Unknown backup verification option: %s\n' "$REQUIRE_CURRENT_ENV" >&2
  exit 2
fi

command -v openssl >/dev/null 2>&1 || {
  printf 'OpenSSL is required to verify the local Logto backup.\n' >&2
  exit 2
}
for required_file in manifest logto.dump logto.env; do
  if [[ ! -f "${BACKUP_DIR}/${required_file}" ]]; then
    printf 'Backup is missing %s: %s\n' "$required_file" "$BACKUP_DIR" >&2
    exit 3
  fi
done

read_manifest_value() {
  local key="$1"
  local line=""
  line="$(grep -E "^${key}=" "${BACKUP_DIR}/manifest" || true)"
  if [[ -z "$line" || "$line" == *$'\n'* ]]; then
    printf 'Backup manifest has no unique %s value.\n' "$key" >&2
    return 3
  fi
  printf '%s' "${line#*=}"
}

FORMAT="$(read_manifest_value format)"
EXPECTED_DUMP_SHA256="$(read_manifest_value dump_sha256)"
EXPECTED_ENV_SHA256="$(read_manifest_value env_sha256)"
[[ "$FORMAT" == "delegate-logto-local-backup-v1" ]] || {
  printf 'Unsupported Logto backup format: %s\n' "$FORMAT" >&2
  exit 3
}
[[ "$EXPECTED_DUMP_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Invalid dump checksum in backup manifest.\n' >&2
  exit 3
}
[[ "$EXPECTED_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Invalid environment checksum in backup manifest.\n' >&2
  exit 3
}

ACTUAL_DUMP_SHA256="$(
  openssl dgst -sha256 "${BACKUP_DIR}/logto.dump" | awk '{print $NF}'
)"
ACTUAL_ENV_SHA256="$(
  openssl dgst -sha256 "${BACKUP_DIR}/logto.env" | awk '{print $NF}'
)"
if [[ "$ACTUAL_DUMP_SHA256" != "$EXPECTED_DUMP_SHA256" ]]; then
  printf 'Logto database dump checksum mismatch.\n' >&2
  exit 3
fi
if [[ "$ACTUAL_ENV_SHA256" != "$EXPECTED_ENV_SHA256" ]]; then
  printf 'Logto credential/KEK backup checksum mismatch.\n' >&2
  exit 3
fi
if [[ "$REQUIRE_CURRENT_ENV" == "--require-current-env" ]]; then
  if [[ ! -f "$ENV_FILE" ]] || ! cmp -s "$ENV_FILE" "${BACKUP_DIR}/logto.env"; then
    printf '%s\n' \
      "Backup credentials and KEK do not match the current Logto environment." \
      "Refusing to use this artifact for the current database alteration." >&2
    exit 3
  fi
fi

bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 60 logto-postgres
bash "${SCRIPT_DIR}/compose.sh" exec -T logto-postgres \
  sh -ec '
    restore_list_input="$(mktemp)"
    trap '\''rm -f "$restore_list_input"'\'' EXIT
    cat >"$restore_list_input"
    pg_restore --list "$restore_list_input" >/dev/null
  ' <"${BACKUP_DIR}/logto.dump"

printf 'Verified local Logto backup: %s\n' "$BACKUP_DIR"
