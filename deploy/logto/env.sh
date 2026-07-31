#!/usr/bin/env bash

# This file is sourced as trusted repository code. Generated logto.env files
# are parsed through a strict whitelist; they are never sourced as shell code.

logto_env_keys() {
  printf '%s\n' \
    LOGTO_OSS_IMAGE \
    LOGTO_OSS_POSTGRES_IMAGE \
    LOGTO_OSS_ENDPOINT \
    LOGTO_OSS_ADMIN_ENDPOINT \
    LOGTO_OSS_CORE_PORT \
    LOGTO_OSS_ADMIN_PORT \
    LOGTO_OSS_DB_NAME \
    LOGTO_OSS_DB_USER \
    LOGTO_OSS_DB_PASSWORD \
    LOGTO_OSS_SECRET_VAULT_KEK \
    LOGTO_OSS_DATABASE_STATEMENT_TIMEOUT \
    LOGTO_OSS_PRIVATE_KEY_ROTATION_GRACE_PERIOD
}

logto_is_known_env_key() {
  local requested="${1-}"
  local key=""

  while IFS= read -r key; do
    [[ "$requested" != "$key" ]] || return 0
  done < <(logto_env_keys)
  return 1
}

logto_validate_port() {
  local value="${1-}"
  [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$value <= 65535 ))
}

logto_validate_loopback_endpoint() {
  local endpoint="${1-}"
  local expected_port="${2-}"

  node --input-type=module - "$endpoint" "$expected_port" <<'NODE'
const endpoint = process.argv[2] ?? "";
const expectedPort = process.argv[3] ?? "";

try {
  const url = new URL(endpoint);
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost";
  const normalizedPort =
    url.port || (url.protocol === "http:" ? "80" : "443");
  if (
    url.protocol !== "http:" ||
    !isLoopback ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    normalizedPort !== expectedPort
  ) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
NODE
}

logto_validate_kek() {
  local value="${1-}"

  node --input-type=module - "$value" <<'NODE'
const value = process.argv[2] ?? "";
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) process.exit(1);
const decoded = Buffer.from(value, "base64");
if (
  decoded.byteLength !== 32 ||
  decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
) {
  process.exit(1);
}
NODE
}

logto_validate_env_value() {
  local name="${1-}"
  local value="${2-}"

  case "$name" in
    LOGTO_OSS_IMAGE)
      [[ "$value" == "svhd/logto:1.41.0" ]]
      ;;
    LOGTO_OSS_POSTGRES_IMAGE)
      [[ "$value" == "postgres:17-alpine" ]]
      ;;
    LOGTO_OSS_ENDPOINT)
      logto_validate_loopback_endpoint "$value" "${LOGTO_OSS_CORE_PORT-3301}"
      ;;
    LOGTO_OSS_ADMIN_ENDPOINT)
      logto_validate_loopback_endpoint "$value" "${LOGTO_OSS_ADMIN_PORT-3302}"
      ;;
    LOGTO_OSS_CORE_PORT | LOGTO_OSS_ADMIN_PORT)
      logto_validate_port "$value"
      ;;
    LOGTO_OSS_DB_NAME | LOGTO_OSS_DB_USER)
      (( ${#value} >= 1 && ${#value} <= 63 )) \
        && [[ "$value" =~ ^[a-z][a-z0-9_]*$ ]]
      ;;
    LOGTO_OSS_DB_PASSWORD)
      (( ${#value} >= 24 && ${#value} <= 128 )) \
        && [[ "$value" =~ ^[A-Za-z0-9]+$ ]]
      ;;
    LOGTO_OSS_SECRET_VAULT_KEK)
      logto_validate_kek "$value"
      ;;
    LOGTO_OSS_DATABASE_STATEMENT_TIMEOUT)
      [[ "$value" =~ ^[1-9][0-9]{2,8}$ ]]
      ;;
    LOGTO_OSS_PRIVATE_KEY_ROTATION_GRACE_PERIOD)
      [[ "$value" =~ ^[0-9]{1,8}$ ]]
      ;;
    *)
      return 1
      ;;
  esac
}

logto_validate_env_file() {
  local file="${1-}"
  local line=""
  local name=""
  local value=""
  local seen="|"
  local line_number=0
  local key=""

  [[ -f "$file" ]] || {
    printf 'Logto local environment file does not exist: %s\n' "$file" >&2
    return 1
  }

  # Ports must be loaded first because endpoint validation compares them.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      LOGTO_OSS_CORE_PORT | LOGTO_OSS_ADMIN_PORT)
        if ! logto_validate_env_value "$name" "$value"; then
          printf 'Unsafe or invalid Logto value for %s in %s.\n' \
            "$name" "$file" >&2
          return 1
        fi
        printf -v "$name" '%s' "$value"
        export "$name"
        ;;
    esac
  done <"$file"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      printf 'Invalid Logto environment line %s in %s.\n' \
        "$line_number" "$file" >&2
      return 1
    fi
    name="${line%%=*}"
    value="${line#*=}"
    if ! logto_is_known_env_key "$name"; then
      printf 'Unknown Logto environment key %s in %s.\n' "$name" "$file" >&2
      return 1
    fi
    if [[ "$seen" == *"|${name}|"* ]]; then
      printf 'Duplicate Logto environment key %s in %s.\n' "$name" "$file" >&2
      return 1
    fi
    if ! logto_validate_env_value "$name" "$value"; then
      printf 'Unsafe or invalid Logto value for %s in %s.\n' \
        "$name" "$file" >&2
      return 1
    fi
    seen="${seen}${name}|"
  done <"$file"

  if [[ "${LOGTO_OSS_CORE_PORT-}" == "${LOGTO_OSS_ADMIN_PORT-}" ]]; then
    printf 'Logto core and Admin Console ports must be different.\n' >&2
    return 1
  fi

  while IFS= read -r key; do
    if [[ "$seen" != *"|${key}|"* ]]; then
      printf 'Required Logto environment key %s is missing from %s.\n' \
        "$key" "$file" >&2
      return 1
    fi
  done < <(logto_env_keys)
}

logto_load_env() {
  local file="${1-}"
  local line=""
  local name=""
  local value=""

  logto_validate_env_file "$file" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    printf -v "$name" '%s' "$value"
    export "$name"
  done <"$file"
}

logto_unset_runtime_env() {
  local key=""

  while IFS= read -r key; do
    unset "$key"
  done < <(logto_env_keys)
}

logto_acquire_local_operation_lock() {
  local lock_dir="${1-}"

  if [[ -z "$lock_dir" ]]; then
    printf 'A Logto local operation lock directory is required.\n' >&2
    return 2
  fi
  if ! mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' \
      "Another Logto seed, backup, or alteration operation is active." \
      "Lock: ${lock_dir}" \
      "If a previous process was forcibly terminated, verify no operation is" \
      "running and remove this empty lock directory manually." >&2
    return 3
  fi
  LOGTO_LOCAL_OPERATION_LOCK_DIR="$lock_dir"
  export LOGTO_LOCAL_OPERATION_LOCK_DIR
}

logto_release_local_operation_lock() {
  local lock_dir="${LOGTO_LOCAL_OPERATION_LOCK_DIR-}"

  [[ -n "$lock_dir" ]] || return 0
  rmdir "$lock_dir" 2>/dev/null || true
  unset LOGTO_LOCAL_OPERATION_LOCK_DIR
}
