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

COMPOSE_TEST_ROOT="${TEST_TMP_DIR}/compose-repo"
COMPOSE_TEST_FAKE_BIN="${TEST_TMP_DIR}/fake-bin"
COMPOSE_TEST_OUTPUT="${TEST_TMP_DIR}/compose-output.log"
ROOT_ENV_PROBE="${TEST_TMP_DIR}/root-env-was-sourced"
ROOT_MODEL_SECRET="root_model_secret_do_not_print_123"
MATRIX_AS_SECRET="matrix_as_secret_do_not_print_abcdefghijklmnopqrstuvwxyz"
MATRIX_HS_SECRET="matrix_hs_secret_do_not_print_abcdefghijklmnopqrstuvwxyz"

mkdir -p \
  "${COMPOSE_TEST_ROOT}/deploy/matrix" \
  "${COMPOSE_TEST_ROOT}/.local/matrix" \
  "$COMPOSE_TEST_FAKE_BIN"
cp "${REPO_ROOT}/deploy/matrix/compose.sh" \
  "${COMPOSE_TEST_ROOT}/deploy/matrix/compose.sh"
cp "${REPO_ROOT}/deploy/matrix/env.sh" \
  "${COMPOSE_TEST_ROOT}/deploy/matrix/env.sh"

cat >"${COMPOSE_TEST_ROOT}/.env" <<EOF
DELEGATE_MODEL_PROVIDER=bailian
DELEGATE_BAILIAN_API_KEY=${ROOT_MODEL_SECRET}
MATRIX_SERVER_NAME=matrix-from-root.invalid
ROOT_ENV_EXECUTION_PROBE=\$(touch ${ROOT_ENV_PROBE})
EOF
cat >"${COMPOSE_TEST_ROOT}/.local/matrix/matrix.env" <<EOF
MATRIX_SERVER_NAME=matrix.local
MATRIX_AS_CONNECTION_ID=delegate-matrix-test-as
MATRIX_AS_TOKEN=${MATRIX_AS_SECRET}
MATRIX_AS_HS_TOKEN=${MATRIX_HS_SECRET}
EOF

cat >"${COMPOSE_TEST_FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${1-}" == "compose" ]] || exit 10
shift

compose_args=("$@")
declare -a env_files=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || exit 11
      env_files+=("$2")
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ "${#env_files[@]}" -eq 2 ]] || exit 12
[[ "${env_files[0]}" == "${PWD}/.env" ]] || exit 13
[[ "${env_files[1]}" == "${PWD}/.local/matrix/matrix.env" ]] || exit 14

resolved_model_provider=""
resolved_model_api_key=""
resolved_matrix_server_name=""
resolved_matrix_as_token=""
saw_config_command="false"
saw_no_interpolate="false"
for env_file in "${env_files[@]}"; do
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || exit 15
    case "${line%%=*}" in
      DELEGATE_MODEL_PROVIDER)
        resolved_model_provider="${line#*=}"
        ;;
      DELEGATE_BAILIAN_API_KEY)
        resolved_model_api_key="${line#*=}"
        ;;
      MATRIX_SERVER_NAME)
        resolved_matrix_server_name="${line#*=}"
        ;;
      MATRIX_AS_TOKEN)
        resolved_matrix_as_token="${line#*=}"
        ;;
    esac
  done <"$env_file"
done

for argument in "${compose_args[@]}"; do
  case "$argument" in
    config | convert)
      saw_config_command="true"
      ;;
    --no-interpolate)
      saw_no_interpolate="true"
      ;;
  esac
done

[[ "$resolved_model_provider" == "bailian" ]] || exit 16
[[ "$resolved_model_api_key" \
  == "root_model_secret_do_not_print_123" ]] || exit 17
[[ "$resolved_matrix_server_name" == "matrix.local" ]] || exit 18
[[ "$resolved_matrix_as_token" \
  == "matrix_as_secret_do_not_print_abcdefghijklmnopqrstuvwxyz" ]] || exit 19

# The repository .env must reach Compose as a file, not as sourced shell state.
[[ -z "${DELEGATE_BAILIAN_API_KEY+x}" ]] || exit 20
# The generated, validated Matrix environment deliberately replaces inherited
# production-shaped Matrix variables before Compose interpolation.
[[ "${MATRIX_SERVER_NAME-}" == "matrix.local" ]] || exit 21
[[ "$saw_config_command" == "true" ]] || exit 22
[[ "$saw_no_interpolate" == "true" ]] || exit 23

printf 'result=compose_env_layering_passed\n'
EOF
chmod +x "${COMPOSE_TEST_FAKE_BIN}/docker"

if ! env \
  -u DELEGATE_MODEL_PROVIDER \
  -u DELEGATE_BAILIAN_API_KEY \
  MATRIX_SERVER_NAME=matrix-from-caller.invalid \
  PATH="${COMPOSE_TEST_FAKE_BIN}:${PATH}" \
  bash "${COMPOSE_TEST_ROOT}/deploy/matrix/compose.sh" config \
  >"$COMPOSE_TEST_OUTPUT" 2>&1; then
  printf 'Expected Matrix compose environment layering test to pass.\n' >&2
  exit 1
fi
if [[ -e "$ROOT_ENV_PROBE" ]]; then
  printf 'Expected repository .env to remain unexecuted.\n' >&2
  exit 1
fi
for secret in "$ROOT_MODEL_SECRET" "$MATRIX_AS_SECRET" "$MATRIX_HS_SECRET"; do
  if grep -Fq -- "$secret" "$COMPOSE_TEST_OUTPUT"; then
    printf 'Expected compose environment test output to redact credentials.\n' >&2
    exit 1
  fi
done

if env \
  PATH="${COMPOSE_TEST_FAKE_BIN}:${PATH}" \
  bash "${COMPOSE_TEST_ROOT}/deploy/matrix/compose.sh" config --environment \
  >"$COMPOSE_TEST_OUTPUT" 2>&1; then
  printf 'Expected Matrix compose config --environment to be refused.\n' >&2
  exit 1
fi
for secret in "$ROOT_MODEL_SECRET" "$MATRIX_AS_SECRET" "$MATRIX_HS_SECRET"; do
  if grep -Fq -- "$secret" "$COMPOSE_TEST_OUTPUT"; then
    printf 'Expected refused config environment output to omit credentials.\n' >&2
    exit 1
  fi
done

if docker compose version >/dev/null 2>&1; then
  cat >"${COMPOSE_TEST_ROOT}/compose.yml" <<'EOF'
services:
  config-probe:
    image: alpine:3.20
    environment:
      DELEGATE_MODEL_PROVIDER: ${DELEGATE_MODEL_PROVIDER:-openai}
      DELEGATE_BAILIAN_API_KEY: ${DELEGATE_BAILIAN_API_KEY:-}
      MATRIX_AS_TOKEN: ${MATRIX_AS_TOKEN:-}
EOF
  cat >"${COMPOSE_TEST_ROOT}/compose.local.yml" <<'EOF'
services: {}
EOF
  cat >"${COMPOSE_TEST_ROOT}/compose.matrix.yml" <<'EOF'
services: {}
EOF
  if ! bash "${COMPOSE_TEST_ROOT}/deploy/matrix/compose.sh" config \
    >"$COMPOSE_TEST_OUTPUT" 2>&1; then
    printf 'Expected real Matrix compose config preview to pass.\n' >&2
    exit 1
  fi
  for secret in "$ROOT_MODEL_SECRET" "$MATRIX_AS_SECRET" "$MATRIX_HS_SECRET"; do
    if grep -Fq -- "$secret" "$COMPOSE_TEST_OUTPUT"; then
      printf 'Expected real compose config preview to omit credentials.\n' >&2
      exit 1
    fi
  done
fi

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
