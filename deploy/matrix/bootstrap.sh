#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MATRIX_LOCAL_INSTANCE="${MATRIX_LOCAL_INSTANCE:-normal}"
case "$MATRIX_LOCAL_INSTANCE" in
  normal)
    RUNTIME_ROOT="${REPO_ROOT}/.local/matrix"
    DEFAULT_SERVER_NAME="matrix.local"
    DEFAULT_HOST_PORT="8008"
    DEFAULT_CONNECTION_ID="delegate-matrix-as"
    INTERNAL_HOMESERVER_URL="http://synapse:8008"
    APPLICATION_SERVICE_URL="http://matrix-bridge:4030"
    LOCAL_BRIDGE_URL="http://127.0.0.1:4030"
    ;;
  e2e)
    RUNTIME_ROOT="${REPO_ROOT}/.local/matrix-e2e"
    DEFAULT_SERVER_NAME="matrix-e2e.local"
    DEFAULT_HOST_PORT="8009"
    DEFAULT_CONNECTION_ID="delegate-matrix-e2e-as"
    INTERNAL_HOMESERVER_URL="http://matrix-e2e-synapse:8008"
    APPLICATION_SERVICE_URL="http://matrix-e2e-bridge:4030"
    LOCAL_BRIDGE_URL="http://127.0.0.1:4031"
    ;;
  *)
    printf 'MATRIX_LOCAL_INSTANCE must be normal or e2e.\n' >&2
    exit 2
    ;;
esac
SYNAPSE_DATA_DIR="${RUNTIME_ROOT}/synapse"
ENV_FILE="${RUNTIME_ROOT}/matrix.env"
APP_SERVICE_FILE="${SYNAPSE_DATA_DIR}/delegate-appservice.yaml"
HOMESERVER_FILE="${SYNAPSE_DATA_DIR}/homeserver.yaml"

REQUESTED_SYNAPSE_IMAGE_SET="${MATRIX_LOCAL_SYNAPSE_IMAGE+x}"
REQUESTED_SYNAPSE_IMAGE="${MATRIX_LOCAL_SYNAPSE_IMAGE-}"
REQUESTED_LOCAL_SERVER_NAME_SET="${MATRIX_LOCAL_SERVER_NAME+x}"
REQUESTED_LOCAL_SERVER_NAME="${MATRIX_LOCAL_SERVER_NAME-}"
REQUESTED_HOST_PORT_SET="${MATRIX_LOCAL_HOST_PORT+x}"
REQUESTED_HOST_PORT="${MATRIX_LOCAL_HOST_PORT-}"
REQUESTED_CONNECTION_ID_SET="${MATRIX_LOCAL_CONNECTION_ID+x}"
REQUESTED_CONNECTION_ID="${MATRIX_LOCAL_CONNECTION_ID-}"
REQUESTED_AS_TOKEN_SET="${MATRIX_LOCAL_AS_TOKEN+x}"
REQUESTED_AS_TOKEN="${MATRIX_LOCAL_AS_TOKEN-}"
REQUESTED_HS_TOKEN_SET="${MATRIX_LOCAL_AS_HS_TOKEN+x}"
REQUESTED_HS_TOKEN="${MATRIX_LOCAL_AS_HS_TOKEN-}"
REQUESTED_UID_SET="${MATRIX_LOCAL_UID+x}"
REQUESTED_UID="${MATRIX_LOCAL_UID-}"
REQUESTED_GID_SET="${MATRIX_LOCAL_GID+x}"
REQUESTED_GID="${MATRIX_LOCAL_GID-}"
REQUESTED_TEST_USERNAME_SET="${MATRIX_LOCAL_TEST_USERNAME+x}"
REQUESTED_TEST_USERNAME="${MATRIX_LOCAL_TEST_USERNAME-}"
REQUESTED_TEST_PASSWORD_SET="${MATRIX_LOCAL_TEST_PASSWORD+x}"
REQUESTED_TEST_PASSWORD="${MATRIX_LOCAL_TEST_PASSWORD-}"

# Never treat production-shaped runtime variables from the caller's shell as
# local bootstrap input. Existing generated values are loaded only from the
# validated, Git-ignored matrix.env below; explicit overrides use MATRIX_LOCAL_*.
unset MATRIX_SYNAPSE_IMAGE MATRIX_LOCAL_SERVER_NAME MATRIX_SERVER_NAME
unset MATRIX_SYNAPSE_HOST_PORT MATRIX_AS_CONNECTION_ID
unset MATRIX_AS_TOKEN MATRIX_AS_HS_TOKEN
unset MATRIX_LOCAL_UID MATRIX_LOCAL_GID
unset MATRIX_LOCAL_TEST_USERNAME MATRIX_LOCAL_TEST_PASSWORD

# shellcheck source=deploy/matrix/env.sh
source "${SCRIPT_DIR}/env.sh"

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required to generate the local Synapse configuration.\n' >&2
  exit 2
}
command -v openssl >/dev/null 2>&1 || {
  printf 'OpenSSL is required to generate local Matrix secrets.\n' >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  printf 'Node.js is required to validate local Matrix identifiers.\n' >&2
  exit 2
}

umask 077
mkdir -p "$SYNAPSE_DATA_DIR"

ENV_FILE_EXISTS="false"
APP_SERVICE_FILE_EXISTS="false"
[[ ! -f "$ENV_FILE" ]] || ENV_FILE_EXISTS="true"
[[ ! -f "$APP_SERVICE_FILE" ]] || APP_SERVICE_FILE_EXISTS="true"
if [[ "$ENV_FILE_EXISTS" != "$APP_SERVICE_FILE_EXISTS" ]]; then
  printf '%s\n' \
    "Existing Matrix state is incomplete under ${RUNTIME_ROOT}." \
    "matrix.env and the Application Service registration must either both exist" \
    "or both be absent on the first initialization. Refusing to rotate credentials." >&2
  exit 3
fi
if [[ "$APP_SERVICE_FILE_EXISTS" == "true" \
  && ! -f "$HOMESERVER_FILE" ]]; then
  printf '%s\n' \
    "Existing Matrix state is incomplete under ${RUNTIME_ROOT}." \
    "The Application Service registration and matrix.env exist, but" \
    "homeserver.yaml is missing. Refusing to generate a replacement homeserver." >&2
  exit 3
fi

if [[ "$ENV_FILE_EXISTS" == "true" ]]; then
  matrix_require_env_keys "$ENV_FILE" \
    MATRIX_AS_CONNECTION_ID \
    MATRIX_AS_TOKEN \
    MATRIX_AS_HS_TOKEN
  matrix_load_env "$ENV_FILE"
  if ! matrix_assert_appservice_registration_matches \
    "$APP_SERVICE_FILE" \
    "$MATRIX_AS_CONNECTION_ID" \
    "$MATRIX_AS_TOKEN" \
    "$MATRIX_AS_HS_TOKEN"; then
    printf '%s\n' \
      "Existing Matrix credentials disagree between ${ENV_FILE}" \
      "and ${APP_SERVICE_FILE}. Refusing to rewrite either file." \
      "Stop the stack and intentionally repair or recreate ${RUNTIME_ROOT};" \
      "reset or migrate database channel rows before changing the connection id." >&2
    exit 3
  fi
fi

select_matrix_value() {
  local requested_set="${1-}"
  local requested="${2-}"
  local existing="${3-}"
  local fallback="${4-}"
  if [[ "$requested_set" == "x" ]]; then
    printf '%s' "$requested"
  elif [[ -n "$existing" ]]; then
    printf '%s' "$existing"
  else
    printf '%s' "$fallback"
  fi
}

REQUESTED_EFFECTIVE_SERVER_NAME_SET="$REQUESTED_LOCAL_SERVER_NAME_SET"
REQUESTED_EFFECTIVE_SERVER_NAME="$REQUESTED_LOCAL_SERVER_NAME"

EXISTING_LOCAL_SERVER_NAME="${MATRIX_LOCAL_SERVER_NAME-}"
EXISTING_SERVER_NAME="${MATRIX_SERVER_NAME-}"
if [[ -n "$EXISTING_LOCAL_SERVER_NAME" \
  && -n "$EXISTING_SERVER_NAME" \
  && "$EXISTING_LOCAL_SERVER_NAME" != "$EXISTING_SERVER_NAME" ]]; then
  printf 'Existing matrix.env has mismatched local and runtime server names.\n' >&2
  exit 3
fi
EXISTING_EFFECTIVE_SERVER_NAME="${EXISTING_LOCAL_SERVER_NAME:-$EXISTING_SERVER_NAME}"

CONFIGURED_SERVER_NAME=""
if [[ -f "$HOMESERVER_FILE" ]]; then
  CONFIGURED_SERVER_NAME="$(
    sed -n -e 's/^server_name:[[:space:]]*//p' "$HOMESERVER_FILE" \
      | head -n 1
  )"
  case "$CONFIGURED_SERVER_NAME" in
    \"*\")
      CONFIGURED_SERVER_NAME="${CONFIGURED_SERVER_NAME#\"}"
      CONFIGURED_SERVER_NAME="${CONFIGURED_SERVER_NAME%\"}"
      ;;
    \'*\')
      CONFIGURED_SERVER_NAME="${CONFIGURED_SERVER_NAME#\'}"
      CONFIGURED_SERVER_NAME="${CONFIGURED_SERVER_NAME%\'}"
      ;;
    *)
      CONFIGURED_SERVER_NAME="${CONFIGURED_SERVER_NAME%%[[:space:]]*}"
      ;;
  esac
  if ! matrix_validate_server_name "$CONFIGURED_SERVER_NAME"; then
    printf 'Existing Synapse homeserver.yaml has an invalid server_name.\n' >&2
    exit 3
  fi
fi

if [[ -n "$CONFIGURED_SERVER_NAME" \
  && -n "$EXISTING_EFFECTIVE_SERVER_NAME" \
  && "$EXISTING_EFFECTIVE_SERVER_NAME" != "$CONFIGURED_SERVER_NAME" ]]; then
  printf '%s\n' \
    "Existing Matrix state is inconsistent: matrix.env requests '${EXISTING_EFFECTIVE_SERVER_NAME}'" \
    "but Synapse is permanently configured as '${CONFIGURED_SERVER_NAME}'." >&2
  exit 3
fi
if [[ "$REQUESTED_EFFECTIVE_SERVER_NAME_SET" == "x" \
  && -n "$CONFIGURED_SERVER_NAME" \
  && "$REQUESTED_EFFECTIVE_SERVER_NAME" != "$CONFIGURED_SERVER_NAME" ]]; then
  printf '%s\n' \
    "Cannot change local Synapse server_name from '${CONFIGURED_SERVER_NAME}'" \
    "to '${REQUESTED_EFFECTIVE_SERVER_NAME}' in existing state." \
    "Choose the existing name or intentionally recreate ${RUNTIME_ROOT}." >&2
  exit 3
fi

if [[ "$APP_SERVICE_FILE_EXISTS" == "true" \
  && "$REQUESTED_CONNECTION_ID_SET" == "x" \
  && "$REQUESTED_CONNECTION_ID" != "$MATRIX_REGISTRATION_CONNECTION_ID" ]]; then
  printf '%s\n' \
    "Cannot change the local Matrix Application Service connection id from" \
    "'${MATRIX_REGISTRATION_CONNECTION_ID}' to '${REQUESTED_CONNECTION_ID}'" \
    "in existing state. Stop the stack and intentionally recreate ${RUNTIME_ROOT};" \
    "reset or migrate database channel rows that reference the old connection id." >&2
  exit 3
fi

SYNAPSE_IMAGE="$(
  select_matrix_value \
    "$REQUESTED_SYNAPSE_IMAGE_SET" \
    "$REQUESTED_SYNAPSE_IMAGE" \
    "${MATRIX_SYNAPSE_IMAGE-}" \
    "matrixdotorg/synapse:v1.157.0"
)"
SERVER_NAME="$(
  select_matrix_value \
    "$REQUESTED_EFFECTIVE_SERVER_NAME_SET" \
    "$REQUESTED_EFFECTIVE_SERVER_NAME" \
    "${CONFIGURED_SERVER_NAME:-$EXISTING_EFFECTIVE_SERVER_NAME}" \
    "$DEFAULT_SERVER_NAME"
)"
HOST_PORT="$(
  select_matrix_value \
    "$REQUESTED_HOST_PORT_SET" \
    "$REQUESTED_HOST_PORT" \
    "${MATRIX_SYNAPSE_HOST_PORT-}" \
    "$DEFAULT_HOST_PORT"
)"
CONNECTION_ID="$(
  select_matrix_value \
    "$REQUESTED_CONNECTION_ID_SET" \
    "$REQUESTED_CONNECTION_ID" \
    "${MATRIX_REGISTRATION_CONNECTION_ID-${MATRIX_AS_CONNECTION_ID-}}" \
    "$DEFAULT_CONNECTION_ID"
)"
CURRENT_HOST_UID="$(id -u)"
CURRENT_HOST_GID="$(id -g)"
HOST_UID="$CURRENT_HOST_UID"
HOST_GID="$CURRENT_HOST_GID"
if [[ "$HOST_UID" == "0" ]]; then
  HOST_UID="991"
fi
if [[ "$HOST_GID" == "0" ]]; then
  HOST_GID="991"
fi
SYNAPSE_UID="$(
  select_matrix_value \
    "$REQUESTED_UID_SET" \
    "$REQUESTED_UID" \
    "${MATRIX_LOCAL_UID-}" \
    "$HOST_UID"
)"
SYNAPSE_GID="$(
  select_matrix_value \
    "$REQUESTED_GID_SET" \
    "$REQUESTED_GID" \
    "${MATRIX_LOCAL_GID-}" \
    "$HOST_GID"
)"
if [[ "$CURRENT_HOST_UID" != "0" && "$SYNAPSE_UID" != "$CURRENT_HOST_UID" ]]; then
  printf '%s\n' \
    "MATRIX_LOCAL_UID=${SYNAPSE_UID} cannot own the bind-mounted Synapse files" \
    "when bootstrap runs as host uid ${CURRENT_HOST_UID}." >&2
  exit 2
fi

for pair in \
  "MATRIX_SYNAPSE_IMAGE=${SYNAPSE_IMAGE}" \
  "MATRIX_SYNAPSE_HOST_PORT=${HOST_PORT}" \
  "MATRIX_LOCAL_SERVER_NAME=${SERVER_NAME}" \
  "MATRIX_AS_CONNECTION_ID=${CONNECTION_ID}" \
  "MATRIX_LOCAL_UID=${SYNAPSE_UID}" \
  "MATRIX_LOCAL_GID=${SYNAPSE_GID}"; do
  name="${pair%%=*}"
  value="${pair#*=}"
  if ! matrix_validate_env_value "$name" "$value"; then
    printf 'Invalid or unsafe %s value.\n' "$name" >&2
    exit 2
  fi
done

if [[ ! -f "$HOMESERVER_FILE" ]]; then
  printf 'phase=generate_synapse_config image=%s server=%s\n' \
    "$SYNAPSE_IMAGE" "$SERVER_NAME"
  docker run --rm \
    --env "SYNAPSE_SERVER_NAME=${SERVER_NAME}" \
    --env "SYNAPSE_REPORT_STATS=no" \
    --env "UID=${SYNAPSE_UID}" \
    --env "GID=${SYNAPSE_GID}" \
    --volume "${SYNAPSE_DATA_DIR}:/data" \
    "$SYNAPSE_IMAGE" generate
fi

REGISTRATION_SHARED_SECRET="$(
  sed -n \
    -e 's/^registration_shared_secret:[[:space:]]*//p' \
    "$HOMESERVER_FILE" \
    | head -n 1 \
    | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
)"
if [[ -z "$REGISTRATION_SHARED_SECRET" ]]; then
  printf 'Synapse config does not contain registration_shared_secret.\n' >&2
  exit 3
fi

if [[ "$APP_SERVICE_FILE_EXISTS" == "true" \
  && "$REQUESTED_AS_TOKEN_SET" == "x" \
  && "$REQUESTED_AS_TOKEN" != "$MATRIX_REGISTRATION_AS_TOKEN" ]]; then
  printf '%s\n' \
    "The local Application Service token is immutable for existing state." \
    "Stop the stack and intentionally recreate ${RUNTIME_ROOT} to rotate it." >&2
  exit 3
fi
if [[ "$APP_SERVICE_FILE_EXISTS" == "true" \
  && "$REQUESTED_HS_TOKEN_SET" == "x" \
  && "$REQUESTED_HS_TOKEN" != "$MATRIX_REGISTRATION_HS_TOKEN" ]]; then
  printf '%s\n' \
    "The local homeserver token is immutable for existing state." \
    "Stop the stack and intentionally recreate ${RUNTIME_ROOT} to rotate it." >&2
  exit 3
fi

AS_TOKEN="$(
  select_matrix_value \
    "$REQUESTED_AS_TOKEN_SET" \
    "$REQUESTED_AS_TOKEN" \
    "${MATRIX_REGISTRATION_AS_TOKEN-${MATRIX_AS_TOKEN-}}" \
    "$(openssl rand -hex 32)"
)"
HS_TOKEN="$(
  select_matrix_value \
    "$REQUESTED_HS_TOKEN_SET" \
    "$REQUESTED_HS_TOKEN" \
    "${MATRIX_REGISTRATION_HS_TOKEN-${MATRIX_AS_HS_TOKEN-}}" \
    "$(openssl rand -hex 32)"
)"
TEST_USERNAME="$(
  select_matrix_value \
    "$REQUESTED_TEST_USERNAME_SET" \
    "$REQUESTED_TEST_USERNAME" \
    "${MATRIX_LOCAL_TEST_USERNAME-}" \
    "delegate_test"
)"
TEST_PASSWORD="$(
  select_matrix_value \
    "$REQUESTED_TEST_PASSWORD_SET" \
    "$REQUESTED_TEST_PASSWORD" \
    "${MATRIX_LOCAL_TEST_PASSWORD-}" \
    "$(openssl rand -hex 24)"
)"
for pair in \
  "MATRIX_AS_TOKEN=${AS_TOKEN}" \
  "MATRIX_AS_HS_TOKEN=${HS_TOKEN}" \
  "MATRIX_LOCAL_TEST_USERNAME=${TEST_USERNAME}" \
  "MATRIX_LOCAL_TEST_PASSWORD=${TEST_PASSWORD}"; do
  name="${pair%%=*}"
  value="${pair#*=}"
  if ! matrix_validate_env_value "$name" "$value"; then
    printf 'Invalid or unsafe %s value.\n' "$name" >&2
    exit 2
  fi
done

ESCAPED_SERVER_NAME="$(
  printf '%s' "$SERVER_NAME" \
    | sed -e 's/\./\\./g' -e 's/\[/\\[/g' -e 's/\]/\\]/g'
)"
REGISTRATION_SHARED_SECRET_BASE64="$(
  printf '%s' "$REGISTRATION_SHARED_SECRET" | openssl base64 -A
)"
if ! matrix_validate_env_value \
  MATRIX_LOCAL_REGISTRATION_SHARED_SECRET_BASE64 \
  "$REGISTRATION_SHARED_SECRET_BASE64"; then
  printf 'Synapse generated an invalid registration shared secret.\n' >&2
  exit 3
fi

APP_SERVICE_TEMP=""
if [[ "$APP_SERVICE_FILE_EXISTS" == "false" ]]; then
  APP_SERVICE_TEMP="$(mktemp "${APP_SERVICE_FILE}.tmp.XXXXXX")"
fi
ENV_TEMP="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
cleanup_matrix_temp_files() {
  [[ -z "$APP_SERVICE_TEMP" || ! -f "$APP_SERVICE_TEMP" ]] \
    || unlink "$APP_SERVICE_TEMP"
  [[ ! -f "$ENV_TEMP" ]] || unlink "$ENV_TEMP"
}
trap cleanup_matrix_temp_files EXIT

if [[ "$APP_SERVICE_FILE_EXISTS" == "false" ]]; then
  cat >"$APP_SERVICE_TEMP" <<EOF
id: '${CONNECTION_ID}'
url: ${APPLICATION_SERVICE_URL}
as_token: '${AS_TOKEN}'
hs_token: '${HS_TOKEN}'
sender_localpart: _delegate_as
rate_limited: false
receive_ephemeral: false
inhibit_login: true
namespaces:
  users:
    - exclusive: true
      regex: '^@_delegate_.*:${ESCAPED_SERVER_NAME}$'
  aliases: []
  rooms: []
EOF
fi

if ! grep -Fq 'app_service_config_files:' "$HOMESERVER_FILE"; then
  cat >>"$HOMESERVER_FILE" <<'EOF'

# Delegate local Application Service. This runtime file is generated and is
# intentionally excluded from Git because the referenced registration has
# bearer tokens.
app_service_config_files:
  - /data/delegate-appservice.yaml
EOF
elif ! grep -Fq '/data/delegate-appservice.yaml' "$HOMESERVER_FILE"; then
  printf '%s\n' \
    'Existing app_service_config_files does not include Delegate registration.' \
    "Remove ${RUNTIME_ROOT} and run this command again." >&2
  exit 3
fi

if ! grep -Fq '# Delegate local test rate limits.' "$HOMESERVER_FILE"; then
  cat >>"$HOMESERVER_FILE" <<'EOF'

# Delegate local test rate limits. The smoke gate intentionally performs
# repeated idempotency logins and registrations; production must use Synapse
# defaults or an independently reviewed policy.
rc_login:
  address:
    per_second: 100
    burst_count: 100
  account:
    per_second: 100
    burst_count: 100
  failed_attempts:
    per_second: 100
    burst_count: 100
rc_registration:
  per_second: 100
  burst_count: 100
EOF
fi

cat >"$ENV_TEMP" <<EOF
MATRIX_SYNAPSE_IMAGE=${SYNAPSE_IMAGE}
MATRIX_SYNAPSE_HOST_PORT=${HOST_PORT}
MATRIX_LOCAL_SERVER_NAME=${SERVER_NAME}
MATRIX_SERVER_NAME=${SERVER_NAME}
MATRIX_HOMESERVER_URL=${INTERNAL_HOMESERVER_URL}
MATRIX_LOCAL_HOMESERVER_URL=http://127.0.0.1:${HOST_PORT}
MATRIX_LOCAL_BRIDGE_URL=${LOCAL_BRIDGE_URL}
MATRIX_AS_CONNECTION_ID=${CONNECTION_ID}
MATRIX_AS_TOKEN=${AS_TOKEN}
MATRIX_AS_HS_TOKEN=${HS_TOKEN}
MATRIX_LOCAL_UID=${SYNAPSE_UID}
MATRIX_LOCAL_GID=${SYNAPSE_GID}
MATRIX_LOCAL_REGISTRATION_SHARED_SECRET_BASE64=${REGISTRATION_SHARED_SECRET_BASE64}
MATRIX_LOCAL_TEST_USERNAME=${TEST_USERNAME}
MATRIX_LOCAL_TEST_PASSWORD=${TEST_PASSWORD}
EOF

matrix_validate_env_file "$ENV_TEMP"
chmod 600 "$ENV_TEMP"
if [[ "$APP_SERVICE_FILE_EXISTS" == "false" ]]; then
  chmod 600 "$APP_SERVICE_TEMP"
fi
if [[ "$CURRENT_HOST_UID" == "0" \
  && "$APP_SERVICE_FILE_EXISTS" == "false" ]]; then
  chown "${SYNAPSE_UID}:${SYNAPSE_GID}" "$APP_SERVICE_TEMP"
fi
if [[ "$APP_SERVICE_FILE_EXISTS" == "false" ]]; then
  mv -f "$APP_SERVICE_TEMP" "$APP_SERVICE_FILE"
fi
mv -f "$ENV_TEMP" "$ENV_FILE"
trap - EXIT
printf 'result=matrix_local_config_ready env=%s\n' "$ENV_FILE"
