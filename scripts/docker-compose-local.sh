#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The Compute Broker talks to the host Docker daemon, so its bind-mount source
# must be the host repository path rather than a path baked into an image or
# copied from another developer's machine. Shell environment takes precedence
# over values loaded from .env during Compose interpolation.
export COMPUTE_HOST_WORKSPACE_ROOT="${COMPUTE_HOST_WORKSPACE_ROOT:-${PROJECT_ROOT}}"

cd "${PROJECT_ROOT}"

compose_env_args=(--env-file .env)
if [[ -f .env.wechat.local ]]; then
  compose_env_args+=(--env-file .env.wechat.local)
fi
if [[ -f .local/logto/delegate-auth.env ]]; then
  compose_env_args+=(--env-file .local/logto/delegate-auth.env)
fi

exec docker compose \
  "${compose_env_args[@]}" \
  -f compose.yml \
  -f compose.local.yml \
  "$@"
