#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_CONTAINER="delegate-owner-settings-pg16-$$"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 Owner Settings fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the PostgreSQL 16 Owner Settings fixture.\n' >&2
  exit 2
}

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=owner_settings_fixture_only \
  --env POSTGRES_DB=delegate_owner_settings_test \
  --publish 127.0.0.1::5432 \
  --health-cmd='pg_isready -U postgres -d delegate_owner_settings_test' \
  --health-interval=1s \
  --health-timeout=2s \
  --health-retries=30 \
  postgres:16-alpine >/dev/null
FIXTURE_CONTAINER_STARTED="true"

FIXTURE_READY="false"
for _ in {1..35}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$FIXTURE_CONTAINER")" == "healthy" ]]; then
    FIXTURE_READY="true"
    break
  fi
  sleep 1
done

if [[ "$FIXTURE_READY" != "true" ]]; then
  docker logs "$FIXTURE_CONTAINER"
  exit 3
fi

FIXTURE_PORT="$(
  docker port "$FIXTURE_CONTAINER" 5432/tcp |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
FIXTURE_DATABASE_URL="postgresql://postgres:owner_settings_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_owner_settings_test"

printf 'phase=deploy_all_migrations\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" db:deploy >/dev/null

printf 'phase=run_owner_settings_concurrency_gate\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  DELEGATE_AUTH_SESSION_SECRET=owner_settings_fixture_auth_secret \
  pnpm --dir "$REPO_ROOT" --filter @delegate/web-data test:postgres:owner-settings
