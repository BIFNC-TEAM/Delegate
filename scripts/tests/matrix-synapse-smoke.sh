#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE="${REPO_ROOT}/deploy/matrix/compose.sh"
ENV_FILE="${REPO_ROOT}/.local/matrix-e2e/matrix.env"
UP_E2E="${REPO_ROOT}/deploy/matrix/up-e2e.sh"

# shellcheck source=deploy/matrix/env.sh
source "${REPO_ROOT}/deploy/matrix/env.sh"

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the local Matrix protocol smoke test.\n' >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  printf 'Node.js is required for the local Matrix protocol smoke test.\n' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  printf 'curl is required for the local Matrix protocol smoke test.\n' >&2
  exit 2
}

MATRIX_LOCAL_INSTANCE=e2e \
  bash "${REPO_ROOT}/deploy/matrix/bootstrap.sh"
matrix_load_env "$ENV_FILE"

if [[ "${MATRIX_LOCAL_SMOKE_START_STACK:-true}" == "true" ]]; then
  printf 'phase=start_isolated_matrix_e2e_stack\n'
  bash "$UP_E2E"
fi

printf 'phase=wait_for_matrix_services\n'
READY="false"
for _ in {1..90}; do
  if curl --fail --silent --connect-timeout 2 --max-time 5 \
    "${MATRIX_LOCAL_HOMESERVER_URL}/_matrix/client/versions" >/dev/null \
    && curl --fail --silent --connect-timeout 2 --max-time 5 \
      "${MATRIX_LOCAL_BRIDGE_URL:-http://127.0.0.1:4030}/ready" >/dev/null; then
    READY="true"
    break
  fi
  sleep 2
done
if [[ "$READY" != "true" ]]; then
  MATRIX_LOCAL_INSTANCE=e2e bash "$COMPOSE" ps
  MATRIX_LOCAL_INSTANCE=e2e \
    bash "$COMPOSE" logs --tail=200 matrix-e2e-synapse matrix-e2e-bridge
  exit 3
fi

printf 'phase=create_matrix_test_user\n'
MATRIX_LOCAL_INSTANCE=e2e \
  node "${REPO_ROOT}/scripts/matrix-local-create-user.mjs"

printf 'phase=run_matrix_protocol_smoke\n'
MATRIX_LOCAL_INSTANCE=e2e \
  node "${REPO_ROOT}/scripts/tests/matrix-synapse-smoke.mjs"

printf 'phase=run_delegate_matrix_synapse_e2e\n'
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/delegate_matrix_e2e" \
NODE_ENV=test \
DELEGATE_MODEL_ENABLED=false \
  pnpm --dir "$REPO_ROOT" exec tsx \
  scripts/tests/matrix-synapse-delegate.e2e.ts
