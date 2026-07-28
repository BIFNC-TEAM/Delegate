#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ACTION="${1:-ps}"

unset MATRIX_SYNAPSE_IMAGE MATRIX_SYNAPSE_HOST_PORT MATRIX_SERVER_NAME
unset MATRIX_HOMESERVER_URL MATRIX_AS_CONNECTION_ID MATRIX_AS_TOKEN
unset MATRIX_AS_HS_TOKEN MATRIX_LOCAL_UID MATRIX_LOCAL_GID

cd "$REPO_ROOT"
case "$ACTION" in
  ps)
    exec docker compose \
      -f compose.yml \
      -f compose.local.yml \
      -f compose.matrix.yml \
      --profile matrix \
      --profile matrix-e2e \
      ps synapse matrix-e2e-synapse matrix-bridge matrix-e2e-bridge
    ;;
  logs)
    exec docker compose \
      -f compose.yml \
      -f compose.local.yml \
      -f compose.matrix.yml \
      --profile matrix \
      --profile matrix-e2e \
      logs -f synapse matrix-e2e-synapse matrix-bridge matrix-e2e-bridge
    ;;
  *)
    printf 'Usage: %s [ps|logs]\n' "$0" >&2
    exit 2
    ;;
esac
