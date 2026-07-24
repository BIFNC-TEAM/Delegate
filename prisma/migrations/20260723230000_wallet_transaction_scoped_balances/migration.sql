-- Fail before changing the schema when legacy wallet projections cannot be
-- reconstructed exactly. These checks intentionally require an explicit
-- reconciliation instead of silently inventing or discarding paid credits.
DO $wallet_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "AgentUsageCharge" AS usage
        WHERE
            usage."status" = 'APPLIED'
            AND (
                usage."tokenPurchaseId" IS NULL
                OR usage."tokenAmount" <= 0
            )
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: APPLIED usage must reference a purchase and have a positive token amount';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "AgentTokenPurchase" AS purchase
        JOIN "AgentWallet" AS agent_wallet
            ON agent_wallet."id" = purchase."agentWalletId"
        JOIN "UserWallet" AS user_wallet
            ON user_wallet."id" = purchase."userWalletId"
        WHERE
            purchase."tokenAmount" <= 0
            OR purchase."amountCents" <= 0
            OR purchase."currency" <> agent_wallet."currency"
            OR purchase."currency" <> user_wallet."currency"
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: purchase amounts or wallet currencies are inconsistent';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "AgentUsageCharge" AS usage
        JOIN "AgentTokenPurchase" AS purchase
            ON purchase."id" = usage."tokenPurchaseId"
        WHERE
            usage."status" = 'APPLIED'
            AND (
                usage."agentWalletId" <> purchase."agentWalletId"
                OR usage."representativeId" <> purchase."representativeId"
                OR usage."currency" <> purchase."currency"
            )
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: APPLIED usage is linked to a purchase in a different wallet scope';
    END IF;

    IF EXISTS (
        WITH applied_usage AS (
            SELECT
                usage."tokenPurchaseId",
                SUM(usage."tokenAmount")::BIGINT AS "consumedTokenAmount"
            FROM "AgentUsageCharge" AS usage
            WHERE usage."status" = 'APPLIED'
            GROUP BY usage."tokenPurchaseId"
        )
        SELECT 1
        FROM "AgentTokenPurchase" AS purchase
        JOIN applied_usage
            ON applied_usage."tokenPurchaseId" = purchase."id"
        WHERE
            purchase."status" <> 'COMPLETED'
            OR applied_usage."consumedTokenAmount" > purchase."tokenAmount"::BIGINT
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: purchase usage exceeds its lot or belongs to a non-completed purchase';
    END IF;

    IF EXISTS (
        WITH applied_usage AS (
            SELECT
                usage."tokenPurchaseId",
                SUM(usage."tokenAmount")::BIGINT AS "consumedTokenAmount"
            FROM "AgentUsageCharge" AS usage
            WHERE usage."status" = 'APPLIED'
            GROUP BY usage."tokenPurchaseId"
        ),
        reconstructed_balance AS (
            SELECT
                purchase."agentWalletId",
                purchase."currency",
                SUM(
                    CASE
                        WHEN purchase."status" = 'COMPLETED'
                            THEN purchase."tokenAmount"::BIGINT
                                - COALESCE(
                                    applied_usage."consumedTokenAmount",
                                    0::BIGINT
                                )
                        ELSE 0::BIGINT
                    END
                ) AS "availableTokenAmount"
            FROM "AgentTokenPurchase" AS purchase
            LEFT JOIN applied_usage
                ON applied_usage."tokenPurchaseId" = purchase."id"
            GROUP BY purchase."agentWalletId", purchase."currency"
        )
        SELECT 1
        FROM "AgentWallet" AS agent_wallet
        LEFT JOIN reconstructed_balance
            ON reconstructed_balance."agentWalletId" = agent_wallet."id"
            AND reconstructed_balance."currency" = agent_wallet."currency"
        WHERE
            agent_wallet."tokenBalance"::BIGINT
            <> COALESCE(
                reconstructed_balance."availableTokenAmount",
                0::BIGINT
            )
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: reconstructed purchase-lot balance does not match AgentWallet.tokenBalance';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "AgentWallet" AS agent_wallet
        WHERE
            agent_wallet."tokenBalance" < 0
            OR agent_wallet."totalPurchasedTokens" < 0
            OR agent_wallet."totalConsumedTokens" < 0
            OR agent_wallet."totalPurchasedTokens"
                - agent_wallet."totalConsumedTokens"
                <> agent_wallet."tokenBalance"
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: AgentWallet aggregate counters are inconsistent';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "CreatorEarning" AS earning
        JOIN "AgentTokenPurchase" AS purchase
            ON purchase."id" = earning."tokenPurchaseId"
        JOIN "Representative" AS representative
            ON representative."id" = purchase."representativeId"
        WHERE
            earning."ownerId" <> representative."ownerId"
            OR earning."representativeId" <> purchase."representativeId"
            OR earning."agentWalletId" <> purchase."agentWalletId"
            OR earning."currency" <> purchase."currency"
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: creator earnings are linked to a different owner or wallet scope';
    END IF;

    IF EXISTS (
        WITH applied_usage AS (
            SELECT
                usage."tokenPurchaseId",
                SUM(usage."tokenAmount")::BIGINT AS "consumedTokenAmount"
            FROM "AgentUsageCharge" AS usage
            WHERE usage."status" = 'APPLIED'
            GROUP BY usage."tokenPurchaseId"
        ),
        pending_earnings AS (
            SELECT
                earning."tokenPurchaseId",
                SUM(earning."pendingCents")::BIGINT AS "pendingCents"
            FROM "CreatorEarning" AS earning
            WHERE earning."tokenPurchaseId" IS NOT NULL
            GROUP BY earning."tokenPurchaseId"
        )
        SELECT 1
        FROM "AgentTokenPurchase" AS purchase
        LEFT JOIN applied_usage
            ON applied_usage."tokenPurchaseId" = purchase."id"
        LEFT JOIN pending_earnings
            ON pending_earnings."tokenPurchaseId" = purchase."id"
        WHERE
            purchase."status" = 'COMPLETED'
            AND COALESCE(pending_earnings."pendingCents", 0::BIGINT)
                <> purchase."creatorPendingCents"::BIGINT
                    - (
                        purchase."creatorPendingCents"::BIGINT
                        * COALESCE(
                            applied_usage."consumedTokenAmount",
                            0::BIGINT
                        )
                    ) / purchase."tokenAmount"::BIGINT
    ) THEN
        RAISE EXCEPTION
            'wallet migration preflight failed: creator pending earnings require a rounding reconciliation';
    END IF;
END
$wallet_preflight$;

-- ExtendEnum
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'SERVICE_CREDIT_DEFERRED';
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'CREATOR_FROZEN';
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'PLATFORM_DEFERRED_REVENUE';
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'PLATFORM_EARNED_REVENUE';
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'EXTERNAL_SETTLEMENT';
ALTER TYPE "AmnWalletAccountType" ADD VALUE 'PAYOUT_CLEARING';

-- ExtendEnum
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'SERVICE_CREDIT_RESERVE';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'SERVICE_CREDIT_SETTLE';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'SERVICE_CREDIT_RELEASE';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'CREATOR_FROZEN_CREDIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'CREATOR_FROZEN_DEBIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'PLATFORM_DEFERRED_REVENUE_CREDIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'PLATFORM_DEFERRED_REVENUE_DEBIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'PLATFORM_EARNED_REVENUE_CREDIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'EXTERNAL_SETTLEMENT_CREDIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'EXTERNAL_SETTLEMENT_DEBIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'PAYOUT_CLEARING_CREDIT';
ALTER TYPE "AmnLedgerEntryKind" ADD VALUE 'PAYOUT_CLEARING_DEBIT';

-- CreateEnum
CREATE TYPE "WalletTransactionEventType" AS ENUM (
    'USER_RECHARGE',
    'AGENT_TOKEN_PURCHASE',
    'USAGE_RESERVATION',
    'USAGE_SETTLEMENT',
    'USAGE_RELEASE',
    'CREATOR_EARNING_RELEASE',
    'WITHDRAWAL_REQUEST',
    'WITHDRAWAL_PAYOUT',
    'REFUND',
    'REVERSAL',
    'ADJUSTMENT'
);

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'REVERSED',
    'CANCELED'
);

-- ExtendEnum
ALTER TYPE "AgentUsageChargeStatus" ADD VALUE 'RESERVED';
ALTER TYPE "AgentUsageChargeStatus" ADD VALUE 'SETTLED';
ALTER TYPE "AgentUsageChargeStatus" ADD VALUE 'RELEASED';
ALTER TYPE "AgentUsageChargeStatus" ADD VALUE 'FAILED';

-- CreateTable
CREATE TABLE "UserAgentWallet" (
    "id" TEXT NOT NULL,
    "userWalletId" TEXT NOT NULL,
    "agentWalletId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "availableTokenAmount" INTEGER NOT NULL DEFAULT 0,
    "reservedTokenAmount" INTEGER NOT NULL DEFAULT 0,
    "totalPurchasedTokenAmount" INTEGER NOT NULL DEFAULT 0,
    "totalConsumedTokenAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAgentWallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserAgentWallet_available_nonnegative" CHECK ("availableTokenAmount" >= 0),
    CONSTRAINT "UserAgentWallet_reserved_nonnegative" CHECK ("reservedTokenAmount" >= 0),
    CONSTRAINT "UserAgentWallet_purchased_nonnegative" CHECK ("totalPurchasedTokenAmount" >= 0),
    CONSTRAINT "UserAgentWallet_consumed_nonnegative" CHECK ("totalConsumedTokenAmount" >= 0),
    CONSTRAINT "UserAgentWallet_balance_conservation" CHECK (
        "availableTokenAmount"
        + "reservedTokenAmount"
        + "totalConsumedTokenAmount"
        = "totalPurchasedTokenAmount"
    )
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "eventGroupId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "eventType" "WalletTransactionEventType" NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "ownerId" TEXT,
    "representativeId" TEXT,
    "userWalletId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "WalletLedgerEntry"
    ADD COLUMN "transactionId" TEXT,
    ADD COLUMN "userAgentWalletId" TEXT;

-- AlterTable
ALTER TABLE "AgentTokenPurchase"
    ADD COLUMN "userAgentWalletId" TEXT,
    ADD COLUMN "remainingTokenAmount" INTEGER;

-- AlterTable
ALTER TABLE "AgentUsageCharge"
    ADD COLUMN "userAgentWalletId" TEXT,
    ADD COLUMN "reservedTokenAmount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "settledTokenAmount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "releasedTokenAmount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "reservedAt" TIMESTAMP(3),
    ADD COLUMN "settledAt" TIMESTAMP(3),
    ADD COLUMN "releasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentUsageAllocation" (
    "id" TEXT NOT NULL,
    "usageChargeId" TEXT NOT NULL,
    "tokenPurchaseId" TEXT NOT NULL,
    "creatorEarningId" TEXT,
    "tokenAmount" INTEGER NOT NULL,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "creatorReleaseCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "releasedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentUsageAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentUsageAllocation_token_positive" CHECK ("tokenAmount" > 0),
    CONSTRAINT "AgentUsageAllocation_value_nonnegative" CHECK ("valueCents" >= 0),
    CONSTRAINT "AgentUsageAllocation_creator_nonnegative" CHECK ("creatorReleaseCents" >= 0)
);

-- CreateTable
CREATE TABLE "WithdrawalAllocation" (
    "id" TEXT NOT NULL,
    "withdrawRequestId" TEXT NOT NULL,
    "creatorEarningId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "releasedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WithdrawalAllocation_amount_positive" CHECK ("amountCents" > 0)
);

-- AddCheckConstraint
ALTER TABLE "AgentTokenPurchase"
    ADD CONSTRAINT "AgentTokenPurchase_remaining_bounds"
    CHECK (
        "remainingTokenAmount" IS NULL
        OR (
            "remainingTokenAmount" >= 0
            AND "remainingTokenAmount" <= "tokenAmount"
        )
    ) NOT VALID;

-- AddCheckConstraint
ALTER TABLE "AgentWallet"
    ADD CONSTRAINT "AgentWallet_token_balance_nonnegative"
    CHECK ("tokenBalance" >= 0) NOT VALID,
    ADD CONSTRAINT "AgentWallet_purchase_total_nonnegative"
    CHECK ("totalPurchasedTokens" >= 0) NOT VALID,
    ADD CONSTRAINT "AgentWallet_consumption_total_nonnegative"
    CHECK ("totalConsumedTokens" >= 0) NOT VALID,
    ADD CONSTRAINT "AgentWallet_balance_conservation"
    CHECK (
        "totalPurchasedTokens" - "totalConsumedTokens" = "tokenBalance"
    ) NOT VALID;

-- AddCheckConstraint
ALTER TABLE "AgentUsageCharge"
    ADD CONSTRAINT "AgentUsageCharge_reserved_nonnegative"
    CHECK ("reservedTokenAmount" >= 0),
    ADD CONSTRAINT "AgentUsageCharge_settled_nonnegative"
    CHECK ("settledTokenAmount" >= 0),
    ADD CONSTRAINT "AgentUsageCharge_released_nonnegative"
    CHECK ("releasedTokenAmount" >= 0),
    ADD CONSTRAINT "AgentUsageCharge_reservation_bounds"
    CHECK (
        "settledTokenAmount" + "releasedTokenAmount"
        <= "reservedTokenAmount"
    ) NOT VALID;

-- CreateIndex
CREATE UNIQUE INDEX "UserAgentWallet_userWalletId_agentWalletId_currency_key"
    ON "UserAgentWallet"("userWalletId", "agentWalletId", "currency");

-- CreateIndex
CREATE INDEX "UserAgentWallet_agentWalletId_currency_updatedAt_idx"
    ON "UserAgentWallet"("agentWalletId", "currency", "updatedAt");

-- CreateIndex
CREATE INDEX "UserAgentWallet_userWalletId_currency_updatedAt_idx"
    ON "UserAgentWallet"("userWalletId", "currency", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_eventGroupId_key"
    ON "WalletTransaction"("eventGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key"
    ON "WalletTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletTransaction_sourceType_sourceId_idx"
    ON "WalletTransaction"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "WalletTransaction_ownerId_status_occurredAt_idx"
    ON "WalletTransaction"("ownerId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_representativeId_status_occurredAt_idx"
    ON "WalletTransaction"("representativeId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_userWalletId_status_occurredAt_idx"
    ON "WalletTransaction"("userWalletId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_eventType_status_occurredAt_idx"
    ON "WalletTransaction"("eventType", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_currency_occurredAt_idx"
    ON "WalletTransaction"("currency", "occurredAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_transactionId_createdAt_idx"
    ON "WalletLedgerEntry"("transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_userAgentWalletId_createdAt_idx"
    ON "WalletLedgerEntry"("userAgentWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTokenPurchase_userAgentWalletId_status_createdAt_idx"
    ON "AgentTokenPurchase"("userAgentWalletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentUsageCharge_userAgentWalletId_status_createdAt_idx"
    ON "AgentUsageCharge"("userAgentWalletId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentUsageAllocation_usageChargeId_tokenPurchaseId_key"
    ON "AgentUsageAllocation"("usageChargeId", "tokenPurchaseId");

-- CreateIndex
CREATE INDEX "AgentUsageAllocation_tokenPurchaseId_createdAt_idx"
    ON "AgentUsageAllocation"("tokenPurchaseId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentUsageAllocation_creatorEarningId_createdAt_idx"
    ON "AgentUsageAllocation"("creatorEarningId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalAllocation_withdrawRequestId_creatorEarningId_key"
    ON "WithdrawalAllocation"("withdrawRequestId", "creatorEarningId");

-- CreateIndex
CREATE INDEX "WithdrawalAllocation_creatorEarningId_createdAt_idx"
    ON "WithdrawalAllocation"("creatorEarningId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserAgentWallet"
    ADD CONSTRAINT "UserAgentWallet_userWalletId_fkey"
    FOREIGN KEY ("userWalletId") REFERENCES "UserWallet"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAgentWallet"
    ADD CONSTRAINT "UserAgentWallet_agentWalletId_fkey"
    FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction"
    ADD CONSTRAINT "WalletTransaction_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "Owner"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction"
    ADD CONSTRAINT "WalletTransaction_representativeId_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction"
    ADD CONSTRAINT "WalletTransaction_userWalletId_fkey"
    FOREIGN KEY ("userWalletId") REFERENCES "UserWallet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry"
    ADD CONSTRAINT "WalletLedgerEntry_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "WalletTransaction"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry"
    ADD CONSTRAINT "WalletLedgerEntry_userAgentWalletId_fkey"
    FOREIGN KEY ("userAgentWalletId") REFERENCES "UserAgentWallet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenPurchase"
    ADD CONSTRAINT "AgentTokenPurchase_userAgentWalletId_fkey"
    FOREIGN KEY ("userAgentWalletId") REFERENCES "UserAgentWallet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageCharge"
    ADD CONSTRAINT "AgentUsageCharge_userAgentWalletId_fkey"
    FOREIGN KEY ("userAgentWalletId") REFERENCES "UserAgentWallet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageAllocation"
    ADD CONSTRAINT "AgentUsageAllocation_usageChargeId_fkey"
    FOREIGN KEY ("usageChargeId") REFERENCES "AgentUsageCharge"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageAllocation"
    ADD CONSTRAINT "AgentUsageAllocation_tokenPurchaseId_fkey"
    FOREIGN KEY ("tokenPurchaseId") REFERENCES "AgentTokenPurchase"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageAllocation"
    ADD CONSTRAINT "AgentUsageAllocation_creatorEarningId_fkey"
    FOREIGN KEY ("creatorEarningId") REFERENCES "CreatorEarning"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalAllocation"
    ADD CONSTRAINT "WithdrawalAllocation_withdrawRequestId_fkey"
    FOREIGN KEY ("withdrawRequestId") REFERENCES "WithdrawRequest"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalAllocation"
    ADD CONSTRAINT "WithdrawalAllocation_creatorEarningId_fkey"
    FOREIGN KEY ("creatorEarningId") REFERENCES "CreatorEarning"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill
-- Historical purchases were already scoped by userWalletId + agentWalletId,
-- even though their spendable balance was projected only on AgentWallet.
-- Materialize that ownership before the application switches reads to
-- UserAgentWallet so an upgrade never makes paid credits disappear.
INSERT INTO "UserAgentWallet" (
    "id",
    "userWalletId",
    "agentWalletId",
    "currency",
    "availableTokenAmount",
    "reservedTokenAmount",
    "totalPurchasedTokenAmount",
    "totalConsumedTokenAmount",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy_uaw_' || md5(
        purchase."userWalletId" || ':' ||
        purchase."agentWalletId" || ':' ||
        purchase."currency"
    ),
    purchase."userWalletId",
    purchase."agentWalletId",
    purchase."currency",
    0,
    0,
    0,
    0,
    MIN(purchase."createdAt"),
    CURRENT_TIMESTAMP
FROM "AgentTokenPurchase" AS purchase
GROUP BY
    purchase."userWalletId",
    purchase."agentWalletId",
    purchase."currency"
ON CONFLICT ("userWalletId", "agentWalletId", "currency") DO NOTHING;

UPDATE "AgentTokenPurchase" AS purchase
SET "userAgentWalletId" = scoped_wallet."id"
FROM "UserAgentWallet" AS scoped_wallet
WHERE
    scoped_wallet."userWalletId" = purchase."userWalletId"
    AND scoped_wallet."agentWalletId" = purchase."agentWalletId"
    AND scoped_wallet."currency" = purchase."currency"
    AND purchase."userAgentWalletId" IS NULL;

WITH historical_usage AS (
    SELECT
        usage."tokenPurchaseId",
        COALESCE(SUM(usage."tokenAmount"), 0)::INTEGER AS "consumedTokenAmount"
    FROM "AgentUsageCharge" AS usage
    WHERE
        usage."tokenPurchaseId" IS NOT NULL
        AND usage."status" = 'APPLIED'
    GROUP BY usage."tokenPurchaseId"
)
UPDATE "AgentTokenPurchase" AS purchase
SET "remainingTokenAmount" = CASE
    WHEN purchase."status" = 'COMPLETED'
        THEN purchase."tokenAmount" -
        COALESCE(
            (
                SELECT historical_usage."consumedTokenAmount"
                FROM historical_usage
                WHERE historical_usage."tokenPurchaseId" = purchase."id"
            ),
            0
        )
    ELSE 0
END
FROM "UserAgentWallet" AS scoped_wallet
WHERE
    purchase."userAgentWalletId" = scoped_wallet."id"
    AND purchase."remainingTokenAmount" IS NULL;

UPDATE "AgentUsageCharge" AS usage
SET "userAgentWalletId" = purchase."userAgentWalletId"
FROM "AgentTokenPurchase" AS purchase
WHERE
    usage."tokenPurchaseId" = purchase."id"
    AND usage."userAgentWalletId" IS NULL
    AND purchase."userAgentWalletId" IS NOT NULL;

-- Preserve the legacy APPLIED lifecycle as a fully consumed reservation
-- snapshot. The enum value remains APPLIED for backward-compatible reads.
UPDATE "AgentUsageCharge"
SET
    "reservedTokenAmount" = "tokenAmount",
    "settledTokenAmount" = "tokenAmount",
    "reservedAt" = COALESCE("reservedAt", "createdAt"),
    "settledAt" = COALESCE("settledAt", "createdAt")
WHERE
    "status" = 'APPLIED'
    AND "reservedTokenAmount" = 0
    AND "settledTokenAmount" = 0;

WITH scoped_totals AS (
    SELECT
        purchase."userAgentWalletId",
        COALESCE(SUM(
            CASE
                WHEN purchase."status" = 'COMPLETED'
                    THEN purchase."tokenAmount"
                ELSE 0
            END
        ), 0)::INTEGER AS "purchasedTokenAmount",
        COALESCE(SUM(
            CASE
                WHEN purchase."status" = 'COMPLETED'
                    THEN purchase."remainingTokenAmount"
                ELSE 0
            END
        ), 0)::INTEGER AS "availableTokenAmount"
    FROM "AgentTokenPurchase" AS purchase
    WHERE purchase."userAgentWalletId" IS NOT NULL
    GROUP BY purchase."userAgentWalletId"
)
UPDATE "UserAgentWallet" AS scoped_wallet
SET
    "availableTokenAmount" = scoped_totals."availableTokenAmount",
    "reservedTokenAmount" = 0,
    "totalPurchasedTokenAmount" = scoped_totals."purchasedTokenAmount",
    "totalConsumedTokenAmount" =
        scoped_totals."purchasedTokenAmount" -
        scoped_totals."availableTokenAmount",
    "updatedAt" = CURRENT_TIMESTAMP
FROM scoped_totals
WHERE scoped_totals."userAgentWalletId" = scoped_wallet."id";

-- Validate the purchase bound only after historical remaining balances have
-- been reconstructed.
ALTER TABLE "AgentTokenPurchase"
    VALIDATE CONSTRAINT "AgentTokenPurchase_remaining_bounds";

ALTER TABLE "AgentUsageCharge"
    VALIDATE CONSTRAINT "AgentUsageCharge_reservation_bounds";

ALTER TABLE "AgentWallet"
    VALIDATE CONSTRAINT "AgentWallet_token_balance_nonnegative",
    VALIDATE CONSTRAINT "AgentWallet_purchase_total_nonnegative",
    VALIDATE CONSTRAINT "AgentWallet_consumption_total_nonnegative",
    VALIDATE CONSTRAINT "AgentWallet_balance_conservation";
