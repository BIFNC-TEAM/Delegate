#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_HOST="${1:-8170-server}"
DEPLOY_ROOT="${DELEGATE_DEPLOY_ROOT:-/home/ubuntu/delegate}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
RELEASE_ID="${DELEGATE_RELEASE_ID:-${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ)}"
REMOTE_RELEASE="${DEPLOY_ROOT}/releases/${RELEASE_ID}"
SOURCE_ENV="${REPO_ROOT}/.env"

[[ -f "$SOURCE_ENV" ]] || {
  echo "Local source environment is missing: $SOURCE_ENV" >&2
  exit 2
}

echo "Publishing release $RELEASE_ID to $REMOTE_HOST."
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_RELEASE' '$DEPLOY_ROOT/shared' '$DEPLOY_ROOT/releases' '$DEPLOY_ROOT/workspaces'"

rsync -az \
  --exclude='.git/' \
  --exclude='.gstack/' \
  --exclude='.turbo/' \
  --exclude='.local/' \
  --exclude='.pnpm-store/' \
  --exclude='node_modules/' \
  --exclude='**/node_modules/' \
  --exclude='.next/' \
  --exclude='**/.next/' \
  --exclude='coverage/' \
  --exclude='**/coverage/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='notes/' \
  "$REPO_ROOT/" "$REMOTE_HOST:$REMOTE_RELEASE/"

scp -q "$SOURCE_ENV" "$REMOTE_HOST:$DEPLOY_ROOT/shared/source.env.incoming"
ssh "$REMOTE_HOST" "umask 077; if test -f '$DEPLOY_ROOT/shared/source.env'; then cp -p '$DEPLOY_ROOT/shared/source.env' '$DEPLOY_ROOT/shared/source.env.previous-$RELEASE_ID'; fi; install -m 600 '$DEPLOY_ROOT/shared/source.env.incoming' '$DEPLOY_ROOT/shared/source.env'"

ssh "$REMOTE_HOST" "node '$REMOTE_RELEASE/deploy/staging/prepare-env.mjs' --source '$DEPLOY_ROOT/shared/source.env' --output '$DEPLOY_ROOT/shared/env'"

ssh "$REMOTE_HOST" "DELEGATE_RELEASE_ID='$RELEASE_ID' DELEGATE_DEPLOY_ROOT='$DEPLOY_ROOT' SKIP_BROWSER_IMAGE_PULL='${SKIP_BROWSER_IMAGE_PULL:-0}' FORCE_BUILD='${FORCE_BUILD:-0}' FORCE_APP_BUILD='${FORCE_APP_BUILD:-0}' FORCE_OPENVIKING_BUILD='${FORCE_OPENVIKING_BUILD:-0}' bash '$REMOTE_RELEASE/deploy/staging/server-deploy.sh'"

echo "Release $RELEASE_ID is deployed."
