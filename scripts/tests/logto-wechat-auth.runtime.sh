#!/usr/bin/env bash
set -Eeuo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker run --rm --network none \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --entrypoint node svhd/logto:1.41.0 \
  --test /workspace/scripts/tests/logto-wechat-auth.runtime.mjs
