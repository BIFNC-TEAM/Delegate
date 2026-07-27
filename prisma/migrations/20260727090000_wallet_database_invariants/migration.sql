-- Wallet projection invariants that are safe to enforce at the row boundary.
--
-- UserAgentWallet and the usage reservation buckets already own validated
-- non-negative/conservation checks from
-- 20260723230000_wallet_transaction_scoped_balances. Do not duplicate those
-- constraints here: validating them below makes this migration fail closed if
-- a database reached this point without the required foundation.
--
-- CreatorEarning has no immutable per-row "total earned" column, so a CHECK
-- cannot prove conservation across historical transitions. The database can
-- still prevent negative buckets and terminal states that retain live funds.
--
-- Deployment contract: acquire this migration only after legacy wallet writers
-- have stopped, or after every writer has been upgraded to emit states accepted
-- by these checks. A future rolling deployment must use that two-phase order;
-- do not run this migration while mixed old/new writer versions are active.

BEGIN;

-- Prisma does not implicitly wrap PostgreSQL migration files in one
-- transaction. Hold write-blocking locks from preflight through VALIDATE so a
-- concurrent INSERT/UPDATE/DELETE cannot create an invalid row in between.
-- Plain reads remain available while the migration runs.
LOCK TABLE
    "UserWallet",
    "UserAgentWallet",
    "CreatorEarning",
    "AgentUsageCharge",
    "WithdrawRequest"
IN SHARE ROW EXCLUSIVE MODE;

DO $wallet_database_invariant_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "UserWallet"
        WHERE "cashBalanceCents" < 0
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: UserWallet cash balance must be non-negative';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "CreatorEarning"
        WHERE
            "pendingCents" < 0
            OR "withdrawableCents" < 0
            OR "frozenCents" < 0
            OR "withdrawnCents" < 0
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: CreatorEarning buckets must be non-negative';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "CreatorEarning"
        WHERE
            (
                "status" = 'REVERSED'
                AND (
                    "pendingCents" <> 0
                    OR "withdrawableCents" <> 0
                    OR "frozenCents" <> 0
                    OR "withdrawnCents" <> 0
                )
            )
            OR (
                "status" = 'WITHDRAWN'
                AND (
                    "pendingCents" <> 0
                    OR "withdrawableCents" <> 0
                    OR "frozenCents" <> 0
                    OR "withdrawnCents" <= 0
                )
            )
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: CreatorEarning terminal status does not match its buckets';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "AgentUsageCharge"
        WHERE
            "quantity" <= 0
            OR "tokenAmount" <= 0
            OR "providerCostCents" < 0
            OR "platformRevenueCents" < 0
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: AgentUsageCharge amounts are invalid';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "AgentUsageCharge"
        WHERE
            CASE "status"
                WHEN 'CREATED' THEN
                    "reservedTokenAmount" <> 0
                    OR "settledTokenAmount" <> 0
                    OR "releasedTokenAmount" <> 0
                WHEN 'APPLIED' THEN
                    "reservedTokenAmount" <> "tokenAmount"
                    OR "settledTokenAmount" <> "tokenAmount"
                    OR "releasedTokenAmount" <> 0
                WHEN 'RESERVED' THEN
                    "reservedTokenAmount" <> "tokenAmount"
                    OR "settledTokenAmount" <> 0
                    OR "releasedTokenAmount" <> 0
                WHEN 'SETTLED' THEN
                    "reservedTokenAmount" <> "tokenAmount"
                    OR "settledTokenAmount" + "releasedTokenAmount"
                        <> "reservedTokenAmount"
                WHEN 'RELEASED' THEN
                    "reservedTokenAmount" <> "tokenAmount"
                    OR "settledTokenAmount" <> 0
                    OR "releasedTokenAmount" <> "reservedTokenAmount"
                WHEN 'FAILED' THEN
                    "reservedTokenAmount" <> "tokenAmount"
                    OR "settledTokenAmount" <> 0
                    OR "releasedTokenAmount" <> "reservedTokenAmount"
                WHEN 'REVERSED' THEN
                    "reservedTokenAmount" <> 0
                    OR "settledTokenAmount" <> 0
                    OR "releasedTokenAmount" <> 0
                ELSE TRUE
            END
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: AgentUsageCharge status does not match its token amounts';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "WithdrawRequest"
        WHERE "amountCents" <= 0
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: WithdrawRequest amount must be positive';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "WithdrawRequest"
        WHERE
            (
                "status" = 'PAID'
                AND (
                    "paidAt" IS NULL
                    OR "provider" IS NULL
                    OR "providerPayoutId" IS NULL
                    OR "failureReason" IS NOT NULL
                )
            )
            OR (
                "status" <> 'PAID'
                AND (
                    "paidAt" IS NOT NULL
                    OR "provider" IS NOT NULL
                    OR "providerPayoutId" IS NOT NULL
                )
            )
    ) THEN
        RAISE EXCEPTION
            'wallet invariant preflight failed: WithdrawRequest status does not match its payout facts';
    END IF;
END
$wallet_database_invariant_preflight$;

-- Confirm the scoped-wallet accounting foundation before adding dependent
-- wallet constraints. PostgreSQL accepts VALIDATE on already-valid checks.
ALTER TABLE "UserAgentWallet"
    VALIDATE CONSTRAINT "UserAgentWallet_available_nonnegative",
    VALIDATE CONSTRAINT "UserAgentWallet_reserved_nonnegative",
    VALIDATE CONSTRAINT "UserAgentWallet_purchased_nonnegative",
    VALIDATE CONSTRAINT "UserAgentWallet_consumed_nonnegative",
    VALIDATE CONSTRAINT "UserAgentWallet_balance_conservation";

ALTER TABLE "AgentUsageCharge"
    VALIDATE CONSTRAINT "AgentUsageCharge_reserved_nonnegative",
    VALIDATE CONSTRAINT "AgentUsageCharge_settled_nonnegative",
    VALIDATE CONSTRAINT "AgentUsageCharge_released_nonnegative",
    VALIDATE CONSTRAINT "AgentUsageCharge_reservation_bounds";

ALTER TABLE "UserWallet"
    ADD CONSTRAINT "UserWallet_cash_balance_nonnegative"
    CHECK ("cashBalanceCents" >= 0) NOT VALID;

ALTER TABLE "CreatorEarning"
    ADD CONSTRAINT "CreatorEarning_buckets_nonnegative"
    CHECK (
        "pendingCents" >= 0
        AND "withdrawableCents" >= 0
        AND "frozenCents" >= 0
        AND "withdrawnCents" >= 0
    ) NOT VALID,
    ADD CONSTRAINT "CreatorEarning_terminal_bucket_consistency"
    CHECK (
        (
            "status" <> 'REVERSED'
            OR (
                "pendingCents" = 0
                AND "withdrawableCents" = 0
                AND "frozenCents" = 0
                AND "withdrawnCents" = 0
            )
        )
        AND (
            "status" <> 'WITHDRAWN'
            OR (
                "pendingCents" = 0
                AND "withdrawableCents" = 0
                AND "frozenCents" = 0
                AND "withdrawnCents" > 0
            )
        )
    ) NOT VALID;

ALTER TABLE "AgentUsageCharge"
    ADD CONSTRAINT "AgentUsageCharge_positive_dimensions"
    CHECK ("quantity" > 0 AND "tokenAmount" > 0) NOT VALID,
    ADD CONSTRAINT "AgentUsageCharge_costs_nonnegative"
    CHECK ("providerCostCents" >= 0 AND "platformRevenueCents" >= 0) NOT VALID,
    ADD CONSTRAINT "AgentUsageCharge_status_amount_consistency"
    CHECK (
        CASE "status"
            WHEN 'CREATED' THEN
                "reservedTokenAmount" = 0
                AND "settledTokenAmount" = 0
                AND "releasedTokenAmount" = 0
            WHEN 'APPLIED' THEN
                "reservedTokenAmount" = "tokenAmount"
                AND "settledTokenAmount" = "tokenAmount"
                AND "releasedTokenAmount" = 0
            WHEN 'RESERVED' THEN
                "reservedTokenAmount" = "tokenAmount"
                AND "settledTokenAmount" = 0
                AND "releasedTokenAmount" = 0
            WHEN 'SETTLED' THEN
                "reservedTokenAmount" = "tokenAmount"
                AND "settledTokenAmount" + "releasedTokenAmount"
                    = "reservedTokenAmount"
            WHEN 'RELEASED' THEN
                "reservedTokenAmount" = "tokenAmount"
                AND "settledTokenAmount" = 0
                AND "releasedTokenAmount" = "reservedTokenAmount"
            WHEN 'FAILED' THEN
                "reservedTokenAmount" = "tokenAmount"
                AND "settledTokenAmount" = 0
                AND "releasedTokenAmount" = "reservedTokenAmount"
            WHEN 'REVERSED' THEN
                "reservedTokenAmount" = 0
                AND "settledTokenAmount" = 0
                AND "releasedTokenAmount" = 0
            ELSE FALSE
        END
    ) NOT VALID;

ALTER TABLE "WithdrawRequest"
    ADD CONSTRAINT "WithdrawRequest_amount_positive"
    CHECK ("amountCents" > 0) NOT VALID,
    ADD CONSTRAINT "WithdrawRequest_status_payout_consistency"
    CHECK (
        (
            "status" = 'PAID'
            AND "paidAt" IS NOT NULL
            AND "provider" IS NOT NULL
            AND "providerPayoutId" IS NOT NULL
            AND "failureReason" IS NULL
        )
        OR (
            "status" <> 'PAID'
            AND "paidAt" IS NULL
            AND "provider" IS NULL
            AND "providerPayoutId" IS NULL
        )
    ) NOT VALID;

ALTER TABLE "UserWallet"
    VALIDATE CONSTRAINT "UserWallet_cash_balance_nonnegative";

ALTER TABLE "CreatorEarning"
    VALIDATE CONSTRAINT "CreatorEarning_buckets_nonnegative",
    VALIDATE CONSTRAINT "CreatorEarning_terminal_bucket_consistency";

ALTER TABLE "AgentUsageCharge"
    VALIDATE CONSTRAINT "AgentUsageCharge_positive_dimensions",
    VALIDATE CONSTRAINT "AgentUsageCharge_costs_nonnegative",
    VALIDATE CONSTRAINT "AgentUsageCharge_status_amount_consistency";

ALTER TABLE "WithdrawRequest"
    VALIDATE CONSTRAINT "WithdrawRequest_amount_positive",
    VALIDATE CONSTRAINT "WithdrawRequest_status_payout_consistency";

COMMIT;
