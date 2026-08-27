#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_HOST="${1:-8170-server}"

ssh "$REMOTE_HOST" '
  set -eu
  node /home/ubuntu/delegate/current/deploy/staging/validate-auth-apps.mjs \
    /home/ubuntu/delegate/shared/env/auth-apps.env
  node /home/ubuntu/delegate/current/deploy/staging/verify-logto-management.mjs \
    /home/ubuntu/delegate/shared/env/auth-apps.env \
    https://login.bonary.xyz
  check() {
    url="$1"
    expected="$2"
    code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 20 "$url")"
    printf "%s %s\n" "$code" "$url"
    test "$code" = "$expected"
  }
  check https://www.bonary.xyz 200
  check https://dashboard.bonary.xyz/health 200
  check "https://dashboard.bonary.xyz/auth/login?flow=sign_in&returnTo=%2Fdashboard" 307
  check https://delegate.bonary.xyz/health 200
  check https://delegate.bonary.xyz/ready 200
  check "https://delegate.bonary.xyz/reps/lin-founder-rep/auth/login?returnTo=%2Freps%2Flin-founder-rep" 307
  check https://login.bonary.xyz/oidc/.well-known/openid-configuration 200
  check https://matrix.bonary.xyz/_matrix/client/versions 200
  check https://api.bonary.xyz/health 200
  check https://pay.bonary.xyz/ 404
'
