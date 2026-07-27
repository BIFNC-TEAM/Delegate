#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/delegate-wallet-migration.XXXXXX)"
FIXTURE_CONTAINER="delegate-wallet-migration-$$"
FIXTURE_CONTAINER_STARTED="false"

cleanup() {
  if [[ "$FIXTURE_CONTAINER_STARTED" == "true" ]]; then
    docker stop "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
  fi

  if [[ -d "$FIXTURE_ROOT" && "$FIXTURE_ROOT" == /tmp/delegate-wallet-migration.* ]]; then
    find "$FIXTURE_ROOT" -depth -delete
  fi
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the disposable PostgreSQL 16 wallet migration fixture.\n' >&2
  exit 2
}
command -v pnpm >/dev/null 2>&1 || {
  printf 'pnpm is required for the wallet migration fixture.\n' >&2
  exit 2
}
command -v rg >/dev/null 2>&1 || {
  printf 'ripgrep is required for the wallet migration fixture.\n' >&2
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
  MIGRATION_NAME="${MIGRATION_DIR##*/}"
  cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/full/prisma/migrations/$MIGRATION_NAME"
  if [[ "$MIGRATION_NAME" < "20260723230000_wallet_transaction_scoped_balances" ]]; then
    cp -R "$MIGRATION_DIR" "$FIXTURE_ROOT/pre/prisma/migrations/$MIGRATION_NAME"
  fi
done

docker run \
  --rm \
  --detach \
  --name "$FIXTURE_CONTAINER" \
  --env POSTGRES_PASSWORD=wallet_fixture_only \
  --env POSTGRES_DB=delegate_wallet_ok \
  --publish 127.0.0.1::5432 \
  --health-cmd='pg_isready -U postgres -d delegate_wallet_ok' \
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

database_url() {
  local database_name="$1"
  printf 'postgresql://postgres:wallet_fixture_only@127.0.0.1:%s/%s' \
    "$FIXTURE_PORT" \
    "$database_name"
}

deploy_stage() {
  local database_name="$1"
  local stage="$2"
  DATABASE_URL="$(database_url "$database_name")" \
    pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
    --schema "$FIXTURE_ROOT/$stage/prisma/schema.prisma" >/dev/null
}

insert_legacy_wallet_fixture() {
  local database_name="$1"
  local projected_balance="$2"
  docker exec -i "$FIXTURE_CONTAINER" \
    psql \
    -U postgres \
    -d "$database_name" \
    -X \
    --set ON_ERROR_STOP=1 \
    --set "projected_balance=$projected_balance" <<'SQL' >/dev/null
INSERT INTO "Owner" (
    "id",
    "displayName",
    "creatorVerificationStatus",
    "updatedAt"
)
VALUES (
    'owner_wallet_fixture',
    'Wallet Fixture Owner',
    'VERIFIED',
    CURRENT_TIMESTAMP
);

INSERT INTO "Representative" (
    "id",
    "ownerId",
    "slug",
    "displayName",
    "roleSummary",
    "tone",
    "allowedSkills",
    "actionGate",
    "languages",
    "freeScope",
    "paywalledIntents",
    "handoffPrompt",
    "updatedAt"
)
VALUES (
    'representative_wallet_fixture',
    'owner_wallet_fixture',
    'wallet-fixture',
    'Wallet Fixture',
    'fixture',
    'neutral',
    '[]'::JSONB,
    '{}'::JSONB,
    '["en"]'::JSONB,
    '{}'::JSONB,
    '[]'::JSONB,
    'fixture',
    CURRENT_TIMESTAMP
);

INSERT INTO "UserWallet" (
    "id",
    "externalUserId",
    "currency",
    "cashBalanceCents",
    "updatedAt"
)
VALUES (
    'user_wallet_fixture',
    'wallet-fixture-user',
    'CNY',
    0,
    CURRENT_TIMESTAMP
);

INSERT INTO "AgentWallet" (
    "id",
    "representativeId",
    "currency",
    "tokenBalance",
    "totalPurchasedTokens",
    "totalConsumedTokens",
    "tokenUnitPriceCents",
    "creatorRevenueShareBps",
    "updatedAt"
)
VALUES (
    'agent_wallet_fixture',
    'representative_wallet_fixture',
    'CNY',
    :projected_balance,
    100,
    40,
    1,
    2000,
    CURRENT_TIMESTAMP
);

INSERT INTO "AgentTokenPurchase" (
    "id",
    "userWalletId",
    "agentWalletId",
    "representativeId",
    "amountCents",
    "currency",
    "tokenAmount",
    "tokenUnitPriceCents",
    "creatorRevenueShareBps",
    "creatorPendingCents",
    "status",
    "idempotencyKey",
    "updatedAt"
)
VALUES (
    'purchase_wallet_fixture',
    'user_wallet_fixture',
    'agent_wallet_fixture',
    'representative_wallet_fixture',
    100,
    'CNY',
    100,
    1,
    2000,
    20,
    'COMPLETED',
    'purchase_wallet_fixture',
    CURRENT_TIMESTAMP
);

INSERT INTO "AgentUsageCharge" (
    "id",
    "agentWalletId",
    "representativeId",
    "tokenPurchaseId",
    "kind",
    "status",
    "quantity",
    "tokenAmount",
    "providerCostCents",
    "platformRevenueCents",
    "currency",
    "idempotencyKey",
    "updatedAt"
)
VALUES (
    'usage_wallet_fixture',
    'agent_wallet_fixture',
    'representative_wallet_fixture',
    'purchase_wallet_fixture',
    'FIXED_TASK',
    'APPLIED',
    1,
    40,
    0,
    32,
    'CNY',
    'usage_wallet_fixture',
    CURRENT_TIMESTAMP
);

INSERT INTO "CreatorEarning" (
    "id",
    "ownerId",
    "representativeId",
    "agentWalletId",
    "tokenPurchaseId",
    "status",
    "pendingCents",
    "withdrawableCents",
    "frozenCents",
    "withdrawnCents",
    "currency",
    "revenueShareBps",
    "idempotencyKey",
    "updatedAt"
)
VALUES
(
    'earning_pending_wallet_fixture',
    'owner_wallet_fixture',
    'representative_wallet_fixture',
    'agent_wallet_fixture',
    'purchase_wallet_fixture',
    'PENDING',
    12,
    0,
    0,
    0,
    'CNY',
    2000,
    'earning_pending_wallet_fixture',
    CURRENT_TIMESTAMP
),
(
    'earning_released_wallet_fixture',
    'owner_wallet_fixture',
    'representative_wallet_fixture',
    'agent_wallet_fixture',
    'purchase_wallet_fixture',
    'WITHDRAWABLE',
    0,
    8,
    0,
    0,
    'CNY',
    2000,
    'earning_released_wallet_fixture',
    CURRENT_TIMESTAMP
);
SQL
}

printf 'phase=deploy_pre_wallet_migrations\n'
deploy_stage "delegate_wallet_ok" "pre"

printf 'phase=insert_reconcilable_legacy_wallet\n'
insert_legacy_wallet_fixture "delegate_wallet_ok" "60"

printf 'phase=deploy_wallet_migration\n'
deploy_stage "delegate_wallet_ok" "full"

printf 'phase=verify_scoped_wallet_backfill\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_wallet_ok -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $verify$
DECLARE
    scoped_wallet "UserAgentWallet"%ROWTYPE;
    purchase "AgentTokenPurchase"%ROWTYPE;
    usage "AgentUsageCharge"%ROWTYPE;
BEGIN
    SELECT *
    INTO STRICT scoped_wallet
    FROM "UserAgentWallet"
    WHERE
        "userWalletId" = 'user_wallet_fixture'
        AND "agentWalletId" = 'agent_wallet_fixture'
        AND "currency" = 'CNY';

    IF
        scoped_wallet."availableTokenAmount" <> 60
        OR scoped_wallet."reservedTokenAmount" <> 0
        OR scoped_wallet."totalPurchasedTokenAmount" <> 100
        OR scoped_wallet."totalConsumedTokenAmount" <> 40
    THEN
        RAISE EXCEPTION 'scoped wallet backfill does not match legacy projections';
    END IF;

    SELECT *
    INTO STRICT purchase
    FROM "AgentTokenPurchase"
    WHERE "id" = 'purchase_wallet_fixture';
    IF
        purchase."userAgentWalletId" <> scoped_wallet."id"
        OR purchase."remainingTokenAmount" <> 60
    THEN
        RAISE EXCEPTION 'purchase lot was not linked or reconstructed';
    END IF;

    SELECT *
    INTO STRICT usage
    FROM "AgentUsageCharge"
    WHERE "id" = 'usage_wallet_fixture';
    IF
        usage."userAgentWalletId" <> scoped_wallet."id"
        OR usage."reservedTokenAmount" <> 40
        OR usage."settledTokenAmount" <> 40
        OR usage."releasedTokenAmount" <> 0
        OR usage."reservedAt" IS NULL
        OR usage."settledAt" IS NULL
    THEN
        RAISE EXCEPTION 'legacy usage lifecycle was not reconstructed';
    END IF;
END
$verify$;
SQL

printf 'phase=verify_wallet_database_invariants\n'
docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_wallet_ok -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $verify$
DECLARE
    validated_constraint_count INTEGER;
    rejected BOOLEAN;
BEGIN
    SELECT COUNT(*)
    INTO validated_constraint_count
    FROM pg_constraint
    WHERE
        conname IN (
            'UserAgentWallet_available_nonnegative',
            'UserAgentWallet_reserved_nonnegative',
            'UserAgentWallet_purchased_nonnegative',
            'UserAgentWallet_consumed_nonnegative',
            'UserAgentWallet_balance_conservation',
            'AgentUsageCharge_reserved_nonnegative',
            'AgentUsageCharge_settled_nonnegative',
            'AgentUsageCharge_released_nonnegative',
            'AgentUsageCharge_reservation_bounds',
            'UserWallet_cash_balance_nonnegative',
            'CreatorEarning_buckets_nonnegative',
            'CreatorEarning_terminal_bucket_consistency',
            'AgentUsageCharge_positive_dimensions',
            'AgentUsageCharge_costs_nonnegative',
            'AgentUsageCharge_status_amount_consistency',
            'WithdrawRequest_amount_positive',
            'WithdrawRequest_status_payout_consistency'
        )
        AND contype = 'c'
        AND convalidated;
    IF validated_constraint_count <> 17 THEN
        RAISE EXCEPTION
            'expected 17 validated wallet CHECK constraints, found %',
            validated_constraint_count;
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "UserWallet"
        SET "cashBalanceCents" = -1
        WHERE "id" = 'user_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'negative user cash balance was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "UserAgentWallet"
        SET "availableTokenAmount" = -1
        WHERE "userWalletId" = 'user_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'negative scoped-wallet bucket was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "UserAgentWallet"
        SET "totalPurchasedTokenAmount" = 101
        WHERE "userWalletId" = 'user_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'scoped-wallet conservation mismatch was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "CreatorEarning"
        SET "pendingCents" = -1
        WHERE "id" = 'earning_pending_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'negative creator bucket was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "CreatorEarning"
        SET "status" = 'REVERSED'
        WHERE "id" = 'earning_pending_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'reversed creator earning retained live funds';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "AgentUsageCharge"
        SET
            "status" = 'SETTLED',
            "settledTokenAmount" = 39
        WHERE "id" = 'usage_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'settled usage charge with unaccounted tokens was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "AgentUsageCharge"
        SET "status" = 'CREATED'
        WHERE "id" = 'usage_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'created usage charge with non-zero lifecycle buckets was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        UPDATE "AgentUsageCharge"
        SET "status" = 'REVERSED'
        WHERE "id" = 'usage_wallet_fixture';
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'reversed usage charge with non-zero lifecycle buckets was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        INSERT INTO "WithdrawRequest" (
            "id",
            "ownerId",
            "status",
            "amountCents",
            "idempotencyKey",
            "updatedAt"
        )
        VALUES (
            'withdraw_zero_wallet_fixture',
            'owner_wallet_fixture',
            'PENDING_REVIEW',
            0,
            'withdraw_zero_wallet_fixture',
            CURRENT_TIMESTAMP
        );
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'zero-value withdrawal request was accepted';
    END IF;

    rejected := FALSE;
    BEGIN
        INSERT INTO "WithdrawRequest" (
            "id",
            "ownerId",
            "status",
            "amountCents",
            "idempotencyKey",
            "updatedAt"
        )
        VALUES (
            'withdraw_incomplete_paid_wallet_fixture',
            'owner_wallet_fixture',
            'PAID',
            1,
            'withdraw_incomplete_paid_wallet_fixture',
            CURRENT_TIMESTAMP
        );
    EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'paid withdrawal without payout facts was accepted';
    END IF;

    -- Valid terminal states remain representable.
    UPDATE "CreatorEarning"
    SET
        "status" = 'WITHDRAWN',
        "withdrawableCents" = 0,
        "withdrawnCents" = 8
    WHERE "id" = 'earning_released_wallet_fixture';

    INSERT INTO "WithdrawRequest" (
        "id",
        "ownerId",
        "representativeId",
        "status",
        "amountCents",
        "paidAt",
        "provider",
        "providerPayoutId",
        "idempotencyKey",
        "updatedAt"
    )
    VALUES (
        'withdraw_paid_wallet_fixture',
        'owner_wallet_fixture',
        'representative_wallet_fixture',
        'PAID',
        8,
        CURRENT_TIMESTAMP,
        'MOCK',
        'payout_wallet_fixture',
        'withdraw_paid_wallet_fixture',
        CURRENT_TIMESTAMP
    );
END
$verify$;
SQL

printf 'phase=create_inconsistent_fixture_database\n'
docker exec "$FIXTURE_CONTAINER" \
  psql -U postgres -d postgres -X --set ON_ERROR_STOP=1 \
  --command='CREATE DATABASE delegate_wallet_bad' >/dev/null
deploy_stage "delegate_wallet_bad" "pre"
insert_legacy_wallet_fixture "delegate_wallet_bad" "61"

printf 'phase=verify_preflight_fails_before_schema_changes\n'
set +e
DATABASE_URL="$(database_url "delegate_wallet_bad")" \
  pnpm --dir "$REPO_ROOT" exec prisma migrate deploy \
  --schema "$FIXTURE_ROOT/full/prisma/schema.prisma" \
  >"$FIXTURE_ROOT/expected-preflight-error.log" 2>&1
PREFLIGHT_STATUS="$?"
set -e

if [[ "$PREFLIGHT_STATUS" -eq 0 ]]; then
  printf 'The inconsistent legacy fixture unexpectedly passed wallet preflight.\n' >&2
  exit 4
fi
if ! rg -q \
  'reconstructed purchase-lot balance does not match AgentWallet.tokenBalance' \
  "$FIXTURE_ROOT/expected-preflight-error.log"; then
  sed -n '1,160p' "$FIXTURE_ROOT/expected-preflight-error.log" >&2
  exit 5
fi

docker exec -i "$FIXTURE_CONTAINER" \
  psql -U postgres -d delegate_wallet_bad -X --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $verify$
BEGIN
    IF to_regclass('"UserAgentWallet"') IS NOT NULL THEN
        RAISE EXCEPTION 'wallet preflight changed the schema before rejecting inconsistent data';
    END IF;
END
$verify$;
SQL

printf 'wallet_scoped_migration_fixture=passed\n'
