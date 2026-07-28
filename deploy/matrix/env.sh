#!/usr/bin/env bash

# This file is sourced as trusted repository code. Generated matrix.env files
# must only be loaded through matrix_load_env; never source them directly.

matrix_validate_server_name() {
  local value="${1-}"
  node --input-type=module - "$value" <<'NODE'
import { isIP } from "node:net";

const value = process.argv[2] ?? "";
const validPort = (port) =>
  port === undefined || (/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535);
const validDnsName = (host) =>
  host.length <= 255
  && !/^\d+(?:\.\d+){3}$/.test(host)
  && host.split(".").every(
    (label) =>
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );

if (!value || value.length > 255 || /\s/.test(value)) process.exit(1);

let host = value;
let port;
if (value.startsWith("[")) {
  const closingBracket = value.indexOf("]");
  if (closingBracket <= 1) process.exit(1);
  host = value.slice(1, closingBracket);
  const suffix = value.slice(closingBracket + 1);
  if (suffix) {
    if (!suffix.startsWith(":")) process.exit(1);
    port = suffix.slice(1);
  }
  if (isIP(host) !== 6) process.exit(1);
} else {
  const separator = value.lastIndexOf(":");
  if (separator !== -1) {
    if (value.indexOf(":") !== separator) process.exit(1);
    host = value.slice(0, separator);
    port = value.slice(separator + 1);
  }
  if (!host || (isIP(host) !== 4 && !validDnsName(host))) process.exit(1);
}

process.exit(validPort(port) ? 0 : 1);
NODE
}

matrix_validate_env_value() {
  local name="${1-}"
  local value="${2-}"

  case "$name" in
    MATRIX_SYNAPSE_IMAGE)
      (( ${#value} <= 255 )) \
        && [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]*$ ]]
      ;;
    MATRIX_SYNAPSE_HOST_PORT)
      [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && (( value <= 65535 ))
      ;;
    MATRIX_LOCAL_SERVER_NAME | MATRIX_SERVER_NAME)
      matrix_validate_server_name "$value"
      ;;
    MATRIX_HOMESERVER_URL)
      [[ "$value" == "http://synapse:8008" \
        || "$value" == "http://matrix-e2e-synapse:8008" ]]
      ;;
    MATRIX_LOCAL_HOMESERVER_URL)
      [[ "$value" =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] \
        && (( BASH_REMATCH[1] <= 65535 ))
      ;;
    MATRIX_LOCAL_BRIDGE_URL)
      [[ "$value" =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] \
        && (( BASH_REMATCH[1] <= 65535 ))
      ;;
    MATRIX_AS_CONNECTION_ID)
      (( ${#value} <= 128 )) \
        && [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
      ;;
    MATRIX_AS_TOKEN | MATRIX_AS_HS_TOKEN)
      (( ${#value} >= 24 && ${#value} <= 512 )) \
        && [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._~+=:@%/-]*$ ]]
      ;;
    MATRIX_LOCAL_UID | MATRIX_LOCAL_GID)
      [[ "$value" =~ ^[0-9]{1,10}$ ]] \
        && (( 10#$value <= 4294967294 ))
      ;;
    MATRIX_LOCAL_REGISTRATION_SHARED_SECRET_BASE64)
      (( ${#value} >= 4 && ${#value} <= 2048 )) \
        && [[ "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]
      ;;
    MATRIX_LOCAL_TEST_USERNAME)
      (( ${#value} <= 255 )) \
        && [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._=-]*$ ]]
      ;;
    MATRIX_LOCAL_TEST_PASSWORD)
      (( ${#value} >= 12 && ${#value} <= 255 )) \
        && [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._~+=:@%/-]*$ ]]
      ;;
    *)
      return 1
      ;;
  esac
}

matrix_validate_env_file() {
  local file="${1-}"
  local line=""
  local name=""
  local value=""
  local seen="|"
  local line_number=0

  [[ -f "$file" ]] || {
    printf 'Matrix environment file does not exist: %s\n' "$file" >&2
    return 1
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      printf 'Invalid Matrix environment line %s in %s.\n' \
        "$line_number" "$file" >&2
      return 1
    fi
    name="${line%%=*}"
    value="${line#*=}"
    if [[ "$seen" == *"|${name}|"* ]]; then
      printf 'Duplicate Matrix environment key %s in %s.\n' \
        "$name" "$file" >&2
      return 1
    fi
    if ! matrix_validate_env_value "$name" "$value"; then
      printf 'Unsafe or invalid Matrix environment value for %s in %s.\n' \
        "$name" "$file" >&2
      return 1
    fi
    seen="${seen}${name}|"
  done <"$file"
}

matrix_require_env_keys() {
  local file="${1-}"
  shift || true
  local name=""
  local line=""
  local found=""

  matrix_validate_env_file "$file" || return 1
  for name in "$@"; do
    found="false"
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      if [[ "${line%%=*}" == "$name" ]]; then
        found="true"
        break
      fi
    done <"$file"
    if [[ "$found" != "true" ]]; then
      printf 'Required Matrix environment key %s is missing from %s.\n' \
        "$name" "$file" >&2
      return 1
    fi
  done
}

matrix_read_registration_value() {
  local file="${1-}"
  local key="${2-}"
  local line=""
  local match=""
  local match_count=0
  local prefix=""
  local value=""

  [[ -f "$file" ]] || {
    printf 'Matrix Application Service registration does not exist: %s\n' \
      "$file" >&2
    return 1
  }
  case "$key" in
    id | as_token | hs_token)
      ;;
    *)
      printf 'Unsupported Matrix Application Service registration key: %s\n' \
        "$key" >&2
      return 1
      ;;
  esac

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}:"* ]]; then
      match="$line"
      match_count=$((match_count + 1))
    fi
  done <"$file"
  if [[ "$match_count" -ne 1 ]]; then
    printf 'Expected exactly one %s in Matrix registration %s.\n' \
      "$key" "$file" >&2
    return 1
  fi

  prefix="${key}: '"
  if [[ "$match" != "${prefix}"*"'" ]]; then
    printf 'Matrix registration %s must use the generated quoted %s format.\n' \
      "$file" "$key" >&2
    return 1
  fi
  value="${match#"$prefix"}"
  value="${value%\'}"
  if [[ -z "$value" || "$match" != "${prefix}${value}'" ]]; then
    printf 'Matrix registration %s has an invalid %s value.\n' \
      "$file" "$key" >&2
    return 1
  fi
  printf '%s' "$value"
}

matrix_load_appservice_registration() {
  local file="${1-}"

  MATRIX_REGISTRATION_CONNECTION_ID="$(
    matrix_read_registration_value "$file" id
  )" || return 1
  MATRIX_REGISTRATION_AS_TOKEN="$(
    matrix_read_registration_value "$file" as_token
  )" || return 1
  MATRIX_REGISTRATION_HS_TOKEN="$(
    matrix_read_registration_value "$file" hs_token
  )" || return 1

  if ! matrix_validate_env_value \
    MATRIX_AS_CONNECTION_ID "$MATRIX_REGISTRATION_CONNECTION_ID"; then
    printf 'Matrix registration %s has an invalid Application Service id.\n' \
      "$file" >&2
    return 1
  fi
  if ! matrix_validate_env_value MATRIX_AS_TOKEN "$MATRIX_REGISTRATION_AS_TOKEN"; then
    printf 'Matrix registration %s has an invalid Application Service token.\n' \
      "$file" >&2
    return 1
  fi
  if ! matrix_validate_env_value \
    MATRIX_AS_HS_TOKEN "$MATRIX_REGISTRATION_HS_TOKEN"; then
    printf 'Matrix registration %s has an invalid homeserver token.\n' \
      "$file" >&2
    return 1
  fi
}

matrix_assert_appservice_registration_matches() {
  local file="${1-}"
  local expected_connection_id="${2-}"
  local expected_as_token="${3-}"
  local expected_hs_token="${4-}"

  matrix_load_appservice_registration "$file" || return 1
  if [[ "$expected_connection_id" != "$MATRIX_REGISTRATION_CONNECTION_ID" \
    || "$expected_as_token" != "$MATRIX_REGISTRATION_AS_TOKEN" \
    || "$expected_hs_token" != "$MATRIX_REGISTRATION_HS_TOKEN" ]]; then
    printf 'Matrix environment credentials do not match registration %s.\n' \
      "$file" >&2
    return 1
  fi
}

matrix_load_env() {
  local file="${1-}"
  local line=""
  local name=""
  local value=""

  matrix_validate_env_file "$file" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    printf -v "$name" '%s' "$value"
    export "$name"
  done <"$file"
}
