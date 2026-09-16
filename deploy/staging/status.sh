#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_HOST="${1:-8170-server}"

ssh "$REMOTE_HOST" '
  echo STACK
  docker stack services delegate
  echo TASK_FAILURES
  docker stack ps delegate --no-trunc --filter desired-state=shutdown \
    --format "{{.Name}} {{.CurrentState}} {{.Error}}" | sed -n "1,80p"
  echo PUBLIC_HEALTH
  for url in \
    https://home.rag8.cn \
    https://dashboard.rag8.cn/health \
    https://delegate.rag8.cn/health \
    https://delegate.rag8.cn/ready \
    https://login.rag8.cn/oidc/.well-known/openid-configuration \
    https://delegate-matrix.rag8.cn/_matrix/client/versions \
    https://delegate-api.rag8.cn/health; do
    printf "%s " "$url"
    curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 5 --max-time 15 "$url" || true
  done
'
