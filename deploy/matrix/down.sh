#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SCOPE="${1:-matrix}"

# Stop/recovery commands must remain usable even when a generated env file is
# missing or damaged. Do not interpolate caller-provided Matrix credentials.
unset MATRIX_SYNAPSE_IMAGE MATRIX_SYNAPSE_HOST_PORT MATRIX_SERVER_NAME
unset MATRIX_HOMESERVER_URL MATRIX_AS_CONNECTION_ID MATRIX_AS_TOKEN
unset MATRIX_AS_HS_TOKEN MATRIX_LOCAL_UID MATRIX_LOCAL_GID

cd "$REPO_ROOT"
case "$SCOPE" in
  matrix)
    exec docker compose \
      -f compose.yml \
      -f compose.local.yml \
      -f compose.matrix.yml \
      --profile matrix \
      --profile matrix-e2e \
      rm -sf \
      synapse matrix-e2e-synapse matrix-bridge matrix-e2e-bridge \
      matrix-e2e-migrate matrix-e2e-db-init
    ;;
  all)
    exec docker compose \
      -f compose.yml \
      -f compose.local.yml \
      -f compose.matrix.yml \
      --profile matrix \
      --profile matrix-e2e \
      --profile temporal \
      down
    ;;
  *)
    printf 'Usage: %s [matrix|all]\n' "$0" >&2
    exit 2
    ;;
esac
