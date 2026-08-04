#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/delegate-memory-use-truth-migration.XXXXXX)"
FIXTURE_CONTAINER="delegate-memory-use-truth-migration-$$"
FIXTURE_CONTAINER_STARTED="false"
FIXTURE_DATABASE="delegate_memory_use_truth_fixture"
FIXTURE_PASSWORD="memory_use_truth_fixture_only"
MIGRATION_NAME="20260804130000_memory_use_truth_ledger"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi

  if [[ -d "$FIXTURE_ROOT" && "$FIXTURE_ROOT" == /tmp/delegate-memory-use-truth-migration.* ]]; then
    find "$FIXTURE_ROOT" -depth -delete
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 memory-use migration fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the memory-use migration fixture.\n' >&2
  exit 2
}

mkdir -p \
  "$FIXTURE_ROOT/pre/prisma/migrations" \
  "$FIXTURE_ROOT/full/prisma/migrations"

for STAGE in pre full; do
  cp "$REPO_ROOT/prisma/schema.prisma" "$FIXTURE_ROOT/$STAGE/prisma/schema.prisma"
  cp \
    "$REPO_ROOT/prisma/migrations/migration_lock.toml" \
    "$FIXTURE_ROOT/$STAGE/prisma/migrations/migration_lock.toml"
done

for MIGRATION_DIR in "$REPO_ROOT"/prisma/migrations/20*; do
  CURRENT_MIGRATION_NAME="${MIGRATION_DIR##*/}"
  cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/full/prisma/migrations/$CURRENT_MIGRATION_NAME"
  if [[ "$CURRENT_MIGRATION_NAME" < "$MIGRATION_NAME" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/pre/prisma/migrations/$CURRENT_MIGRATION_NAME"
  fi
done

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env "POSTGRES_PASSWORD=$FIXTURE_PASSWORD" \
  --env "POSTGRES_DB=$FIXTURE_DATABASE" \
  --publish 127.0.0.1::5432 \
  --health-cmd="pg_isready -U postgres -d $FIXTURE_DATABASE" \
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

FIXTURE_PORT="$(
  docker port "$FIXTURE_CONTAINER" 5432/tcp |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
DATABASE_URL="postgresql://postgres:${FIXTURE_PASSWORD}@127.0.0.1:${FIXTURE_PORT}/${FIXTURE_DATABASE}"

deploy_stage() {
  local stage="$1"
  if ! DATABASE_URL="$DATABASE_URL" \
    pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
    --schema "$FIXTURE_ROOT/$stage/prisma/schema.prisma" >/dev/null; then
    psql_fixture <<'SQL' || true
SELECT migration_name, logs
  FROM "_prisma_migrations"
 WHERE finished_at IS NULL
 ORDER BY started_at DESC
 LIMIT 1;
SQL
    if [[ "$stage" == "full" ]]; then
      psql_fixture < "$REPO_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql" || true
    fi
    return 1
  fi
}

psql_fixture() {
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d "$FIXTURE_DATABASE" -X --set ON_ERROR_STOP=1
}

deploy_stage pre

psql_fixture <<'SQL' >/dev/null
SET session_replication_role = replica;

INSERT INTO "Owner" ("id", "displayName", "updatedAt")
VALUES ('owner_memory_fixture', 'Memory Fixture Owner', CURRENT_TIMESTAMP);

INSERT INTO "Representative" (
  "id", "ownerId", "slug", "displayName", "roleSummary", "tone",
  "languages", "freeScope", "paywalledIntents", "handoffPrompt",
  "allowedSkills", "actionGate", "updatedAt"
) VALUES (
  'representative_memory_fixture', 'owner_memory_fixture',
  'memory-use-truth-fixture', 'Memory Use Truth Fixture', 'fixture', 'neutral',
  '["en"]'::JSONB, '{}'::JSONB, '[]'::JSONB, 'fixture',
  '[]'::JSONB, '{}'::JSONB, CURRENT_TIMESTAMP
);

INSERT INTO "RepresentativeVersion" (
  "id", "representativeId", "versionNumber", "status", "snapshot"
) VALUES
  (
    'version_v1', 'representative_memory_fixture', 1, 'PUBLISHED',
    '{"knowledgeAssets":[]}'::JSONB
  ),
  (
    'version_v2', 'representative_memory_fixture', 2, 'PUBLISHED',
    '{"knowledgeAssets":[]}'::JSONB
  ),
  (
    'version_transition', 'representative_memory_fixture', 3, 'DRAFT',
    jsonb_build_object(
      'knowledgeAssets', jsonb_build_array(jsonb_build_object(
        'assetId', 'asset_transition',
        'checksum', repeat('b', 64),
        'processingVersion', 1
      ))
    )
  ),
  (
    'version_historical_assets', 'representative_memory_fixture', 4, 'PUBLISHED',
    jsonb_build_object(
      'knowledgeAssets', jsonb_build_array(
        jsonb_build_object('assetId', 'asset_historical_valid', 'checksum', repeat('a', 64), 'processingVersion', 1),
        jsonb_build_object('assetId', 'bad/asset', 'checksum', repeat('c', 64), 'processingVersion', 1),
        jsonb_build_object('assetId', 'asset_bad_checksum', 'checksum', 'not-a-checksum', 'processingVersion', 1),
        jsonb_build_object('assetId', 'asset_empty_title', 'checksum', repeat('d', 64), 'processingVersion', 1),
        jsonb_build_object('assetId', 'asset_long_title', 'checksum', repeat('e', 64), 'processingVersion', 1),
        jsonb_build_object('assetId', 'asset_empty_text', 'checksum', repeat('f', 64), 'processingVersion', 1)
      )
    )
  );

UPDATE "Representative"
   SET "activeVersionId" = 'version_v1', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'representative_memory_fixture';

INSERT INTO "Contact" ("id", "representativeId", "sourceChannel", "updatedAt")
VALUES ('contact_memory_fixture', 'representative_memory_fixture', 'WEB', CURRENT_TIMESTAMP);

INSERT INTO "Conversation" (
  "id", "representativeId", "contactId", "channel", "sourceChannel", "updatedAt"
) VALUES (
  'conversation_memory_fixture', 'representative_memory_fixture',
  'contact_memory_fixture', 'PRIVATE_CHAT', 'WEB', CURRENT_TIMESTAMP
);

INSERT INTO "ConversationEpisode" (
  "id", "conversationId", "representativeVersionId", "sequence", "status", "updatedAt"
) VALUES
  ('episode_v1', 'conversation_memory_fixture', 'version_v1', 1, 'ACTIVE', CURRENT_TIMESTAMP),
  ('episode_v2', 'conversation_memory_fixture', 'version_v2', 2, 'ACTIVE', CURRENT_TIMESTAMP);

UPDATE "Conversation"
   SET "activeEpisodeId" = 'episode_v1', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'conversation_memory_fixture';

INSERT INTO "Message" (
  "id", "conversationId", "episodeId", "senderType", "text", "deliveryStatus", "updatedAt"
) VALUES
  ('message_truth_input', 'conversation_memory_fixture', 'episode_v1', 'AUDIENCE', 'remember this', 'ACCEPTED', CURRENT_TIMESTAMP),
  ('message_truth_output', 'conversation_memory_fixture', 'episode_v1', 'REPRESENTATIVE', 'I used memory', 'SENT', CURRENT_TIMESTAMP),
  ('message_started_input', 'conversation_memory_fixture', 'episode_v1', 'AUDIENCE', 'legacy started', 'ACCEPTED', CURRENT_TIMESTAMP),
  ('message_wrong_generation_input', 'conversation_memory_fixture', 'episode_v1', 'AUDIENCE', 'bound generation input', 'ACCEPTED', CURRENT_TIMESTAMP),
  ('message_wrong_use_input', 'conversation_memory_fixture', 'episode_v1', 'AUDIENCE', 'incorrect use input', 'ACCEPTED', CURRENT_TIMESTAMP);

INSERT INTO "GenerationRun" (
  "id", "conversationId", "episodeId", "inputMessageId", "outputMessageId",
  "representativeVersionId", "status", "idempotencyKey", "completedAt", "updatedAt"
) VALUES
  (
    'generation_truth', 'conversation_memory_fixture', 'episode_v1',
    'message_truth_input', 'message_truth_output', 'version_v1',
    'COMPLETED', 'generation_truth', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'generation_started', 'conversation_memory_fixture', 'episode_v1',
    'message_started_input', NULL, 'version_v1',
    'QUEUED', 'generation_started', NULL, CURRENT_TIMESTAMP
  ),
  (
    'generation_wrong_bound', 'conversation_memory_fixture', 'episode_v1',
    'message_wrong_generation_input', NULL, 'version_v1',
    'QUEUED', 'generation_wrong_bound', NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "RepresentativeMemoryPolicy" (
  "representativeId", "namespaceKey", "longTermMemoryEnabled",
  "contactMemoryEnabled", "webRecallEnabled", "updatedAt"
) VALUES (
  'representative_memory_fixture', 'memoryfixture', true, true, true,
  CURRENT_TIMESTAMP
);

INSERT INTO "MemoryCandidate" (
  "id", "representativeId", "contactId", "scope", "scopeChannel",
  "originChannel", "category", "sourceKind", "safeText", "summary",
  "contentHash", "dedupeKey", "status", "safetyClass",
  "extractionReasonCode", "sourceContactId", "sourceConversationId",
  "sourceMessageId", "reviewedAt", "updatedAt"
) VALUES (
  'candidate_memory_fixture', 'representative_memory_fixture',
  'contact_memory_fixture', 'CONTACT_CHANNEL', 'WEB', 'WEB',
  'CONTACT_PREFERENCE', 'AUDIENCE_MESSAGE', 'Prefers concise answers.',
  'Concise answer preference', repeat('1', 64), 'candidate-memory-fixture',
  'APPROVED', 'LOW_RISK', 'explicit_preference', 'contact_memory_fixture',
  'conversation_memory_fixture', 'message_truth_input', CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "GovernedMemory" (
  "id", "representativeId", "contactId", "scope", "sourceChannel",
  "category", "status", "currentVersionId", "recallDisabledAt", "updatedAt"
) VALUES (
  'memory_fixture', 'representative_memory_fixture', 'contact_memory_fixture',
  'CONTACT_CHANNEL', 'WEB', 'CONTACT_PREFERENCE', 'ACTIVE',
  'memory_version_fixture', NULL, CURRENT_TIMESTAMP
);

INSERT INTO "GovernedMemoryVersion" (
  "id", "memoryId", "representativeId", "scope", "sourceCandidateId",
  "versionNumber", "safeText", "summary", "contentHash", "createdByActorId"
) VALUES (
  'memory_version_fixture', 'memory_fixture', 'representative_memory_fixture',
  'CONTACT_CHANNEL', 'candidate_memory_fixture', 1,
  'Prefers concise answers.', 'Concise answer preference', repeat('1', 64),
  'owner_memory_fixture'
);

INSERT INTO "MemoryReviewDecision" (
  "id", "representativeId", "candidateId", "memoryId", "resultVersionId",
  "outcome", "reviewerRole", "reviewerActorId", "reasonCode"
) VALUES (
  'review_memory_fixture', 'representative_memory_fixture',
  'candidate_memory_fixture', 'memory_fixture', 'memory_version_fixture',
  'APPROVED', 'OWNER', 'owner_memory_fixture', 'owner_approved'
);

INSERT INTO "MemoryProjectionItem" (
  "id", "representativeId", "memoryId", "memoryVersionId", "lane", "status",
  "contentHash", "idempotencyKey", "remoteUri", "updatedAt"
) VALUES (
  'projection_memory_fixture', 'representative_memory_fixture', 'memory_fixture',
  'memory_version_fixture', 'RECALL', 'DISABLED', repeat('1', 64),
  'projection-memory-fixture',
  'viking://user/delegate-memory-memoryfixture/memories/delegate/memoryfixture/contacts/contact_memory_fixture/channels/web/memories/memory_fixture/versions/memory_version_fixture.md',
  CURRENT_TIMESTAMP
);

INSERT INTO "MemoryUseRun" (
  "id", "representativeId", "conversationId", "contactId", "sourceChannel",
  "representativeVersionId", "inputMessageId", "outputMessageId",
  "generationRunId", "idempotencyKey", "status", "searchedCount",
  "scopePassedCount", "safetyPassedCount", "injectedCount", "displayedCount",
  "completedAt", "updatedAt"
) VALUES
  (
    'run_truth', 'representative_memory_fixture', 'conversation_memory_fixture',
    'contact_memory_fixture', 'WEB', 'version_v1', 'message_truth_input',
    'message_truth_output', 'generation_truth', 'run-truth', 'COMPLETED',
    2, 1, 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'run_started_completed', 'representative_memory_fixture',
    'conversation_memory_fixture', 'contact_memory_fixture', 'WEB', 'version_v1',
    'message_started_input', NULL, 'generation_started', 'run-started-completed',
    'STARTED', 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'run_wrong_bound', 'representative_memory_fixture',
    'conversation_memory_fixture', 'contact_memory_fixture', 'WEB', 'version_v1',
    'message_wrong_use_input', NULL, 'generation_wrong_bound', 'run-wrong-bound',
    'FAILED', 1, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

INSERT INTO "MessageCitation" (
  "id", "messageId", "title", "uri", "excerpt", "score"
) VALUES (
  'citation_legacy_display', 'message_truth_output', 'Legacy memory source',
  'viking://user/legacy/private-source', 'private source excerpt', 0.91
);

INSERT INTO "MemoryUseItem" (
  "id", "useRunId", "representativeId", "itemKey", "sourceKind",
  "memoryScope", "memoryVersionId", "projectionItemId", "displayedCitationId",
  "contentHash", "searchRank", "searchScore", "searchedAt", "scopeCheckedAt",
  "scopePassedAt", "safetyCheckedAt", "safetyPassedAt", "injectedAt",
  "displayedAt", "rejectionReasonCode", "updatedAt"
) VALUES
  (
    'item_displayed', 'run_truth', 'representative_memory_fixture',
    'displayed-memory', 'CONTACT_MEMORY', 'CONTACT_CHANNEL',
    'memory_version_fixture', 'projection_memory_fixture',
    'citation_legacy_display', repeat('1', 64), 1, 0.91,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'item_free_text_rejection', 'run_truth', 'representative_memory_fixture',
    'rejected-memory', 'CONTACT_MEMORY', 'CONTACT_CHANNEL',
    'memory_version_fixture', 'projection_memory_fixture', NULL, repeat('1', 64),
    2, 0.50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL,
    'scope rejected because raw contact detail was unsafe', CURRENT_TIMESTAMP
  ),
  (
    'item_wrong_bound', 'run_wrong_bound', 'representative_memory_fixture',
    'wrong-bound-memory', 'CONTACT_MEMORY', 'CONTACT_CHANNEL',
    'memory_version_fixture', 'projection_memory_fixture', NULL, repeat('1', 64),
    1, 0.40, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    CURRENT_TIMESTAMP
  );

INSERT INTO "KnowledgeAsset" (
  "id", "ownerId", "kind", "status", "visibility", "title", "sourceText",
  "extractedText", "checksum", "processingVersion", "updatedAt"
) VALUES
  ('asset_historical_valid', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', 'Historical valid asset', 'historical valid bytes', 'historical valid bytes', repeat('a', 64), 1, CURRENT_TIMESTAMP),
  ('bad/asset', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', 'Unsafe id asset', 'unsafe id bytes', 'unsafe id bytes', repeat('c', 64), 1, CURRENT_TIMESTAMP),
  ('asset_bad_checksum', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', 'Bad checksum asset', 'bad checksum bytes', 'bad checksum bytes', 'not-a-checksum', 1, CURRENT_TIMESTAMP),
  ('asset_empty_title', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', '   ', 'empty title bytes', 'empty title bytes', repeat('d', 64), 1, CURRENT_TIMESTAMP),
  ('asset_long_title', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', repeat('x', 201), 'long title bytes', 'long title bytes', repeat('e', 64), 1, CURRENT_TIMESTAMP),
  ('asset_empty_text', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', 'Empty text asset', 'empty text bytes', '   ', repeat('f', 64), 1, CURRENT_TIMESTAMP),
  ('asset_transition', 'owner_memory_fixture', 'TEXT', 'READY', 'PUBLIC_MATERIAL', 'Transition asset', 'transition bytes', 'transition bytes', repeat('b', 64), 1, CURRENT_TIMESTAMP);

INSERT INTO "KnowledgeAssetRepresentative" (
  "id", "assetId", "representativeId", "usageMode", "reviewStatus", "enabled", "updatedAt"
) VALUES
  ('binding_historical_valid', 'asset_historical_valid', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_bad_id', 'bad/asset', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_bad_checksum', 'asset_bad_checksum', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_empty_title', 'asset_empty_title', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_long_title', 'asset_long_title', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_empty_text', 'asset_empty_text', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP),
  ('binding_transition', 'asset_transition', 'representative_memory_fixture', 'PUBLIC_MATERIAL', 'APPROVED', true, CURRENT_TIMESTAMP);

UPDATE "ConversationEpisode"
   SET "status" = 'RESOLVED', "endedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'episode_v1';
UPDATE "Conversation"
   SET "activeEpisodeId" = 'episode_v2', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'conversation_memory_fixture';
UPDATE "Representative"
   SET "activeVersionId" = 'version_v2', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'representative_memory_fixture';

SET session_replication_role = origin;

DO $fixture$
BEGIN
  IF (SELECT "displayedCount" FROM "MemoryUseRun" WHERE "id" = 'run_truth') <> 1
     OR (SELECT COUNT(*) FROM "MessageCitation") <> 1 THEN
    RAISE EXCEPTION 'legacy fixture did not establish displayedCount=1 with one citation';
  END IF;
END
$fixture$;
SQL

deploy_stage full

psql_fixture <<'SQL' >/dev/null
DO $fixture$
DECLARE
  truth_run "MemoryUseRun"%ROWTYPE;
  started_run "MemoryUseRun"%ROWTYPE;
  displayed_item "MemoryUseItem"%ROWTYPE;
BEGIN
  SELECT * INTO truth_run FROM "MemoryUseRun" WHERE "id" = 'run_truth';
  IF NOT FOUND
     OR truth_run."searchedCount" <> 2
     OR truth_run."scopePassedCount" <> 1
     OR truth_run."safetyPassedCount" <> 1
     OR truth_run."injectedCount" <> 1
     OR truth_run."citedCount" <> 0
     OR truth_run."displayedCount" <> 0 THEN
    RAISE EXCEPTION 'retained truth run counters were not re-derived after citation scrub';
  END IF;

  SELECT * INTO displayed_item FROM "MemoryUseItem" WHERE "id" = 'item_displayed';
  IF NOT FOUND
     OR displayed_item."injectedAt" IS NULL
     OR displayed_item."citationId" IS NOT NULL
     OR displayed_item."citedAt" IS NOT NULL
     OR displayed_item."displayedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy citation was not cleared while preserving injection truth';
  END IF;

  IF EXISTS (SELECT 1 FROM "MessageCitation") THEN
    RAISE EXCEPTION 'legacy citations survived the truth-ledger migration';
  END IF;

  SELECT * INTO started_run FROM "MemoryUseRun" WHERE "id" = 'run_started_completed';
  IF NOT FOUND
     OR started_run."status" <> 'FAILED'::"MemoryUseRunStatus"
     OR started_run."completedAt" IS NULL
     OR started_run."reasonCode" <> 'legacy_failed' THEN
    RAISE EXCEPTION 'legacy STARTED+completed run was not retained as FAILED+legacy_failed';
  END IF;

  IF EXISTS (SELECT 1 FROM "MemoryUseRun" WHERE "id" = 'run_wrong_bound')
     OR EXISTS (SELECT 1 FROM "MemoryUseItem" WHERE "id" = 'item_wrong_bound') THEN
    RAISE EXCEPTION 'incorrectly bound generation run was not removed with its items';
  END IF;

  IF (SELECT "rejectionReasonCode" FROM "MemoryUseItem" WHERE "id" = 'item_free_text_rejection')
     IS DISTINCT FROM 'legacy_scope_rejected' THEN
    RAISE EXCEPTION 'legacy free-text rejection was not normalized';
  END IF;

  IF (SELECT COUNT(*) FROM "RepresentativeVersionResource" WHERE "publishedVersionId" = 'version_historical_assets') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM "RepresentativeVersionResource"
        WHERE "publishedVersionId" = 'version_historical_assets'
          AND "resourceKey" = 'knowledge/asset_historical_valid.md'
          AND "contentHash" = repeat('a', 64)
          AND "safeText" = 'historical valid bytes'
     ) THEN
    RAISE EXCEPTION 'historical resource backfill did not preserve only the valid asset';
  END IF;
END
$fixture$;

UPDATE "RepresentativeVersion"
   SET "status" = 'PUBLISHED'
 WHERE "id" = 'version_transition';

DO $fixture$
BEGIN
  IF (SELECT COUNT(*) FROM "RepresentativeVersionResource" WHERE "publishedVersionId" = 'version_transition') <> 1 THEN
    RAISE EXCEPTION 'DRAFT to PUBLISHED did not snapshot the pinned asset';
  END IF;
END
$fixture$;

UPDATE "RepresentativeVersion"
   SET "status" = 'PUBLISHED'
 WHERE "id" = 'version_transition';

DO $fixture$
BEGIN
  IF (SELECT COUNT(*) FROM "RepresentativeVersionResource" WHERE "publishedVersionId" = 'version_transition') <> 1 THEN
    RAISE EXCEPTION 'PUBLISHED no-op replayed the resource snapshot';
  END IF;
END
$fixture$;

INSERT INTO "RepresentativeVersion" (
  "id", "representativeId", "versionNumber", "status", "snapshot"
) VALUES (
  'version_insert_published', 'representative_memory_fixture', 5, 'PUBLISHED',
  jsonb_build_object(
    'knowledgeAssets', jsonb_build_array(jsonb_build_object(
      'assetId', 'asset_transition',
      'checksum', repeat('b', 64),
      'processingVersion', 1
    ))
  )
);

DO $fixture$
BEGIN
  IF (SELECT COUNT(*) FROM "RepresentativeVersionResource" WHERE "publishedVersionId" = 'version_insert_published') <> 1 THEN
    RAISE EXCEPTION 'INSERT PUBLISHED did not snapshot the pinned asset';
  END IF;
END
$fixture$;
SQL

DATABASE_URL="$DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate status \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma" >/dev/null

DATABASE_URL="$DATABASE_URL" \
DELEGATE_POSTGRES_E2E=1 \
  pnpm --dir "$REPO_ROOT/packages/web-data" exec vitest run \
  --no-file-parallelism \
  tests/postgres-memory-use-truth-migration.integration.test.ts

printf 'PostgreSQL 16 memory-use truth-ledger migration fixture passed.\n'
