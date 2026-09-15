#!/usr/bin/env bash
set -euo pipefail

IMAGE="delegate-mineru:3.4.5-cu130"
CONTAINER="delegate-mineru-api"
NETWORK="delegate-mineru"
OUTPUT_VOLUME="delegate-mineru-output"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "$CONTAINER already exists; refusing to replace it implicitly." >&2
  exit 1
fi

docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || docker network create --driver bridge "$NETWORK" >/dev/null
docker volume inspect "$OUTPUT_VOLUME" >/dev/null 2>&1 \
  || docker volume create "$OUTPUT_VOLUME" >/dev/null

docker run --detach \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --gpus device=1 \
  --restart unless-stopped \
  --cpus 16 \
  --memory 64g \
  --pids-limit 4096 \
  --shm-size 32g \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=$OUTPUT_VOLUME,dst=/srv/mineru/output" \
  --publish 127.0.0.1:8000:8000 \
  --env MINERU_MODEL_SOURCE=local \
  --env MINERU_API_MAX_CONCURRENT_REQUESTS=1 \
  "$IMAGE"
