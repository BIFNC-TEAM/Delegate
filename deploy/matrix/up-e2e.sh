#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${SCRIPT_DIR}/compose.sh"

matrix_e2e_compose() {
  MATRIX_LOCAL_INSTANCE=e2e bash "$COMPOSE" "$@"
}

printf 'phase=start_matrix_dependencies\n'
matrix_e2e_compose up -d --wait postgres matrix-e2e-synapse

printf 'phase=create_matrix_e2e_database\n'
matrix_e2e_compose run --rm --no-deps \
  matrix-e2e-db-init

printf 'phase=build_matrix_e2e_services\n'
matrix_e2e_compose build \
  matrix-e2e-migrate

printf 'phase=migrate_and_seed_matrix_e2e_database\n'
matrix_e2e_compose run --rm --no-deps \
  matrix-e2e-migrate

printf 'phase=start_matrix_e2e_bridge\n'
matrix_e2e_compose up -d --no-deps --wait \
  matrix-e2e-bridge
