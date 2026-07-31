#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "${SCRIPT_DIR}/bootstrap.sh"
bash "${SCRIPT_DIR}/preflight.sh"
bash "${SCRIPT_DIR}/compose.sh" up -d --wait --wait-timeout 90 \
  logto-postgres logto
bash "${SCRIPT_DIR}/smoke.sh"
