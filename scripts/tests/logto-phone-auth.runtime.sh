#!/usr/bin/env bash
set -Eeuo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker run --rm --network none \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --mount "type=bind,source=$REPO_ROOT/deploy/logto/connectors/connector-tencent-sms-cn,target=/etc/logto/packages/core/connectors/@delegate-connector-tencent-sms-cn,readonly" \
  --entrypoint node svhd/logto:1.41.0 \
  --test /workspace/scripts/tests/logto-phone-auth.runtime.mjs
