#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
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
for argument in "$@"; do
  case "$argument" in
    config | down | events | exec | kill | logs | pause | port | ps | rm | stop | top | unpause)
      NEEDS_BOOTSTRAP="false"
      break
      ;;
  esac
done
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
if [[ -f "$ENV_FILE" ]]; then
  exec docker compose \
    --env-file "$ENV_FILE" \
    -f compose.yml \
    -f compose.local.yml \
    -f compose.matrix.yml \
    --profile "$MATRIX_PROFILE" \
    "$@"
else
  exec docker compose \
    -f compose.yml \
    -f compose.local.yml \
    -f compose.matrix.yml \
    --profile "$MATRIX_PROFILE" \
    "$@"
fi
