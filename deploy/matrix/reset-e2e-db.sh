#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "$REPO_ROOT"

docker compose \
  -f compose.yml \
  -f compose.local.yml \
  -f compose.matrix.yml \
  --profile matrix \
  --profile matrix-e2e \
  rm -sf matrix-e2e-bridge matrix-e2e-migrate matrix-e2e-db-init

docker compose \
  -f compose.yml \
  -f compose.local.yml \
  up -d --wait postgres

docker compose \
  -f compose.yml \
  -f compose.local.yml \
  exec -T postgres \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'delegate_matrix_e2e' AND pid <> pg_backend_pid()"

docker compose \
  -f compose.yml \
  -f compose.local.yml \
  exec -T postgres \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS delegate_matrix_e2e"

printf 'result=matrix_local_e2e_database_reset database=delegate_matrix_e2e\n'
