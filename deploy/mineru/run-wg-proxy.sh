#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${MINERU_IMAGE:-delegate-mineru:3.4.5-cu130}"
CONTAINER="${MINERU_WG_PROXY_CONTAINER:-delegate-mineru-wg-proxy}"
LISTEN_HOST="${MINERU_WG_LISTEN_HOST:-10.77.0.2}"
LISTEN_PORT="${MINERU_WG_LISTEN_PORT:-8000}"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "$CONTAINER already exists; refusing to replace it implicitly." >&2
  exit 1
fi

docker run --detach \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --read-only \
  --user 65534:65534 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --cpus 0.25 \
  --memory 128m \
  --pids-limit 64 \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --env "MINERU_WG_LISTEN_HOST=$LISTEN_HOST" \
  --env "MINERU_WG_LISTEN_PORT=$LISTEN_PORT" \
  --health-cmd "python3 /proxy.py --check" \
  --health-interval 15s \
  --health-timeout 5s \
  --health-retries 4 \
  --health-start-period 10s \
  --entrypoint python3 \
  --mount "type=bind,src=$SCRIPT_DIR/wg-proxy.py,dst=/proxy.py,readonly" \
  "$IMAGE" -u /proxy.py
