-- A bound wallet usage charge is an authorization capability. Partial bindings
-- can bypass the dual-ledger lifecycle, while two active bindings for the same
-- GenerationRun make terminal ownership ambiguous. Lock writers from preflight
-- through validation so the checks cannot race application mutations.
BEGIN;

LOCK TABLE "AgentUsageCharge", "WalletTransaction"
    IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "AgentUsageCharge"
        WHERE NOT (
            (
                "audienceIdentityId" IS NULL
                AND "entitlementAccountId" IS NULL
                AND "conversationId" IS NULL
                AND "generationRunId" IS NULL
            )
            OR
            (
                "audienceIdentityId" IS NOT NULL
                AND "entitlementAccountId" IS NOT NULL
                AND "conversationId" IS NOT NULL
                AND "generationRunId" IS NOT NULL
                AND "userAgentWalletId" IS NOT NULL
            )
        )
    ) THEN
        RAISE EXCEPTION
            'wallet usage ownership preflight failed: AgentUsageCharge contains a partial wallet-entitlement binding';
    END IF;

    IF EXISTS (
        SELECT "generationRunId"
        FROM "AgentUsageCharge"
        WHERE
            "status" = 'RESERVED'
            AND "generationRunId" IS NOT NULL
        GROUP BY "generationRunId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'wallet usage ownership preflight failed: one GenerationRun owns multiple active bound reservations';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "WalletTransaction"
        WHERE
            "sourceType" = 'AgentUsageEntitlementTransfer'
            AND (
                "eventGroupId" =
                    'usage_entitlement_transfer:' || COALESCE("sourceId", '')
                OR "idempotencyKey" =
                    'usage_entitlement_transfer:' || COALESCE("sourceId", '')
            )
    ) THEN
        RAISE EXCEPTION
            'wallet usage ownership preflight failed: legacy single-key transfer audit must be reconciled before deployment';
    END IF;
END
$preflight$;

ALTER TABLE "AgentUsageCharge"
    ADD CONSTRAINT "AgentUsageCharge_binding_coordinates_complete"
    CHECK (
        (
            "audienceIdentityId" IS NULL
            AND "entitlementAccountId" IS NULL
            AND "conversationId" IS NULL
            AND "generationRunId" IS NULL
        )
        OR
        (
            "audienceIdentityId" IS NOT NULL
            AND "entitlementAccountId" IS NOT NULL
            AND "conversationId" IS NOT NULL
            AND "generationRunId" IS NOT NULL
            AND "userAgentWalletId" IS NOT NULL
        )
    )
    NOT VALID;

ALTER TABLE "AgentUsageCharge"
    VALIDATE CONSTRAINT "AgentUsageCharge_binding_coordinates_complete";

-- Bound usage is a financial authorization fact. Keep its referenced scope
-- records instead of allowing an ON DELETE SET NULL action to produce a
-- partial, unverifiable binding.
ALTER TABLE "AgentUsageCharge"
    DROP CONSTRAINT "AgentUsageCharge_userAgentWalletId_fkey",
    DROP CONSTRAINT "AgentUsageCharge_audienceIdentityId_fkey",
    DROP CONSTRAINT "AgentUsageCharge_entitlementAccountId_fkey",
    DROP CONSTRAINT "AgentUsageCharge_conversationId_fkey",
    DROP CONSTRAINT "AgentUsageCharge_generationRunId_fkey";

ALTER TABLE "AgentUsageCharge"
    ADD CONSTRAINT "AgentUsageCharge_userAgentWalletId_fkey"
        FOREIGN KEY ("userAgentWalletId")
        REFERENCES "UserAgentWallet"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AgentUsageCharge_audienceIdentityId_fkey"
        FOREIGN KEY ("audienceIdentityId")
        REFERENCES "AudienceIdentity"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AgentUsageCharge_entitlementAccountId_fkey"
        FOREIGN KEY ("entitlementAccountId")
        REFERENCES "ServiceEntitlementAccount"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AgentUsageCharge_conversationId_fkey"
        FOREIGN KEY ("conversationId")
        REFERENCES "Conversation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AgentUsageCharge_generationRunId_fkey"
        FOREIGN KEY ("generationRunId")
        REFERENCES "GenerationRun"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AgentUsageCharge_one_active_bound_reservation_per_run"
    ON "AgentUsageCharge"("generationRunId")
    WHERE
        "status" = 'RESERVED'
        AND "generationRunId" IS NOT NULL;

COMMIT;
