#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=deploy/matrix/env.sh
source "${REPO_ROOT}/deploy/matrix/env.sh"

valid_server_names=(
  "matrix.local"
  "Matrix.Example:8448"
  "127.0.0.1"
  "127.0.0.1:8008"
  "[2001:db8::1]"
  "[2001:DB8::1]:8448"
)
for server_name in "${valid_server_names[@]}"; do
  if ! matrix_validate_server_name "$server_name"; then
    printf 'Expected valid Matrix server name: %s\n' "$server_name" >&2
    exit 1
  fi
done

long_label="$(printf 'a%.0s' {1..64})"
long_server_name="$(printf 'a%.0s' {1..250}).local"
invalid_server_names=(
  ""
  "foo..bar"
  "-matrix.local"
  "matrix-.local"
  "${long_label}.local"
  "$long_server_name"
  "999.999.999.999"
  "2001:db8::1"
  "[2001:db8::1"
  "[2001:db8::1]:0"
  "matrix.local:70000"
  "matrix local"
)
for server_name in "${invalid_server_names[@]}"; do
  if matrix_validate_server_name "$server_name"; then
    printf 'Expected invalid Matrix server name: %s\n' "$server_name" >&2
    exit 1
  fi
done

matrix_validate_env_value MATRIX_LOCAL_UID "501"
matrix_validate_env_value MATRIX_LOCAL_GID "20"
if matrix_validate_env_value MATRIX_LOCAL_UID "-1"; then
  printf 'Expected negative Matrix uid to be rejected.\n' >&2
  exit 1
fi
if matrix_validate_env_value MATRIX_LOCAL_GID "4294967295"; then
  printf 'Expected oversized Matrix gid to be rejected.\n' >&2
  exit 1
fi

TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/delegate-matrix-env-test.XXXXXX")"
cleanup_matrix_env_test() {
  rm -r "$TEST_TMP_DIR"
}
trap cleanup_matrix_env_test EXIT

AS_TOKEN="as_token_abcdefghijklmnopqrstuvwxyz"
HS_TOKEN="hs_token_abcdefghijklmnopqrstuvwxyz"
VALID_ENV_FILE="${TEST_TMP_DIR}/matrix.env"
cat >"$VALID_ENV_FILE" <<EOF
MATRIX_AS_CONNECTION_ID=delegate-matrix-test-as
MATRIX_AS_TOKEN=${AS_TOKEN}
MATRIX_AS_HS_TOKEN=${HS_TOKEN}
EOF
matrix_require_env_keys "$VALID_ENV_FILE" \
  MATRIX_AS_CONNECTION_ID MATRIX_AS_TOKEN MATRIX_AS_HS_TOKEN

TRUNCATED_ENV_FILE="${TEST_TMP_DIR}/matrix-truncated.env"
cat >"$TRUNCATED_ENV_FILE" <<EOF
MATRIX_AS_CONNECTION_ID=delegate-matrix-test-as
MATRIX_AS_TOKEN=${AS_TOKEN}
EOF
if matrix_require_env_keys "$TRUNCATED_ENV_FILE" \
  MATRIX_AS_CONNECTION_ID MATRIX_AS_TOKEN MATRIX_AS_HS_TOKEN 2>/dev/null; then
  printf 'Expected a syntactically valid but truncated Matrix env to fail.\n' >&2
  exit 1
fi

REGISTRATION_FILE="${TEST_TMP_DIR}/delegate-appservice.yaml"
cat >"$REGISTRATION_FILE" <<EOF
id: 'delegate-matrix-test-as'
url: http://matrix-bridge:4030
as_token: '${AS_TOKEN}'
hs_token: '${HS_TOKEN}'
sender_localpart: _delegate_as
EOF
matrix_assert_appservice_registration_matches \
  "$REGISTRATION_FILE" \
  "delegate-matrix-test-as" \
  "$AS_TOKEN" \
  "$HS_TOKEN"
if matrix_assert_appservice_registration_matches \
  "$REGISTRATION_FILE" \
  "different-connection-id" \
  "$AS_TOKEN" \
  "$HS_TOKEN" 2>/dev/null; then
  printf 'Expected a changed Matrix connection id to fail closed.\n' >&2
  exit 1
fi
if matrix_assert_appservice_registration_matches \
  "$REGISTRATION_FILE" \
  "delegate-matrix-test-as" \
  "different_as_token_abcdefghijklmnopqrstuvwxyz" \
  "$HS_TOKEN" 2>/dev/null; then
  printf 'Expected a changed Matrix AS token to fail closed.\n' >&2
  exit 1
fi

DUPLICATE_REGISTRATION_FILE="${TEST_TMP_DIR}/duplicate-appservice.yaml"
cat >"$DUPLICATE_REGISTRATION_FILE" <<EOF
id: 'delegate-matrix-test-as'
id: 'duplicate-matrix-test-as'
as_token: '${AS_TOKEN}'
hs_token: '${HS_TOKEN}'
EOF
if matrix_load_appservice_registration \
  "$DUPLICATE_REGISTRATION_FILE" 2>/dev/null; then
  printf 'Expected a duplicate Matrix registration id to fail closed.\n' >&2
  exit 1
fi

printf 'result=matrix_local_env_tests_passed\n'
