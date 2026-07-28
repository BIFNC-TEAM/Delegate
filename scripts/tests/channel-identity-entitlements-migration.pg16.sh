#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/delegate-channel-identity-migration.XXXXXX)"
FIXTURE_CONTAINER="delegate-channel-identity-migration-$$"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi

  if [[ -d "$FIXTURE_ROOT" && "$FIXTURE_ROOT" == /tmp/delegate-channel-identity-migration.* ]]; then
    find "$FIXTURE_ROOT" -depth -delete
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 migration fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the disposable PostgreSQL 16 migration fixture.\n' >&2
  exit 2
}

mkdir -p \
  "$FIXTURE_ROOT/pre/prisma/migrations" \
  "$FIXTURE_ROOT/mid/prisma/migrations" \
  "$FIXTURE_ROOT/full/prisma/migrations"

for STAGE in pre mid full; do
  cp "$REPO_ROOT/prisma/schema.prisma" "$FIXTURE_ROOT/$STAGE/prisma/schema.prisma"
  cp \
    "$REPO_ROOT/prisma/migrations/migration_lock.toml" \
    "$FIXTURE_ROOT/$STAGE/prisma/migrations/migration_lock.toml"
done

for MIGRATION_DIR in "$REPO_ROOT"/prisma/migrations/20*; do
  MIGRATION_NAME="${MIGRATION_DIR##*/}"
  cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/full/prisma/migrations/$MIGRATION_NAME"

  if [[ "$MIGRATION_NAME" < "20260723230000_channel_identity_entitlements" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/pre/prisma/migrations/$MIGRATION_NAME"
  fi

  if [[ "$MIGRATION_NAME" < "20260723231000_channel_identity_safe_backfill" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/mid/prisma/migrations/$MIGRATION_NAME"
  fi
done

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=channel_identity_fixture_only \
  --env POSTGRES_DB=delegate_fixture \
  --publish 127.0.0.1::5432 \
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

FIXTURE_PORT="$(
  docker port "$FIXTURE_CONTAINER" 5432/tcp |
    sed -E 's/.*:([0-9]+)$/\1/'
)"
FIXTURE_DATABASE_URL="postgresql://postgres:channel_identity_fixture_only@127.0.0.1:${FIXTURE_PORT}/delegate_fixture"

printf 'phase=deploy_pre_expansion_migrations\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/pre/prisma/schema.prisma" >/dev/null

printf 'phase=insert_legacy_channel_identity_fixture\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "Owner" ("id", "displayName", "updatedAt")
VALUES ('owner_channel_fixture', 'Channel fixture owner', CURRENT_TIMESTAMP);

INSERT INTO "Representative" (
  "id", "ownerId", "slug", "displayName", "roleSummary", "tone",
  "languages", "freeScope", "paywalledIntents", "handoffPrompt",
  "allowedSkills", "actionGate", "updatedAt"
)
VALUES (
  'rep_channel_fixture',
  'owner_channel_fixture',
  'channel-fixture',
  'Channel fixture',
  'fixture',
  'neutral',
  '["en"]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  'handoff',
  '[]'::jsonb,
  '{}'::jsonb,
  CURRENT_TIMESTAMP
);

INSERT INTO "AudienceIdentity" (
  "id", "audienceKey", "status", "updatedAt"
)
VALUES
  ('identity_conflict_contact', 'fixture:conflict:contact', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_conflict_wallet', 'fixture:conflict:wallet', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_matrix_safe', 'fixture:matrix:safe', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_matrix_collision_upper', 'fixture:matrix:collision:upper', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_matrix_collision_lower', 'fixture:matrix:collision:lower', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_matrix_invalid_port', 'fixture:matrix:invalid-port', 'ANONYMOUS', CURRENT_TIMESTAMP),
  ('identity_matrix_invalid_host', 'fixture:matrix:invalid-host', 'ANONYMOUS', CURRENT_TIMESTAMP);

INSERT INTO "Contact" (
  "id", "representativeId", "audienceIdentityId", "telegramUserId",
  "displayName", "updatedAt"
)
VALUES
  ('contact_safe', 'rep_channel_fixture', NULL, '100', 'Safe Telegram user', CURRENT_TIMESTAMP),
  (
    'contact_conflict',
    'rep_channel_fixture',
    'identity_conflict_contact',
    '200',
    'Conflicting Telegram user',
    CURRENT_TIMESTAMP
  );

INSERT INTO "Conversation" (
  "id", "representativeId", "contactId", "audienceIdentityId",
  "telegramChatId", "channel", "updatedAt"
)
VALUES
  (
    'conversation_safe',
    'rep_channel_fixture',
    'contact_safe',
    NULL,
    '100',
    'PRIVATE_CHAT',
    CURRENT_TIMESTAMP
  ),
  (
    'conversation_duplicate_one',
    'rep_channel_fixture',
    'contact_safe',
    NULL,
    '101',
    'PRIVATE_CHAT',
    CURRENT_TIMESTAMP
  ),
  (
    'conversation_duplicate_two',
    'rep_channel_fixture',
    'contact_safe',
    NULL,
    '102',
    'PRIVATE_CHAT',
    CURRENT_TIMESTAMP
  ),
  (
    'conversation_serialized_collision_one',
    'rep_channel_fixture',
    'contact_safe',
    NULL,
    '103',
    'PRIVATE_CHAT',
    CURRENT_TIMESTAMP
  ),
  (
    'conversation_serialized_collision_two',
    'rep_channel_fixture',
    'contact_safe',
    NULL,
    '104',
    'PRIVATE_CHAT',
    CURRENT_TIMESTAMP
  );

INSERT INTO "UserWallet" (
  "id", "audienceIdentityId", "externalUserId", "telegramUserId",
  "cashBalanceCents", "updatedAt"
)
VALUES
  ('wallet_safe', NULL, 'wallet-safe', '100', 500, CURRENT_TIMESTAMP),
  (
    'wallet_conflict',
    'identity_conflict_wallet',
    'wallet-conflict',
    '200',
    700,
    CURRENT_TIMESTAMP
  );

INSERT INTO "AgentWallet" (
  "id", "representativeId", "tokenBalance", "totalPurchasedTokens",
  "totalConsumedTokens", "updatedAt"
)
-- The APPLIED charge below consumes one token, so the legacy wallet
-- projection must already equal 10 purchased - 1 consumed = 9.
VALUES ('agent_wallet_safe', 'rep_channel_fixture', 9, 10, 1, CURRENT_TIMESTAMP);

INSERT INTO "AgentTokenPurchase" (
  "id", "userWalletId", "agentWalletId", "representativeId",
  "amountCents", "tokenAmount", "tokenUnitPriceCents",
  "creatorPendingCents", "idempotencyKey", "updatedAt"
)
VALUES (
  'purchase_safe',
  'wallet_safe',
  'agent_wallet_safe',
  'rep_channel_fixture',
  10,
  10,
  1,
  0,
  'fixture:purchase:safe',
  CURRENT_TIMESTAMP
);

INSERT INTO "AgentUsageCharge" (
  "id", "agentWalletId", "representativeId", "tokenPurchaseId",
  "kind", "status", "tokenAmount", "idempotencyKey", "updatedAt"
)
VALUES (
  'charge_safe',
  'agent_wallet_safe',
  'rep_channel_fixture',
  'purchase_safe',
  'MODEL_TOKEN',
  'APPLIED',
  1,
  'fixture:charge:safe',
  CURRENT_TIMESTAMP
);

INSERT INTO "RepresentativeChannelBinding" (
  "id", "representativeId", "kind", "externalUserId", "status", "updatedAt"
)
VALUES (
  'rep_binding_telegram',
  'rep_channel_fixture',
  'TELEGRAM',
  'fixture-bot',
  'CONNECTED',
  CURRENT_TIMESTAMP
);

INSERT INTO "ConversationChannelBinding" (
  "id", "conversationId", "representativeBindingId", "kind",
  "externalConversationId", "externalThreadId", "updatedAt"
)
VALUES
  (
    'binding_safe',
    'conversation_safe',
    'rep_binding_telegram',
    'TELEGRAM',
    '100',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'binding_duplicate_one',
    'conversation_duplicate_one',
    'rep_binding_telegram',
    'TELEGRAM',
    'duplicate-chat',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'binding_duplicate_two',
    'conversation_duplicate_two',
    'rep_binding_telegram',
    'TELEGRAM',
    'duplicate-chat',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'binding_serialized_collision_one',
    'conversation_serialized_collision_one',
    'rep_binding_telegram',
    'TELEGRAM',
    'serialized:collision',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'binding_serialized_collision_two',
    'conversation_serialized_collision_two',
    'rep_binding_telegram',
    'TELEGRAM',
    'serialized',
    'collision:',
    CURRENT_TIMESTAMP
  );

INSERT INTO "PricingPlan" (
  "id", "representativeId", "type", "name", "starsAmount",
  "summary", "includedReplies", "updatedAt"
)
VALUES (
  'plan_safe',
  'rep_channel_fixture',
  'PASS',
  'Pass',
  100,
  'Fixture pass',
  5,
  CURRENT_TIMESTAMP
);

INSERT INTO "Invoice" (
  "id", "representativeId", "contactId", "conversationId",
  "planType", "title", "payload", "starsAmount",
  "telegramPaymentChargeId", "status", "paidAt", "updatedAt"
)
VALUES (
  'invoice_legacy_paid',
  'rep_channel_fixture',
  'contact_safe',
  'conversation_safe',
  'PASS',
  'Pass',
  'fixture:invoice:legacy-paid',
  100,
  'fixture_charge_unique',
  'PAID',
  CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP
),
(
  'invoice_duplicate_charge',
  'rep_channel_fixture',
  'contact_safe',
  'conversation_safe',
  'PASS',
  'Pass',
  'fixture:invoice:duplicate-charge',
  100,
  'fixture_charge_unique',
  'PAID',
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP
);
SQL

printf 'phase=assert_pre_deploy_gate_finds_ambiguities\n'
PRE_DEPLOY_REPORT="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/channel-identity-entitlements-deploy-blockers.sql"
)"
printf '%s\n' "$PRE_DEPLOY_REPORT"
printf '%s\n' "$PRE_DEPLOY_REPORT" | grep -F 'TELEGRAM_IDENTITY_CONFLICT' >/dev/null
printf '%s\n' "$PRE_DEPLOY_REPORT" | grep -F 'DUPLICATE_CHANNEL_COORDINATE' >/dev/null
printf '%s\n' "$PRE_DEPLOY_REPORT" | grep -F 'DUPLICATE_TELEGRAM_PAYMENT_CHARGE' >/dev/null
printf '%s\n' "$PRE_DEPLOY_REPORT" | grep -F 'SERIALIZED_CHANNEL_KEY_COLLISION' >/dev/null

# The fixture resolves the provider-evidence collision explicitly before
# deployment. Production operators must do the same from provider records.
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
UPDATE "Invoice"
SET
  "telegramPaymentChargeId" = 'fixture_charge_second',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'invoice_duplicate_charge';
SQL

printf 'phase=deploy_expansion_migration\n'
DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/mid/prisma/schema.prisma" >/dev/null

printf 'phase=insert_pre_issuer_matrix_links\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "IdentityLink" (
  "id", "audienceIdentityId", "provider", "providerSubject",
  "issuer", "updatedAt"
)
VALUES
  (
    'matrix_link_safe',
    'identity_matrix_safe',
    'MATRIX',
    '@Alice:EXAMPLE.ORG',
    'delegate',
    CURRENT_TIMESTAMP
  ),
  (
    'matrix_link_collision_upper',
    'identity_matrix_collision_upper',
    'MATRIX',
    '@Bob:EXAMPLE.ORG',
    'delegate',
    CURRENT_TIMESTAMP
  ),
  (
    'matrix_link_collision_lower',
    'identity_matrix_collision_lower',
    'MATRIX',
    '@Bob:example.org',
    'delegate',
    CURRENT_TIMESTAMP
  );
SQL

printf 'phase=deploy_safe_backfill\n'
if ! DATABASE_URL="$FIXTURE_DATABASE_URL" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma"; then
  printf 'phase=report_failed_migration\n' >&2
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 \
    --command \
      'SELECT migration_name, logs FROM "_prisma_migrations" WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1;' \
    >&2
  exit 1
fi

printf 'phase=insert_invalid_matrix_links_for_reconciliation\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "IdentityLink" (
  "id", "audienceIdentityId", "provider", "providerSubject",
  "issuer", "updatedAt"
)
VALUES
  (
    'matrix_link_invalid_port',
    'identity_matrix_invalid_port',
    'MATRIX',
    '@Invalid:matrix.example.org:70000',
    'matrix.example.org:70000',
    CURRENT_TIMESTAMP
  ),
  (
    'matrix_link_invalid_host',
    'identity_matrix_invalid_host',
    'MATRIX',
    '@Invalid:foo/bar',
    'foo/bar',
    CURRENT_TIMESTAMP
  );
SQL

printf 'phase=assert_safe_backfill_and_quarantine\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $fixture$
DECLARE
  safe_identity_id TEXT;
BEGIN
  SELECT contact."audienceIdentityId"
  INTO safe_identity_id
  FROM "Contact" AS contact
  WHERE contact."id" = 'contact_safe';

  IF safe_identity_id IS NULL THEN
    RAISE EXCEPTION 'safe Telegram contact did not receive an audience identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "IdentityLink"
    WHERE "provider" = 'TELEGRAM'
      AND "providerSubject" = '100'
      AND "audienceIdentityId" = safe_identity_id
      AND "assuranceLevel" = 'PLATFORM_VERIFIED'
      AND "revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'safe Telegram contact did not receive a verified identity link';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "UserWallet"
    WHERE "id" = 'wallet_safe' AND "audienceIdentityId" = safe_identity_id
  ) THEN
    RAISE EXCEPTION 'safe Telegram wallet did not inherit provider identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Conversation"
    WHERE "id" = 'conversation_safe'
      AND "audienceIdentityId" = safe_identity_id
      AND "sourceChannel" = 'telegram'
  ) THEN
    RAISE EXCEPTION 'safe Telegram conversation was not normalized';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "AgentTokenPurchase"
    WHERE "id" = 'purchase_safe' AND "audienceIdentityId" = safe_identity_id
  ) THEN
    RAISE EXCEPTION 'proven legacy purchase ownership was not propagated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "AgentUsageCharge"
    WHERE "id" = 'charge_safe'
      AND "audienceIdentityId" IS NULL
      AND "entitlementAccountId" IS NULL
      AND "conversationId" IS NULL
      AND "generationRunId" IS NULL
  ) THEN
    RAISE EXCEPTION 'unbound legacy usage charge acquired a partial authorization scope';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ConversationChannelBinding"
    WHERE "id" = 'binding_safe'
      AND "bindingKey" = 'TELEGRAM:rep_channel_fixture:100:'
      AND "transport" = 'TELEGRAM'
      AND "sourceProvider" = 'TELEGRAM'
  ) THEN
    RAISE EXCEPTION 'unambiguous channel binding did not receive its route and key';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ConversationChannelBinding"
    WHERE "id" IN ('binding_duplicate_one', 'binding_duplicate_two')
      AND "bindingKey" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'duplicate channel coordinate selected an arbitrary winner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ConversationChannelBinding"
    WHERE "id" IN (
      'binding_serialized_collision_one',
      'binding_serialized_collision_two'
    )
      AND "bindingKey" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'serialized channel key collision selected an arbitrary winner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Contact"
    WHERE "id" = 'contact_conflict'
      AND "audienceIdentityId" <> 'identity_conflict_contact'
  ) OR EXISTS (
    SELECT 1 FROM "UserWallet"
    WHERE "id" = 'wallet_conflict'
      AND "audienceIdentityId" <> 'identity_conflict_wallet'
  ) THEN
    RAISE EXCEPTION 'conflicting identity evidence was reassigned';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ServicePaymentOrder"
    WHERE "id" = 'service-payment:invoice_legacy_paid'
  ) THEN
    RAISE EXCEPTION 'legacy unmetered invoice was converted into guessed counted entitlement';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "IdentityLink"
    WHERE "id" = 'matrix_link_safe'
      AND "providerSubject" = '@Alice:example.org'
      AND "issuer" = 'example.org'
      AND "revokedAt" IS NOT NULL
      AND "proofMetadata"->>'matrixCaseRemediation' = 'rebind_required'
  ) THEN
    RAISE EXCEPTION 'case-normalized Matrix link was not revoked for explicit rebind';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "IdentityLink"
    WHERE "id" = 'matrix_link_collision_upper'
      AND "providerSubject" = '@Bob:EXAMPLE.ORG'
      AND "issuer" = 'delegate'
      AND "revokedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "IdentityLink"
    WHERE "id" = 'matrix_link_collision_lower'
      AND "providerSubject" = '@Bob:example.org'
      AND "issuer" = 'delegate'
      AND "revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'ambiguous legacy Matrix links selected an arbitrary winner';
  END IF;
END
$fixture$;
SQL

printf 'phase=replay_forward_remediation_sql\n'
# Prisma never reapplies an already-recorded migration. Replaying the immutable
# legacy backfill after later database invariants exist would manufacture an
# impossible migration order, so only prove that the new forward remediation is
# independently idempotent.
FORWARD_REMEDIATION_STATE_BEFORE="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command \
      "SELECT jsonb_build_object(
        'revokedAt', \"revokedAt\",
        'proofMetadata', \"proofMetadata\",
        'updatedAt', \"updatedAt\"
      )::text
      FROM \"IdentityLink\"
      WHERE \"id\" = 'matrix_link_safe';"
)"
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture \
  -X --set ON_ERROR_STOP=1 --file - \
  < "$REPO_ROOT/prisma/migrations/20260723231500_channel_identity_safe_forward_remediation/migration.sql" \
  >/dev/null
FORWARD_REMEDIATION_STATE_AFTER="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command \
      "SELECT jsonb_build_object(
        'revokedAt', \"revokedAt\",
        'proofMetadata', \"proofMetadata\",
        'updatedAt', \"updatedAt\"
      )::text
      FROM \"IdentityLink\"
      WHERE \"id\" = 'matrix_link_safe';"
)"
if [[ "$FORWARD_REMEDIATION_STATE_AFTER" != "$FORWARD_REMEDIATION_STATE_BEFORE" ]]; then
  printf 'Forward remediation replay mutated an already-remediated Matrix link.\n' >&2
  exit 1
fi

printf 'phase=assert_post_deploy_report\n'
POST_DEPLOY_REPORT="$(
  docker exec -i "$FIXTURE_CONTAINER" \
    psql -U postgres -d delegate_fixture \
    -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
    < "$REPO_ROOT/prisma/preflight/channel-identity-entitlements-conflicts.sql"
)"
printf '%s\n' "$POST_DEPLOY_REPORT"
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'TELEGRAM_IDENTITY_CONFLICT' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'DUPLICATE_CHANNEL_COORDINATE' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'SERIALIZED_CHANNEL_KEY_COLLISION' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'LEGACY_INVOICE_ENTITLEMENT_DECISION_REQUIRED' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'REVOKED_MATRIX_LINK_REQUIRES_RELINK' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'MATRIX_LINK_DEFAULT_ISSUER' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'MATRIX_LINK_INVALID_FULL_MXID' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'matrix_link_invalid_port' >/dev/null
printf '%s\n' "$POST_DEPLOY_REPORT" | grep -F 'matrix_link_invalid_host' >/dev/null

printf 'phase=assert_reconciliation_sql_executes\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_fixture \
  -X --quiet --set ON_ERROR_STOP=1 --csv --pset footer=off --file - \
  < "$REPO_ROOT/prisma/preflight/channel-identity-entitlements-reconciliation.sql"

printf 'result=channel_identity_entitlements_migration_fixture_passed\n'
