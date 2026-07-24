#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_CONTAINER="delegate-channel-platform-pg16-$$"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 channel fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the PostgreSQL 16 channel fixture.\n' >&2
  exit 2
}

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=channel_platform_fixture_only \
  --env POSTGRES_DB=delegate_channel_test \
  --publish 127.0.0.1::5432 \
  --health-cmd='pg_isready -U postgres -d delegate_channel_test' \
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
FIXTURE_DATABASE_URL="postgresql://postgres:channel_platform_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_channel_test"

printf 'phase=deploy_all_migrations\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$REPO_ROOT/prisma/schema.prisma" >/dev/null

printf 'phase=run_channel_platform_postgres_closure\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
NODE_ENV=test \
DELEGATE_CHANNEL_POSTGRES_E2E=1 \
  pnpm --dir "$REPO_ROOT" exec vitest run \
  scripts/tests/channel-platform.postgres.test.ts
