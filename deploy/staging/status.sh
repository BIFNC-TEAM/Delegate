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
    https://www.bonary.xyz \
    https://dashboard.bonary.xyz/health \
    https://delegate.bonary.xyz/health \
    https://delegate.bonary.xyz/ready \
    https://login.bonary.xyz/oidc/.well-known/openid-configuration \
    https://matrix.bonary.xyz/_matrix/client/versions \
    https://api.bonary.xyz/health; do
    printf "%s " "$url"
    curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 5 --max-time 15 "$url" || true
  done
'
