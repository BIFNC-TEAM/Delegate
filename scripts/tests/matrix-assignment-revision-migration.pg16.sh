#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_CONTAINER="delegate-matrix-assignment-revision-$$_pg16"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 migration fixture.\n' >&2
  exit 2
}

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=matrix_assignment_fixture_only \
  --env POSTGRES_DB=delegate_fixture \
  --health-cmd='pg_isready -U postgres -d delegate_fixture' \
  --health-interval=1s \
  --health-timeout=2s \
  --health-retries=30 \
  postgres:16-alpine >/dev/null
FIXTURE_CONTAINER_STARTED="true"

FIXTURE_READY="false"
for _ in {1..35}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$FIXTURE_CONTAINER")" == "healthy" ]]; then
    FIXTURE_READY="true"
    break
  fi
  sleep 1
done

if [[ "$FIXTURE_READY" != "true" ]]; then
  docker logs "$FIXTURE_CONTAINER"
  exit 3
fi

printf 'phase=create_pre_migration_schema\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE "RepresentativeChannelBinding" (
  "id" TEXT PRIMARY KEY,
  "representativeId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "externalUserId" TEXT NOT NULL,
  "connectionId" TEXT,
  "telegramBotConnectionId" TEXT,
  "desiredState" TEXT NOT NULL
);

CREATE TABLE "ConversationChannelBinding" (
  "id" TEXT PRIMARY KEY,
  "representativeBindingId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "metadata" JSONB
);

INSERT INTO "RepresentativeChannelBinding" (
  "id",
  "representativeId",
  "kind",
  "externalUserId",
  "connectionId",
  "desiredState"
)
VALUES
  (
    'rep-binding-1',
    'rep-1',
    'MATRIX',
    '@delegate_rep_a:matrix.local',
    'delegate-matrix-as',
    'ACTIVE'
  ),
  (
    'telegram-binding-1',
    'rep-telegram-1',
    'TELEGRAM',
    '@bot_a',
    '111111111',
    'ACTIVE'
  );

UPDATE "RepresentativeChannelBinding"
SET "telegramBotConnectionId" = 'telegram-connection-a'
WHERE "id" = 'telegram-binding-1';

INSERT INTO "ConversationChannelBinding" (
  "id",
  "representativeBindingId",
  "kind",
  "metadata"
)
VALUES
  (
    'legacy-active-room',
    'rep-binding-1',
    'MATRIX',
    '{"securityState":"ACTIVE"}'::jsonb
  ),
  (
    'legacy-isolated-room',
    'rep-binding-1',
    'MATRIX',
    jsonb_build_object(
      'securityState',
      'ISOLATED',
      'isolationReason',
      'matrix_room_encrypted',
      'isolatedAt',
      '2026-01-01T00:00:00.000Z'
    )
  ),
  (
    'legacy-telegram-chat',
    'telegram-binding-1',
    'TELEGRAM',
    '{}'::jsonb
  );
SQL

printf 'phase=apply_assignment_revision_migration\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 \
  < "$REPO_ROOT/prisma/migrations/20260729110000_matrix_assignment_revision_fence/migration.sql" \
  >/dev/null

printf 'phase=exercise_legacy_and_current_writers\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
-- A legacy writer does not know about the revision column. The trigger must
-- still advance the assignment epoch when A is replaced with B.
UPDATE "RepresentativeChannelBinding"
SET "externalUserId" = '@delegate_rep_b:matrix.local'
WHERE "id" = 'rep-binding-1';

INSERT INTO "ConversationChannelBinding" (
  "id",
  "representativeBindingId",
  "kind",
  "representativeAssignmentRevision",
  "metadata"
)
SELECT
  'current-b-room',
  "id",
  'MATRIX',
  "endpointAssignmentRevision",
  jsonb_build_object(
    'securityState',
    'ACTIVE',
    'representativeAssignmentRevision',
    "endpointAssignmentRevision"
  )
FROM "RepresentativeChannelBinding"
WHERE "id" = 'rep-binding-1';

-- Reusing A must create a new epoch and permanently isolate the B room.
UPDATE "RepresentativeChannelBinding"
SET "externalUserId" = '@delegate_rep_a:matrix.local'
WHERE "id" = 'rep-binding-1';

INSERT INTO "ConversationChannelBinding" (
  "id",
  "representativeBindingId",
  "kind",
  "representativeAssignmentRevision",
  "metadata"
)
SELECT
  'current-a-room',
  "id",
  'MATRIX',
  "endpointAssignmentRevision",
  jsonb_build_object(
    'securityState',
    'ACTIVE',
    'representativeAssignmentRevision',
    "endpointAssignmentRevision"
  )
FROM "RepresentativeChannelBinding"
WHERE "id" = 'rep-binding-1';

-- A stale writer cannot roll the epoch back.
UPDATE "RepresentativeChannelBinding"
SET "endpointAssignmentRevision" = 1
WHERE "id" = 'rep-binding-1';

-- Telegram legacy writers must also advance the epoch through Bot changes and
-- reconnects, including an A -> B -> A return to the same Bot.
UPDATE "RepresentativeChannelBinding"
SET
  "connectionId" = '222222222',
  "telegramBotConnectionId" = 'telegram-connection-b'
WHERE "id" = 'telegram-binding-1';

INSERT INTO "ConversationChannelBinding" (
  "id",
  "representativeBindingId",
  "kind",
  "representativeAssignmentRevision",
  "metadata"
)
SELECT
  'telegram-b-chat',
  "id",
  'TELEGRAM',
  "endpointAssignmentRevision",
  '{}'::jsonb
FROM "RepresentativeChannelBinding"
WHERE "id" = 'telegram-binding-1';

UPDATE "RepresentativeChannelBinding"
SET
  "connectionId" = '111111111',
  "telegramBotConnectionId" = 'telegram-connection-a'
WHERE "id" = 'telegram-binding-1';

UPDATE "RepresentativeChannelBinding"
SET "desiredState" = 'DISCONNECTED'
WHERE "id" = 'telegram-binding-1';

UPDATE "RepresentativeChannelBinding"
SET "desiredState" = 'ACTIVE'
WHERE "id" = 'telegram-binding-1';

-- An insert that omits the new column remains compatible and gets epoch 1.
INSERT INTO "RepresentativeChannelBinding" (
  "id",
  "representativeId",
  "kind",
  "externalUserId",
  "connectionId",
  "desiredState"
)
VALUES (
  'rep-binding-2',
  'rep-2',
  'MATRIX',
  '@delegate_rep_c:matrix.local',
  'delegate-matrix-as',
  'ACTIVE'
);

DO $fixture$
DECLARE
  assignment_revision INTEGER;
  legacy_reason TEXT;
  preserved_reason TEXT;
  preserved_at TEXT;
  b_room_state TEXT;
  b_room_reason TEXT;
  b_room_revision INTEGER;
  a_room_state TEXT;
  a_room_revision INTEGER;
  default_revision INTEGER;
  telegram_revision INTEGER;
  legacy_telegram_revision INTEGER;
  telegram_b_revision INTEGER;
BEGIN
  SELECT "endpointAssignmentRevision"
  INTO assignment_revision
  FROM "RepresentativeChannelBinding"
  WHERE "id" = 'rep-binding-1';

  IF assignment_revision IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'expected A -> B -> A revision 3, got %', assignment_revision;
  END IF;

  SELECT "metadata"->>'isolationReason'
  INTO legacy_reason
  FROM "ConversationChannelBinding"
  WHERE "id" = 'legacy-active-room';

  IF legacy_reason IS DISTINCT FROM 'matrix_assignment_revision_migration' THEN
    RAISE EXCEPTION 'legacy room was not migration-isolated: %', legacy_reason;
  END IF;

  SELECT
    "metadata"->>'isolationReason',
    "metadata"->>'isolatedAt'
  INTO preserved_reason, preserved_at
  FROM "ConversationChannelBinding"
  WHERE "id" = 'legacy-isolated-room';

  IF preserved_reason IS DISTINCT FROM 'matrix_room_encrypted'
    OR preserved_at IS DISTINCT FROM '2026-01-01T00:00:00.000Z'
  THEN
    RAISE EXCEPTION
      'existing isolation evidence was overwritten: reason=%, at=%',
      preserved_reason,
      preserved_at;
  END IF;

  SELECT
    "metadata"->>'securityState',
    "metadata"->>'isolationReason',
    "representativeAssignmentRevision"
  INTO b_room_state, b_room_reason, b_room_revision
  FROM "ConversationChannelBinding"
  WHERE "id" = 'current-b-room';

  IF b_room_state IS DISTINCT FROM 'ISOLATED'
    OR b_room_reason IS DISTINCT FROM 'matrix_identity_reassigned'
    OR b_room_revision IS DISTINCT FROM 2
  THEN
    RAISE EXCEPTION
      'B room fence failed: state=%, reason=%, revision=%',
      b_room_state,
      b_room_reason,
      b_room_revision;
  END IF;

  SELECT
    "metadata"->>'securityState',
    "representativeAssignmentRevision"
  INTO a_room_state, a_room_revision
  FROM "ConversationChannelBinding"
  WHERE "id" = 'current-a-room';

  IF a_room_state IS DISTINCT FROM 'ACTIVE'
    OR a_room_revision IS DISTINCT FROM 3
  THEN
    RAISE EXCEPTION
      'current A room should remain active at revision 3: state=%, revision=%',
      a_room_state,
      a_room_revision;
  END IF;

  SELECT "endpointAssignmentRevision"
  INTO default_revision
  FROM "RepresentativeChannelBinding"
  WHERE "id" = 'rep-binding-2';

  IF default_revision IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'legacy-compatible insert did not default to revision 1: %', default_revision;
  END IF;

  SELECT "endpointAssignmentRevision"
  INTO telegram_revision
  FROM "RepresentativeChannelBinding"
  WHERE "id" = 'telegram-binding-1';

  IF telegram_revision IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION
      'expected Telegram A -> B -> A -> reconnect revision 4, got %',
      telegram_revision;
  END IF;

  SELECT "representativeAssignmentRevision"
  INTO legacy_telegram_revision
  FROM "ConversationChannelBinding"
  WHERE "id" = 'legacy-telegram-chat';

  IF legacy_telegram_revision IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy Telegram chat must retain NULL and fail closed, got %',
      legacy_telegram_revision;
  END IF;

  SELECT "representativeAssignmentRevision"
  INTO telegram_b_revision
  FROM "ConversationChannelBinding"
  WHERE "id" = 'telegram-b-chat';

  IF telegram_b_revision IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION
      'historical Telegram B chat epoch changed unexpectedly: %',
      telegram_b_revision;
  END IF;
END;
$fixture$;
SQL

printf 'matrix_assignment_revision_migration_fixture=passed\n'
