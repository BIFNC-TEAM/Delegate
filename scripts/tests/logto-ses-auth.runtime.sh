#!/usr/bin/env bash
set -Eeuo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker run --rm --network none \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --mount "type=bind,source=$REPO_ROOT/deploy/logto/connectors/connector-tencent-ses,target=/etc/logto/packages/core/connectors/@delegate-connector-tencent-ses,readonly" \
  --entrypoint node svhd/logto:1.41.0 \
  --test /workspace/scripts/tests/logto-ses-auth.runtime.mjs
