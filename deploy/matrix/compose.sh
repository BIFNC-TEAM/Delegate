#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ROOT_ENV_FILE="${REPO_ROOT}/.env"
MATRIX_LOCAL_INSTANCE="${MATRIX_LOCAL_INSTANCE:-normal}"
case "$MATRIX_LOCAL_INSTANCE" in
  normal)
    ENV_FILE="${REPO_ROOT}/.local/matrix/matrix.env"
    MATRIX_PROFILE="matrix"
    ;;
  e2e)
    ENV_FILE="${REPO_ROOT}/.local/matrix-e2e/matrix.env"
    MATRIX_PROFILE="matrix-e2e"
    ;;
  *)
    printf 'MATRIX_LOCAL_INSTANCE must be normal or e2e.\n' >&2
    exit 2
    ;;
esac

# shellcheck source=deploy/matrix/env.sh
source "${SCRIPT_DIR}/env.sh"

if [[ $# -eq 0 ]]; then
  printf 'Usage: %s <docker compose arguments>\n' "$0" >&2
  exit 2
fi

NEEDS_BOOTSTRAP="true"
CONFIG_COMMAND="false"
CONFIG_NO_INTERPOLATE="false"
CONFIG_ENVIRONMENT_OUTPUT="false"
for argument in "$@"; do
  case "$argument" in
    config | convert)
      NEEDS_BOOTSTRAP="false"
      CONFIG_COMMAND="true"
      ;;
    --no-interpolate)
      CONFIG_NO_INTERPOLATE="true"
      ;;
    --environment)
      CONFIG_ENVIRONMENT_OUTPUT="true"
      ;;
    down | events | exec | kill | logs | pause | port | ps | rm | stop | top | unpause)
      NEEDS_BOOTSTRAP="false"
      ;;
  esac
done
if [[ "$CONFIG_COMMAND" == "true" && "$CONFIG_ENVIRONMENT_OUTPUT" == "true" ]]; then
  printf 'Matrix Compose refuses config --environment because it can expose credentials.\n' >&2
  exit 2
fi
if [[ "$NEEDS_BOOTSTRAP" == "true" ]]; then
  MATRIX_LOCAL_INSTANCE="$MATRIX_LOCAL_INSTANCE" \
    bash "${SCRIPT_DIR}/bootstrap.sh"
fi

if [[ -f "$ENV_FILE" ]]; then
  # Export the validated local values so they take precedence over any
  # production-shaped MATRIX_* variables inherited from the caller. Docker
  # Compose gives shell variables higher precedence than --env-file.
  matrix_load_env "$ENV_FILE"
fi

cd "$REPO_ROOT"
COMPOSE_ENV_ARGS=()
if [[ -f "$ROOT_ENV_FILE" ]]; then
  # Let Docker Compose parse the repository environment file. Do not source it:
  # unlike generated matrix.env, it is not constrained to a strict whitelist.
  COMPOSE_ENV_ARGS+=(--env-file "$ROOT_ENV_FILE")
fi
if [[ -f "$ENV_FILE" ]]; then
  # Compose applies repeated --env-file arguments in order, so generated local
  # Matrix values override any production-shaped MATRIX_* entries in .env.
  COMPOSE_ENV_ARGS+=(--env-file "$ENV_FILE")
fi

COMPOSE_COMMAND_ARGS=("$@")
if [[ "$CONFIG_COMMAND" == "true" && "$CONFIG_NO_INTERPOLATE" == "false" ]]; then
  # A rendered Compose config includes every service environment value. Keep
  # previews useful without expanding repository or generated Matrix secrets.
  COMPOSE_COMMAND_ARGS+=(--no-interpolate)
fi

exec docker compose \
  "${COMPOSE_ENV_ARGS[@]}" \
  -f compose.yml \
  -f compose.local.yml \
  -f compose.matrix.yml \
  --profile "$MATRIX_PROFILE" \
  "${COMPOSE_COMMAND_ARGS[@]}"
