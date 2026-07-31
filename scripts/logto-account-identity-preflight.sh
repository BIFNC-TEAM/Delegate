#!/usr/bin/env bash

set -Eeuo pipefail

STRICT="false"
APPROVALS_FILE=""
APPROVAL_TEMPLATE_FILE=""
PSQL_BIN="${PSQL_BIN:-psql}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFLIGHT_SQL="${REPO_ROOT}/prisma/preflight/logto-account-identity-conflicts.sql"
APPROVAL_TOOL="${REPO_ROOT}/scripts/logto-account-identity-approvals.mjs"

usage() {
  printf '%s\n' \
    "Usage: scripts/logto-account-identity-preflight.sh [--strict] [--approvals FILE]" \
    "       scripts/logto-account-identity-preflight.sh --write-approval-template FILE" \
    "" \
    "Runs the current-schema Logto Account preflight in a read-only transaction." \
    "BLOCKER rows always fail. --strict requires an exact approved artifact" \
    "for every REVIEW row. Templates are created with mode 0600 and never overwrite."
}

fail() {
  printf 'Logto Account identity preflight: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT="true"
      shift
      ;;
    --approvals)
      [[ $# -ge 2 ]] || fail "--approvals requires a file path."
      APPROVALS_FILE="$2"
      shift 2
      ;;
    --write-approval-template)
      [[ $# -ge 2 ]] || fail "--write-approval-template requires a file path."
      APPROVAL_TEMPLATE_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL must be set."
[[ -f "$PREFLIGHT_SQL" ]] || fail "SQL file is missing: ${PREFLIGHT_SQL}"
[[ -f "$APPROVAL_TOOL" ]] || fail "approval validator is missing: ${APPROVAL_TOOL}"

REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/delegate-logto-account-preflight.XXXXXX")"
cleanup() {
  rm -f "$REPORT_FILE"
}
trap cleanup EXIT

if command -v "$PSQL_BIN" >/dev/null 2>&1; then
  "$PSQL_BIN" "$DATABASE_URL" \
    -X \
    --set ON_ERROR_STOP=1 \
    --csv \
    --quiet \
    --pset footer=off \
    --file "$PREFLIGHT_SQL" > "$REPORT_FILE"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose exec -T postgres \
    psql "$DATABASE_URL" \
      -X \
      --set ON_ERROR_STOP=1 \
      --csv \
      --quiet \
      --pset footer=off \
      --file /dev/stdin \
      < "$PREFLIGHT_SQL" > "$REPORT_FILE"
else
  fail "${PSQL_BIN} or Docker Compose with the local postgres service is required."
fi

sed -n '1,$p' "$REPORT_FILE"

if [[ -n "$APPROVAL_TEMPLATE_FILE" ]]; then
  node "$APPROVAL_TOOL" template "$REPORT_FILE" "$APPROVAL_TEMPLATE_FILE"
fi

if grep -q '^BLOCKER,' "$REPORT_FILE"; then
  fail "blocking identity conflicts were found." 2
fi

if [[ -n "$APPROVALS_FILE" ]]; then
  if ! node "$APPROVAL_TOOL" verify "$REPORT_FILE" "$APPROVALS_FILE"; then
    fail "the approval artifact is incomplete, stale, or invalid." 3
  fi
fi

if [[ "$STRICT" == "true" ]] && grep -q '^REVIEW,' "$REPORT_FILE"; then
  if [[ -z "$APPROVALS_FILE" ]]; then
    fail "strict mode requires --approvals FILE for every review row." 3
  fi
fi

if grep -q '^REVIEW,' "$REPORT_FILE" && [[ -z "$APPROVALS_FILE" ]]; then
  printf '%s\n' \
    "Logto Account identity preflight: review rows require an approved mapping before cutover." \
    >&2
fi
