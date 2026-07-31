#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"

if [[ $# -eq 0 ]]; then
  printf 'Usage: %s <docker compose arguments>\n' "$0" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || {
  printf 'Docker Compose is required for the local Logto stack.\n' >&2
  exit 2
}

CONFIG_COMMAND="false"
CONFIG_NO_INTERPOLATE="false"
for argument in "$@"; do
  case "$argument" in
    config | convert)
      CONFIG_COMMAND="true"
      ;;
    --no-interpolate)
      CONFIG_NO_INTERPOLATE="true"
      ;;
    --environment)
      printf 'Logto Compose refuses config --environment because it exposes secrets.\n' >&2
      exit 2
      ;;
  esac
done

# Ignore the caller's LOGTO_OSS_* values. The generated, validated local file
# is authoritative; config preview may use the safe Compose defaults.
logto_unset_runtime_env
ENV_ARGS=(--env-file /dev/null)
if [[ -f "$ENV_FILE" ]]; then
  logto_load_env "$ENV_FILE"
  ENV_ARGS=(--env-file "$ENV_FILE")
elif [[ "$CONFIG_COMMAND" != "true" ]]; then
  printf '%s\n' \
    "Logto local environment is missing: ${ENV_FILE}" \
    "Run: pnpm logto:local:bootstrap" >&2
  exit 2
fi

COMPOSE_COMMAND_ARGS=("$@")
if [[ "$CONFIG_COMMAND" == "true" && "$CONFIG_NO_INTERPOLATE" == "false" ]]; then
  # A rendered config includes DB_URL and the Secret Vault KEK. Keep previews
  # useful without expanding generated local credentials.
  COMPOSE_COMMAND_ARGS+=(--no-interpolate)
fi

cd "$REPO_ROOT"
exec docker compose \
  "${ENV_ARGS[@]}" \
  -f compose.logto.yml \
  --profile seed \
  --profile alteration \
  "${COMPOSE_COMMAND_ARGS[@]}"
