#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the offline channel test gate.\n' >&2
  exit 2
}

# Keep developer-machine credentials and service endpoints out of this gate.
# Empty exported values also prevent dotenv from restoring values from .env.
export NODE_ENV="test"
export CI="1"
export DATABASE_URL=""
export DELEGATE_POSTGRES_E2E="0"
export DELEGATE_POSTGRES_E2E_ALLOW_REMOTE="0"

export KNOWLEDGE_OBJECT_STORE_ENDPOINT=""
export KNOWLEDGE_OBJECT_STORE_BUCKET=""
export KNOWLEDGE_OBJECT_STORE_REGION=""
export KNOWLEDGE_OBJECT_STORE_ACCESS_KEY=""
export KNOWLEDGE_OBJECT_STORE_SECRET_KEY=""
export ARTIFACT_STORE_ENDPOINT=""
export ARTIFACT_STORE_BUCKET=""
export ARTIFACT_STORE_REGION=""
export ARTIFACT_STORE_ACCESS_KEY=""
export ARTIFACT_STORE_SECRET_KEY=""
export TENCENTCLOUD_SECRET_ID=""
export TENCENTCLOUD_SECRET_KEY=""
export COS_SECRET_ID=""
export COS_SECRET_KEY=""
export AWS_ACCESS_KEY_ID=""
export AWS_SECRET_ACCESS_KEY=""
export AWS_SESSION_TOKEN=""
export AWS_PROFILE=""
export AWS_EC2_METADATA_DISABLED="true"

export OPENVIKING_ENABLED="false"
export OPENVIKING_RESOURCE_SYNC_ENABLED="false"
export OPENVIKING_BASE_URL="http://127.0.0.1:1"
export OPENVIKING_INTERNAL_BASE_URL="http://127.0.0.1:1"
export OPENVIKING_CONSOLE_URL="http://127.0.0.1:1"
export OPENVIKING_API_KEY=""
export OPENVIKING_ROOT_API_KEY=""
export OPENVIKING_MODEL_API_KEY=""

export DELEGATE_MODEL_ENABLED="false"
export COMPUTE_NATIVE_OPENAI_ENABLED="false"
export COMPUTE_NATIVE_ANTHROPIC_ENABLED="false"
export OPENAI_API_KEY=""
export ANTHROPIC_API_KEY=""
export ARK_API_KEY=""
export DELEGATE_BAILIAN_API_KEY=""

export MATRIX_HOMESERVER_URL=""
export MATRIX_AS_TOKEN=""
export MATRIX_AS_HS_TOKEN=""
export TELEGRAM_BOT_TOKEN=""
export TELEGRAM_WEBHOOK_SECRET=""
export WORKFLOW_ENGINE="local_runner"

printf 'phase=channel_tests_matrix_local_env\n'
bash "${SCRIPT_DIR}/matrix-local-env.test.sh"

printf 'phase=channel_tests_dashboard\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/dashboard test

printf 'phase=channel_tests_reps\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/reps test

printf 'phase=channel_tests_bot\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/bot exec vitest run tests

printf 'phase=channel_tests_matrix_bridge\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/matrix-bridge test

printf 'phase=channel_tests_conversation_worker\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/conversation-worker test

printf 'phase=channel_tests_web_data\n'
pnpm --dir "$REPO_ROOT" --filter @delegate/web-data test

printf 'phase=channel_typecheck\n'
pnpm --dir "$REPO_ROOT" \
  --filter @delegate/dashboard \
  --filter @delegate/reps \
  --filter @delegate/bot \
  --filter @delegate/matrix-bridge \
  --filter @delegate/conversation-worker \
  --filter @delegate/web-data \
  typecheck

printf 'phase=channel_db_validate\n'
DATABASE_URL="postgresql://delegate:delegate@127.0.0.1:1/delegate" \
  pnpm --dir "$REPO_ROOT" db:validate

printf 'result=channel_offline_gate_passed\n'
