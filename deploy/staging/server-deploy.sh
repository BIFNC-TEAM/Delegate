#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEPLOY_ROOT="${DELEGATE_DEPLOY_ROOT:-/home/ubuntu/delegate}"
STATE_ROOT="${DELEGATE_STATE_ROOT:-${DEPLOY_ROOT}/shared}"
ENV_ROOT="${DELEGATE_ENV_ROOT:-${STATE_ROOT}/env}"
RELEASE_ID="${DELEGATE_RELEASE_ID:-$(basename "$REPO_ROOT")}"
STACK_NAME="${DELEGATE_STACK_NAME:-delegate}"
STACK_FILE="${SCRIPT_DIR}/stack.yml"

export DELEGATE_ENV_ROOT="$ENV_ROOT"
export DELEGATE_NODE_HOSTNAME="${DELEGATE_NODE_HOSTNAME:-$(hostname)}"
export DELEGATE_APP_IMAGE="delegate-app:${RELEASE_ID}"
export DELEGATE_OPENVIKING_IMAGE="delegate-openviking:${RELEASE_ID}"

require_file() {
  [[ -f "$1" ]] || {
    echo "Required deployment file is missing: $1" >&2
    exit 2
  }
}

for file in \
  "$STACK_FILE" \
  "$ENV_ROOT/state.env" \
  "$ENV_ROOT/routing.env" \
  "$ENV_ROOT/postgres.env" \
  "$ENV_ROOT/logto-postgres.env" \
  "$ENV_ROOT/app.env"; do
  require_file "$file"
done

set -a
# Generated values contain only JSON-quoted dotenv values.
source "$ENV_ROOT/state.env"
source "$ENV_ROOT/routing.env"
set +a

mkdir -p "$DEPLOY_ROOT/workspaces" "$STATE_ROOT/backups" "$STATE_ROOT/logto" "$STATE_ROOT/matrix"
chmod 700 "$DEPLOY_ROOT/workspaces" "$STATE_ROOT" "$STATE_ROOT/backups" "$STATE_ROOT/logto" "$STATE_ROOT/matrix"

if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" != "active" ]]; then
  # Some Docker 28 builds report `error` in docker info while node ls remains
  # authoritative and healthy. Require a Ready local manager before continuing.
  docker node inspect self --format '{{.Status.State}} {{.ManagerStatus.Leader}}' \
    | grep -Eq '^ready (true|false)$' || {
      echo "Docker Swarm manager is not ready." >&2
      exit 3
    }
fi

docker network inspect traefik-public >/dev/null 2>&1 || {
  echo "Required existing Traefik network traefik-public is missing." >&2
  exit 3
}

if ! docker network inspect delegate-internal >/dev/null 2>&1; then
  docker network create --driver overlay --attachable delegate-internal >/dev/null
fi

images=(
  postgres:16-alpine
  postgres:17-alpine
  minio/minio:latest
  minio/mc:latest
  svhd/logto:1.41.0
  temporalio/auto-setup:latest
  temporalio/ui:latest
  temporalio/admin-tools:latest
  matrixdotorg/synapse:v1.157.0
  debian:bookworm-slim
)

echo "Pulling runtime images."
for image in "${images[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "Using cached runtime image $image."
  else
    docker pull "$image"
  fi
done

if [[ "${SKIP_BROWSER_IMAGE_PULL:-0}" != "1" ]]; then
  if ! timeout 600 docker pull mcr.microsoft.com/playwright:v1.58.2-noble; then
    echo "Playwright image pull did not finish within 10 minutes; continuing core deployment." >&2
  fi
fi

if ! docker image inspect "$DELEGATE_APP_IMAGE" >/dev/null 2>&1 \
  || [[ "${FORCE_BUILD:-0}" == "1" ]] \
  || [[ "${FORCE_APP_BUILD:-0}" == "1" ]]; then
  echo "Building $DELEGATE_APP_IMAGE."
  docker build --pull=false \
    --build-arg DEBIAN_MIRROR=http://mirrors.cloud.tencent.com \
    --tag "$DELEGATE_APP_IMAGE" --file "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
fi

if ! docker image inspect "$DELEGATE_OPENVIKING_IMAGE" >/dev/null 2>&1 \
  || [[ "${FORCE_BUILD:-0}" == "1" ]] \
  || [[ "${FORCE_OPENVIKING_BUILD:-0}" == "1" ]]; then
  echo "Building $DELEGATE_OPENVIKING_IMAGE."
  openviking_base="ghcr.io/volcengine/openviking:v0.4.12@sha256:0d99361a0029ce5221fd11588d9f0f374c6e5f8f1eacbcf1d76de6a0f6cd82cb"
  if docker image inspect delegate-openviking-base:v0.4.12 >/dev/null 2>&1; then
    openviking_base="delegate-openviking-base:v0.4.12"
  fi
  docker build --pull=false --tag "$DELEGATE_OPENVIKING_IMAGE" \
    --build-arg "OPENVIKING_BASE_IMAGE=$openviking_base" \
    --file "$REPO_ROOT/deploy/openviking/Dockerfile" "$REPO_ROOT"
fi

DELEGATE_STATE_ROOT="$STATE_ROOT" DELEGATE_ENV_ROOT="$ENV_ROOT" \
  bash "$SCRIPT_DIR/bootstrap-synapse.sh"

echo "Validating Swarm stack configuration."
node --test \
  "$SCRIPT_DIR/tests/stack-contract.test.mjs" \
  "$SCRIPT_DIR/tests/validate-auth-apps.test.mjs"
APP_REPLICAS=0 CONTROL_REPLICAS=0 docker stack config --compose-file "$STACK_FILE" >/dev/null

echo "Deploying isolated data services."
APP_REPLICAS=0 CONTROL_REPLICAS=0 docker stack deploy \
  --compose-file "$STACK_FILE" \
  --resolve-image never \
  "$STACK_NAME"

wait_for_postgres() {
  local host="$1"
  local database="$2"
  local user="$3"
  local env_file="$4"
  local attempt
  for attempt in $(seq 1 60); do
    if docker run --rm --network delegate-internal --env-file "$env_file" \
      postgres:16-alpine pg_isready -h "$host" -U "$user" -d "$database" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for PostgreSQL service $host." >&2
  return 1
}

wait_for_postgres postgres delegate delegate "$ENV_ROOT/postgres.env"
wait_for_postgres logto-postgres logto logto "$ENV_ROOT/logto-postgres.env"

echo "Creating private object-store buckets."
docker run --rm --network delegate-internal \
  --env-file "$ENV_ROOT/artifact-store.env" \
  --entrypoint /bin/sh \
  minio/mc:latest -c '
    until mc alias set delegate http://artifact-store:9000 "$ARTIFACT_STORE_ACCESS_KEY" "$ARTIFACT_STORE_SECRET_KEY" >/dev/null 2>&1; do sleep 2; done
    mc mb --ignore-existing delegate/delegate-compute-artifacts >/dev/null
    mc anonymous set none delegate/delegate-compute-artifacts >/dev/null 2>&1 || true
    mc mb --ignore-existing delegate/delegate-knowledge >/dev/null
    mc anonymous set none delegate/delegate-knowledge >/dev/null 2>&1 || true
  '

echo "Creating Temporal database when absent."
if ! docker run --rm --network delegate-internal --env-file "$ENV_ROOT/postgres.env" \
  postgres:16-alpine psql -h postgres -U delegate -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'delegate_temporal'" | grep -q 1; then
  docker run --rm --network delegate-internal --env-file "$ENV_ROOT/postgres.env" \
    postgres:16-alpine psql -h postgres -U delegate -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE DATABASE delegate_temporal'
fi

if [[ ! -f "$STATE_ROOT/logto/.seeded-v1.41.0" ]]; then
  echo "Seeding fresh Logto database."
  docker run --rm --network delegate-internal --env-file "$ENV_ROOT/logto.env" \
    --entrypoint npm \
    svhd/logto:1.41.0 run cli db seed -- --swe
  touch "$STATE_ROOT/logto/.seeded-v1.41.0"
  chmod 600 "$STATE_ROOT/logto/.seeded-v1.41.0"
fi

echo "Applying Delegate database migrations and idempotent seed."
docker run --rm --network delegate-internal \
  --env-file "$ENV_ROOT/app.env" \
  "$DELEGATE_APP_IMAGE" sh -lc 'pnpm db:deploy && pnpm db:seed'

echo "Starting the complete service set."
APP_REPLICAS=1 CONTROL_REPLICAS=1 docker stack deploy \
  --compose-file "$STACK_FILE" \
  --resolve-image never \
  "$STACK_NAME"

wait_for_service() {
  local service="$1"
  local attempt
  local current_state
  local replicas
  local update_state
  for attempt in $(seq 1 90); do
    replicas="$(docker service ls --filter "name=${service}" --format '{{.Replicas}}' | head -n 1)"
    current_state="$(docker service ps "$service" --filter desired-state=running \
      --format '{{.CurrentState}}' | head -n 1)"
    update_state="$(docker service inspect "$service" \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}')"
    if [[ "$replicas" == "1/1" \
      && "$current_state" == Running* \
      && "$update_state" == "completed" ]]; then
      return 0
    fi
    sleep 4
  done
  echo "Service did not reach 1/1: $service" >&2
  docker service inspect "$service" \
    --format 'update={{if .UpdateStatus}}{{.UpdateStatus.State}} {{.UpdateStatus.Message}}{{else}}none{{end}}' \
    >&2 || true
  docker service ps "$service" --no-trunc || true
  return 1
}

services=(
  "${STACK_NAME}_postgres"
  "${STACK_NAME}_artifact-store"
  "${STACK_NAME}_logto-postgres"
  "${STACK_NAME}_openviking"
  "${STACK_NAME}_logto"
  "${STACK_NAME}_temporal"
  "${STACK_NAME}_temporal-ui"
  "${STACK_NAME}_synapse"
  "${STACK_NAME}_site"
  "${STACK_NAME}_dashboard"
  "${STACK_NAME}_reps"
  "${STACK_NAME}_compute-broker"
  "${STACK_NAME}_workflow-runner"
  "${STACK_NAME}_conversation-worker"
  "${STACK_NAME}_matrix-bridge"
  "${STACK_NAME}_bot"
)

wait_for_service "${STACK_NAME}_temporal"

echo "Ensuring the Temporal namespace exists."
for attempt in $(seq 1 30); do
  if docker run --rm --network delegate-internal \
    --env TEMPORAL_ADDRESS=temporal:7233 \
    --entrypoint sh \
    temporalio/admin-tools:latest -lc \
    'temporal operator namespace describe -n delegate >/dev/null 2>&1 || temporal operator namespace create -n delegate' \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    echo "Temporal namespace initialization failed." >&2
    exit 4
  fi
  sleep 5
done

for service in "${services[@]}"; do
  wait_for_service "$service"
done

backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$STATE_ROOT/backups/$backup_stamp"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
docker run --rm --network delegate-internal \
  --env-file "$ENV_ROOT/postgres.env" \
  --user "$(id -u):$(id -g)" \
  --volume "$backup_dir:/backup" \
  postgres:16-alpine pg_dump -h postgres -U delegate -d delegate -Fc \
  -f /backup/delegate.dump
docker run --rm --network delegate-internal \
  --env-file "$ENV_ROOT/logto-postgres.env" \
  --user "$(id -u):$(id -g)" \
  --volume "$backup_dir:/backup" \
  postgres:17-alpine pg_dump -h logto-postgres -U logto -d logto -Fc \
  -f /backup/logto.dump
chmod 600 "$backup_dir"/*.dump

ln -sfn "$REPO_ROOT" "$DEPLOY_ROOT/current"

echo "Deployment completed for release $RELEASE_ID."
docker stack services "$STACK_NAME"
