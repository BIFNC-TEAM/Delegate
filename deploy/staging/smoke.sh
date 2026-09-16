#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_HOST="${1:-8170-server}"

ssh "$REMOTE_HOST" '
  set -eu
  node /home/ubuntu/delegate/current/deploy/staging/validate-auth-apps.mjs \
    /home/ubuntu/delegate/shared/env/auth-apps.env
  node /home/ubuntu/delegate/current/deploy/staging/verify-logto-management.mjs \
    /home/ubuntu/delegate/shared/env/auth-apps.env \
    https://login.rag8.cn
  check() {
    url="$1"
    expected="$2"
    code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 20 "$url")"
    printf "%s %s\n" "$code" "$url"
    test "$code" = "$expected"
  }
  check https://home.rag8.cn 200
  check https://dashboard.rag8.cn/health 200
  check "https://dashboard.rag8.cn/auth/login?flow=sign_in&returnTo=%2Fdashboard" 307
  check https://delegate.rag8.cn/health 200
  check https://delegate.rag8.cn/ready 200
  check "https://delegate.rag8.cn/reps/lin-founder-rep/auth/login?returnTo=%2Freps%2Flin-founder-rep" 307
  check https://login.rag8.cn/oidc/.well-known/openid-configuration 200
  check https://delegate-matrix.rag8.cn/_matrix/client/versions 200
  check https://delegate-api.rag8.cn/health 200
  check https://delegate-pay.rag8.cn/ 404
'
