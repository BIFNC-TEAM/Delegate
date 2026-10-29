#!/usr/bin/env bash
# Only a disposable local database; never reads the application DATABASE_URL.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_CONTAINER="delegate-agent-v2-cutover-$$"
FIXTURE_STARTED=false
cleanup() {
  if [[ "$FIXTURE_STARTED" == true ]]; then docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker run --rm --detach --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=agent_v2_fixture_only --env POSTGRES_DB=delegate_agent_v2_test \
  --publish 127.0.0.1::5432 --health-cmd='pg_isready -U postgres -d delegate_agent_v2_test' \
  --health-interval=1s --health-timeout=2s --health-retries=30 postgres:16-alpine >/dev/null
FIXTURE_STARTED=true
FIXTURE_READY=false
for _ in {1..35}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$FIXTURE_CONTAINER")" == healthy ]]; then FIXTURE_READY=true; break; fi
  sleep 1
done
if [[ "$FIXTURE_READY" != true ]]; then docker logs "$FIXTURE_CONTAINER"; exit 3; fi
FIXTURE_PORT="$(docker port "$FIXTURE_CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
export DATABASE_URL="postgresql://postgres:agent_v2_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_agent_v2_test"
export COMPUTE_BROKER_INTERNAL_TOKEN=agent_v2_fixture_broker_token_only
export DELEGATE_POSTGRES_E2E=1
export DELEGATE_RUN_CLOUD_BOUNDARY_PROBE=0
pnpm --dir "$REPO_ROOT" db:deploy >/dev/null
pnpm --dir "$REPO_ROOT/packages/web-data" exec vitest run --no-file-parallelism \
  tests/postgres-agent-context-authorization.integration.test.ts \
  tests/postgres-isolated-python.integration.test.ts
