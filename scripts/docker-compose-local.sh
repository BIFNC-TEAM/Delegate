#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

compose_env_args=(--env-file .env)
if [[ -f .env.wechat.local ]]; then
  compose_env_args+=(--env-file .env.wechat.local)
fi

exec docker compose \
  "${compose_env_args[@]}" \
  -f compose.yml \
  -f compose.local.yml \
  "$@"
