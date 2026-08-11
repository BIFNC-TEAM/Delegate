-- Unified representative commerce: access policy, immutable service-package
-- benefits, non-entitling tips, and auditable human-handoff grants.
--
-- Historical recharge rows remain intact. Product-bound orders are expanded
-- and backfilled before the stricter V2 snapshot guard is installed. The
-- mutable legacy PricingPlan catalog is retired by the follow-up migration;
-- historical Invoice snapshots remain auditable.
--
-- DEPLOYMENT CONTRACT: this migration intentionally uses one transaction
-- because the deterministic HandoffRequest de-duplication below relies on a
-- transaction-scoped temporary table. Apply it in a maintenance window with
-- dashboard/reps/bot/workflow writers and payment/refund callbacks stopped,
-- and keep provider collection disabled until every process runs the matching
-- application version. A future zero-downtime rollout must split this into
-- expand, backfill, concurrent-index, and contract migrations; do not merely
-- remove BEGIN/COMMIT.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

CREATE TYPE "BillingProductKind" AS ENUM (
  'SERVICE_PACKAGE',
  'TIP'
);

CREATE TYPE "BillingHandoffAllowance" AS ENUM (
  'NONE',
  'LIMITED',
  'UNLIMITED'
);

CREATE TYPE "BillingHandoffServiceLevel" AS ENUM (
  'STANDARD',
  'PRIORITY'
);

CREATE TYPE "RepresentativeAccessMode" AS ENUM (
  'FREE',
  'TRIAL_THEN_CREDITS',
  'CREDITS_ONLY'
);

CREATE TYPE "RepresentativeHandoffAccessMode" AS ENUM (
  'FREE',
  'PACKAGE_REQUIRED'
);

CREATE TYPE "HandoffEntitlementGrantStatus" AS ENUM (
  'ACTIVE',
  'FROZEN',
  'EXHAUSTED',
  'EXPIRED',
  'REFUNDED'
);

CREATE TYPE "HandoffEntitlementLedgerKind" AS ENUM (
  'GRANT',
  'RESERVE',
  'CONSUME',
  'RELEASE',
  'REFUND',
  'EXPIRE',
  'ADJUST'
);

CREATE TYPE "HandoffEntitlementReservationState" AS ENUM (
  'RESERVED',
  'CONSUMED',
  'RELEASED'
);

CREATE TYPE "TipContributionStatus" AS ENUM (
  'COMPLETED',
  'REFUNDED',
  'REVERSED'
);

ALTER TABLE "Representative"
  ADD COLUMN "accessMode" "RepresentativeAccessMode" NOT NULL
    DEFAULT 'TRIAL_THEN_CREDITS',
  ADD COLUMN "handoffAccessMode" "RepresentativeHandoffAccessMode" NOT NULL
    DEFAULT 'FREE',
  ADD COLUMN "tipsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "Representative_free_reply_limit_nonnegative"
    CHECK ("freeReplyLimit" BETWEEN 0 AND 1000000) NOT VALID;

ALTER TABLE "Representative"
  VALIDATE CONSTRAINT "Representative_free_reply_limit_nonnegative";

ALTER TABLE "BillingProduct"
  ADD COLUMN "kind" "BillingProductKind" NOT NULL DEFAULT 'SERVICE_PACKAGE',
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isRecommended" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "BillingProduct_sort_order_nonnegative"
    CHECK ("sortOrder" BETWEEN 0 AND 1000000) NOT VALID;

ALTER TABLE "BillingProduct"
  VALIDATE CONSTRAINT "BillingProduct_sort_order_nonnegative";

CREATE INDEX "BillingProduct_representativeId_kind_status_sortOrder_updat_idx"
  ON "BillingProduct"(
    "representativeId", "kind", "status", "sortOrder", "updatedAt"
  );

-- Product kind is identity-level; display metadata and ordering may advance the
-- optimistic revision exactly once per write.
CREATE OR REPLACE FUNCTION "enforce_billing_product_stability"()
RETURNS TRIGGER AS $$
DECLARE
  "businessChanged" BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'BillingProduct rows are stable identities and must be archived, not deleted';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'BillingProduct id, representative, code, kind, and creation time are immutable';
  END IF;

  IF
    (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'ARCHIVED'))
    OR (OLD."status" = 'ARCHIVED' AND NEW."status" <> 'ARCHIVED')
  THEN
    RAISE EXCEPTION
      'BillingProduct status cannot move backward or reactivate an archived product';
  END IF;

  "businessChanged" :=
    NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."sortOrder" IS DISTINCT FROM OLD."sortOrder"
    OR NEW."isRecommended" IS DISTINCT FROM OLD."isRecommended"
    OR NEW."status" IS DISTINCT FROM OLD."status";

  IF
    ("businessChanged" AND NEW."revision" <> OLD."revision" + 1)
    OR (
      NOT "businessChanged"
      AND NEW."revision" NOT IN (OLD."revision", OLD."revision" + 1)
    )
  THEN
    RAISE EXCEPTION
      'BillingProduct revision is invalid for this metadata, status, or publication update';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "BillingPriceVersion"
  ADD COLUMN "handoffAllowance" "BillingHandoffAllowance" NOT NULL
    DEFAULT 'NONE',
  ADD COLUMN "handoffUnits" INTEGER,
  ADD COLUMN "handoffServiceLevel" "BillingHandoffServiceLevel",
  ADD COLUMN "handoffValidityDays" INTEGER;

ALTER TABLE "BillingPriceVersion"
  DROP CONSTRAINT IF EXISTS "BillingPriceVersion_v1_unit",
  DROP CONSTRAINT IF EXISTS "BillingPriceVersion_entitlement_positive",
  DROP CONSTRAINT IF EXISTS "BillingPriceVersion_integer_unit_price",
  ADD CONSTRAINT "BillingPriceVersion_commerce_shape" CHECK (
    (
      "unitName" = 'credit'
      AND "amountMinor" BETWEEN 1 AND 1000000
      AND "entitlementUnits" > 0
      AND "entitlementUnits" <= 10000000
      AND "refundPolicy" = 'FULL_WHEN_UNUSED'
      AND (
        (
          "handoffAllowance" = 'NONE'
          AND "handoffUnits" IS NULL
          AND "handoffServiceLevel" IS NULL
          AND "handoffValidityDays" IS NULL
        )
        OR (
          "handoffAllowance" = 'LIMITED'
          AND "handoffUnits" IS NOT NULL
          AND "handoffUnits" > 0
          AND "handoffUnits" <= 1000000
          AND "handoffServiceLevel" IS NOT NULL
          AND "handoffValidityDays" IS NOT NULL
          AND "handoffValidityDays" > 0
          AND "handoffValidityDays" <= 3650
        )
        OR (
          "handoffAllowance" = 'UNLIMITED'
          AND "handoffUnits" IS NULL
          AND "handoffServiceLevel" IS NOT NULL
          AND "handoffValidityDays" IS NOT NULL
          AND "handoffValidityDays" > 0
          AND "handoffValidityDays" <= 3650
        )
      )
    )
    OR (
      "unitName" = 'tip'
      AND "amountMinor" BETWEEN 1 AND 1000000
      AND "entitlementUnits" = 0
      AND "refundPolicy" = 'NON_REFUNDABLE'
      AND "handoffAllowance" = 'NONE'
      AND "handoffUnits" IS NULL
      AND "handoffServiceLevel" IS NULL
      AND "handoffValidityDays" IS NULL
    )
  ) NOT VALID;

ALTER TABLE "BillingPriceVersion"
  VALIDATE CONSTRAINT "BillingPriceVersion_commerce_shape";

CREATE OR REPLACE FUNCTION "enforce_billing_price_version_immutability"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'BillingPriceVersion rows are immutable and cannot be deleted';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."billingProductId" IS DISTINCT FROM OLD."billingProductId"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
    OR NEW."unitName" IS DISTINCT FROM OLD."unitName"
    OR NEW."entitlementUnits" IS DISTINCT FROM OLD."entitlementUnits"
    OR NEW."creatorRevenueShareBps" IS DISTINCT FROM OLD."creatorRevenueShareBps"
    OR NEW."platformRevenueShareBps" IS DISTINCT FROM OLD."platformRevenueShareBps"
    OR NEW."refundPolicy" IS DISTINCT FROM OLD."refundPolicy"
    OR NEW."expiryPolicy" IS DISTINCT FROM OLD."expiryPolicy"
    OR NEW."entitlementValidityDays" IS DISTINCT FROM OLD."entitlementValidityDays"
    OR NEW."handoffAllowance" IS DISTINCT FROM OLD."handoffAllowance"
    OR NEW."handoffUnits" IS DISTINCT FROM OLD."handoffUnits"
    OR NEW."handoffServiceLevel" IS DISTINCT FROM OLD."handoffServiceLevel"
    OR NEW."handoffValidityDays" IS DISTINCT FROM OLD."handoffValidityDays"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'BillingPriceVersion commercial fields are immutable; create a new version';
  END IF;

  IF
    (OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ACTIVE'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'RETIRED'))
    OR (OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED')
  THEN
    RAISE EXCEPTION
      'BillingPriceVersion status transitions must move DRAFT -> ACTIVE -> RETIRED';
  END IF;

  IF
    (
      OLD."status" IN ('ACTIVE', 'RETIRED')
      AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
    )
    OR (
      OLD."status" = 'RETIRED'
      AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt"
    )
  THEN
    RAISE EXCEPTION
      'BillingPriceVersion lifecycle timestamps are immutable once recorded';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ACTIVE versions must agree with the stable product kind.
CREATE OR REPLACE FUNCTION "enforce_billing_publication_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  "targetProductId" TEXT;
  "productStatus" "BillingProductStatus";
  "productKind" "BillingProductKind";
BEGIN
  IF TG_TABLE_NAME = 'BillingProduct' THEN
    "targetProductId" := NEW."id";
  ELSE
    "targetProductId" := NEW."billingProductId";
  END IF;

  SELECT "status", "kind"
  INTO "productStatus", "productKind"
  FROM "BillingProduct"
  WHERE "id" = "targetProductId";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF
    "productStatus" <> 'ACTIVE'
    AND EXISTS (
      SELECT 1 FROM "BillingPriceVersion"
      WHERE "billingProductId" = "targetProductId" AND "status" = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION
      'An active BillingPriceVersion requires an active BillingProduct';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BillingPriceVersion"
    WHERE
      "billingProductId" = "targetProductId"
      AND "status" = 'ACTIVE'
      AND (
        ("productKind" = 'SERVICE_PACKAGE' AND "unitName" <> 'credit')
        OR ("productKind" = 'TIP' AND "unitName" <> 'tip')
      )
  ) THEN
    RAISE EXCEPTION
      'An active BillingPriceVersion must match its BillingProduct kind';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "RechargeOrder"
  ADD COLUMN "productKindSnapshot" "BillingProductKind",
  ADD COLUMN "handoffAllowanceSnapshot" "BillingHandoffAllowance",
  ADD COLUMN "handoffUnitsSnapshot" INTEGER,
  ADD COLUMN "handoffServiceLevelSnapshot" "BillingHandoffServiceLevel",
  ADD COLUMN "handoffValidityDaysSnapshot" INTEGER;

UPDATE "RechargeOrder" AS "order"
SET
  "productKindSnapshot" = "product"."kind",
  "handoffAllowanceSnapshot" = "price"."handoffAllowance",
  "handoffUnitsSnapshot" = "price"."handoffUnits",
  "handoffServiceLevelSnapshot" = "price"."handoffServiceLevel",
  "handoffValidityDaysSnapshot" = "price"."handoffValidityDays"
FROM "BillingProduct" AS "product"
INNER JOIN "BillingPriceVersion" AS "price"
  ON "price"."billingProductId" = "product"."id"
WHERE
  "order"."billingProductId" = "product"."id"
  AND "order"."billingPriceVersionId" = "price"."id";

CREATE INDEX "RechargeOrder_representativeId_productKindSnapshot_status_c_idx"
  ON "RechargeOrder"(
    "representativeId", "productKindSnapshot", "status", "createdAt"
  );

ALTER TABLE "RechargeOrder"
  DROP CONSTRAINT IF EXISTS "RechargeOrder_billing_snapshot_complete",
  ADD CONSTRAINT "RechargeOrder_billing_snapshot_complete" CHECK (
    (
      "billingProductId" IS NULL
      AND "billingPriceVersionId" IS NULL
      AND "productNameSnapshot" IS NULL
      AND "productKindSnapshot" IS NULL
      AND "unitNameSnapshot" IS NULL
      AND "entitlementUnitsSnapshot" IS NULL
      AND "handoffAllowanceSnapshot" IS NULL
      AND "handoffUnitsSnapshot" IS NULL
      AND "handoffServiceLevelSnapshot" IS NULL
      AND "handoffValidityDaysSnapshot" IS NULL
      AND "creatorRevenueShareBpsSnapshot" IS NULL
      AND "platformRevenueShareBpsSnapshot" IS NULL
      AND "refundPolicySnapshot" IS NULL
      AND "expiryPolicySnapshot" IS NULL
      AND "entitlementValidityDaysSnapshot" IS NULL
    )
    OR (
      "billingProductId" IS NOT NULL
      AND "billingPriceVersionId" IS NOT NULL
      AND "productNameSnapshot" IS NOT NULL
      AND LENGTH(BTRIM("productNameSnapshot")) > 0
      AND "productKindSnapshot" IS NOT NULL
      AND "unitNameSnapshot" IS NOT NULL
      AND "entitlementUnitsSnapshot" IS NOT NULL
      AND "handoffAllowanceSnapshot" IS NOT NULL
      AND "refundPolicySnapshot" IS NOT NULL
      AND "currency" = 'CNY'
      AND "amountCents" > 0
      AND "amountCents" <= 1000000
      AND "creatorRevenueShareBpsSnapshot" IS NOT NULL
      AND "creatorRevenueShareBpsSnapshot" BETWEEN 0 AND 10000
      AND "platformRevenueShareBpsSnapshot" IS NOT NULL
      AND "platformRevenueShareBpsSnapshot" BETWEEN 0 AND 10000
      AND (
        "creatorRevenueShareBpsSnapshot"
        + "platformRevenueShareBpsSnapshot"
      ) = 10000
      AND "expiryPolicySnapshot" IS NOT NULL
      AND "expiryPolicySnapshot" = 'NEVER_EXPIRES'
      AND "entitlementValidityDaysSnapshot" IS NULL
      AND (
        (
          "productKindSnapshot" = 'SERVICE_PACKAGE'
          AND "unitNameSnapshot" = 'credit'
          AND "entitlementUnitsSnapshot" > 0
          AND "entitlementUnitsSnapshot" <= 10000000
          AND "refundPolicySnapshot" = 'FULL_WHEN_UNUSED'
          AND (
            (
              "handoffAllowanceSnapshot" = 'NONE'
              AND "handoffUnitsSnapshot" IS NULL
              AND "handoffServiceLevelSnapshot" IS NULL
              AND "handoffValidityDaysSnapshot" IS NULL
            )
            OR (
              "handoffAllowanceSnapshot" = 'LIMITED'
              AND "handoffUnitsSnapshot" IS NOT NULL
              AND "handoffUnitsSnapshot" > 0
              AND "handoffUnitsSnapshot" <= 1000000
              AND "handoffServiceLevelSnapshot" IS NOT NULL
              AND "handoffValidityDaysSnapshot" IS NOT NULL
              AND "handoffValidityDaysSnapshot" > 0
              AND "handoffValidityDaysSnapshot" <= 3650
            )
            OR (
              "handoffAllowanceSnapshot" = 'UNLIMITED'
              AND "handoffUnitsSnapshot" IS NULL
              AND "handoffServiceLevelSnapshot" IS NOT NULL
              AND "handoffValidityDaysSnapshot" IS NOT NULL
              AND "handoffValidityDaysSnapshot" > 0
              AND "handoffValidityDaysSnapshot" <= 3650
            )
          )
        )
        OR (
          "productKindSnapshot" = 'TIP'
          AND "unitNameSnapshot" = 'tip'
          AND "entitlementUnitsSnapshot" = 0
          AND "refundPolicySnapshot" = 'NON_REFUNDABLE'
          AND "handoffAllowanceSnapshot" = 'NONE'
          AND "handoffUnitsSnapshot" IS NULL
          AND "handoffServiceLevelSnapshot" IS NULL
          AND "handoffValidityDaysSnapshot" IS NULL
        )
      )
    )
  ) NOT VALID;

ALTER TABLE "RechargeOrder"
  VALIDATE CONSTRAINT "RechargeOrder_billing_snapshot_complete";

CREATE OR REPLACE FUNCTION "enforce_recharge_order_billing_snapshot"()
RETURNS TRIGGER AS $$
DECLARE
  "expected" RECORD;
  "expectedProductCode" TEXT;
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND (
      OLD."billingPriceVersionId" IS NOT NULL
      OR NEW."billingPriceVersionId" IS NOT NULL
    )
    AND (
      NEW."userWalletId" IS DISTINCT FROM OLD."userWalletId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."productCode" IS DISTINCT FROM OLD."productCode"
      OR NEW."billingProductId" IS DISTINCT FROM OLD."billingProductId"
      OR NEW."billingPriceVersionId" IS DISTINCT FROM OLD."billingPriceVersionId"
      OR NEW."productNameSnapshot" IS DISTINCT FROM OLD."productNameSnapshot"
      OR NEW."productKindSnapshot" IS DISTINCT FROM OLD."productKindSnapshot"
      OR NEW."unitNameSnapshot" IS DISTINCT FROM OLD."unitNameSnapshot"
      OR NEW."entitlementUnitsSnapshot" IS DISTINCT FROM OLD."entitlementUnitsSnapshot"
      OR NEW."handoffAllowanceSnapshot" IS DISTINCT FROM OLD."handoffAllowanceSnapshot"
      OR NEW."handoffUnitsSnapshot" IS DISTINCT FROM OLD."handoffUnitsSnapshot"
      OR NEW."handoffServiceLevelSnapshot" IS DISTINCT FROM OLD."handoffServiceLevelSnapshot"
      OR NEW."handoffValidityDaysSnapshot" IS DISTINCT FROM OLD."handoffValidityDaysSnapshot"
      OR NEW."creatorRevenueShareBpsSnapshot" IS DISTINCT FROM OLD."creatorRevenueShareBpsSnapshot"
      OR NEW."platformRevenueShareBpsSnapshot" IS DISTINCT FROM OLD."platformRevenueShareBpsSnapshot"
      OR NEW."refundPolicySnapshot" IS DISTINCT FROM OLD."refundPolicySnapshot"
      OR NEW."expiryPolicySnapshot" IS DISTINCT FROM OLD."expiryPolicySnapshot"
      OR NEW."entitlementValidityDaysSnapshot" IS DISTINCT FROM OLD."entitlementValidityDaysSnapshot"
      OR NEW."provider" IS DISTINCT FROM OLD."provider"
      OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    )
  THEN
    RAISE EXCEPTION
      'Product-bound RechargeOrder commercial fields are immutable';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."billingPriceVersionId" IS NOT NULL THEN
    SELECT
      "product"."representativeId" AS "representativeId",
      "product"."name" AS "productName",
      "product"."kind" AS "productKind",
      "product"."status" AS "productStatus",
      "price"."status" AS "priceStatus",
      "price"."currency" AS "currency",
      "price"."amountMinor" AS "amountMinor",
      "price"."unitName" AS "unitName",
      "price"."entitlementUnits" AS "entitlementUnits",
      "price"."handoffAllowance" AS "handoffAllowance",
      "price"."handoffUnits" AS "handoffUnits",
      "price"."handoffServiceLevel" AS "handoffServiceLevel",
      "price"."handoffValidityDays" AS "handoffValidityDays",
      "price"."creatorRevenueShareBps" AS "creatorRevenueShareBps",
      "price"."platformRevenueShareBps" AS "platformRevenueShareBps",
      "price"."refundPolicy" AS "refundPolicy",
      "price"."expiryPolicy" AS "expiryPolicy",
      "price"."entitlementValidityDays" AS "entitlementValidityDays"
    INTO "expected"
    FROM "BillingPriceVersion" AS "price"
    INNER JOIN "BillingProduct" AS "product"
      ON "product"."id" = "price"."billingProductId"
    WHERE
      "price"."id" = NEW."billingPriceVersionId"
      AND "product"."id" = NEW."billingProductId"
    FOR SHARE OF "price", "product";

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'RechargeOrder billing product and price version do not match';
    END IF;

    "expectedProductCode" := CASE "expected"."productKind"
      WHEN 'SERVICE_PACKAGE' THEN 'agent-wallet:service-credit:v1'
      WHEN 'TIP' THEN 'agent-wallet:tip:v1'
    END;

    -- Rolling compatibility is intentionally narrow: the previous writer can
    -- create only a plain SERVICE_PACKAGE (no handoff) and omits all five new
    -- fields together. TIP, paid handoff, and partial snapshots must come from
    -- the new writer and fail the exact-match checks below when incomplete.
    IF
      NEW."productKindSnapshot" IS NULL
      AND NEW."handoffAllowanceSnapshot" IS NULL
      AND NEW."handoffUnitsSnapshot" IS NULL
      AND NEW."handoffServiceLevelSnapshot" IS NULL
      AND NEW."handoffValidityDaysSnapshot" IS NULL
      AND "expected"."productKind" = 'SERVICE_PACKAGE'
      AND "expected"."handoffAllowance" = 'NONE'
    THEN
      NEW."productKindSnapshot" := 'SERVICE_PACKAGE';
      NEW."handoffAllowanceSnapshot" := 'NONE';
    END IF;

    IF
      NEW."representativeId" IS DISTINCT FROM "expected"."representativeId"
      OR NEW."productCode" IS DISTINCT FROM "expectedProductCode"
      OR "expected"."productStatus" <> 'ACTIVE'
      OR "expected"."priceStatus" <> 'ACTIVE'
      OR NEW."currency" IS DISTINCT FROM "expected"."currency"
      OR NEW."amountCents" IS DISTINCT FROM "expected"."amountMinor"
      OR NEW."productNameSnapshot" IS DISTINCT FROM BTRIM("expected"."productName")
      OR NEW."productKindSnapshot" IS DISTINCT FROM "expected"."productKind"
      OR NEW."unitNameSnapshot" IS DISTINCT FROM BTRIM("expected"."unitName")
      OR NEW."entitlementUnitsSnapshot" IS DISTINCT FROM "expected"."entitlementUnits"
      OR NEW."handoffAllowanceSnapshot" IS DISTINCT FROM "expected"."handoffAllowance"
      OR NEW."handoffUnitsSnapshot" IS DISTINCT FROM "expected"."handoffUnits"
      OR NEW."handoffServiceLevelSnapshot" IS DISTINCT FROM "expected"."handoffServiceLevel"
      OR NEW."handoffValidityDaysSnapshot" IS DISTINCT FROM "expected"."handoffValidityDays"
      OR NEW."creatorRevenueShareBpsSnapshot" IS DISTINCT FROM "expected"."creatorRevenueShareBps"
      OR NEW."platformRevenueShareBpsSnapshot" IS DISTINCT FROM "expected"."platformRevenueShareBps"
      OR NEW."refundPolicySnapshot" IS DISTINCT FROM "expected"."refundPolicy"
      OR NEW."expiryPolicySnapshot" IS DISTINCT FROM "expected"."expiryPolicy"
      OR NEW."entitlementValidityDaysSnapshot" IS DISTINCT FROM "expected"."entitlementValidityDays"
    THEN
      RAISE EXCEPTION
        'RechargeOrder commercial snapshot does not match the active price version';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "HandoffEntitlementGrant" (
  "id" TEXT NOT NULL,
  "rechargeOrderId" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "billingPriceVersionId" TEXT NOT NULL,
  "allowance" "BillingHandoffAllowance" NOT NULL,
  "serviceLevel" "BillingHandoffServiceLevel" NOT NULL,
  "grantedUses" INTEGER,
  "remainingUses" INTEGER,
  "reservedUses" INTEGER NOT NULL DEFAULT 0,
  "consumedUses" INTEGER NOT NULL DEFAULT 0,
  "status" "HandoffEntitlementGrantStatus" NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HandoffEntitlementGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HandoffEntitlementGrant_allowance_shape" CHECK (
    (
      "allowance" = 'LIMITED'
      AND "grantedUses" IS NOT NULL
      AND "grantedUses" > 0
      AND "grantedUses" <= 1000000
      AND "remainingUses" IS NOT NULL
      AND "remainingUses" BETWEEN 0 AND "grantedUses"
    )
    OR (
      "allowance" = 'UNLIMITED'
      AND "grantedUses" IS NULL
      AND "remainingUses" IS NULL
    )
  ),
  CONSTRAINT "HandoffEntitlementGrant_counters_valid" CHECK (
    "reservedUses" >= 0
    AND "consumedUses" >= 0
    AND (
      "allowance" = 'UNLIMITED'
      OR (
        "allowance" = 'LIMITED'
        AND "remainingUses" + "reservedUses" + "consumedUses" = "grantedUses"
      )
    )
  ),
  CONSTRAINT "HandoffEntitlementGrant_status_shape" CHECK (
    "status" = 'ACTIVE'
    OR (
      "status" = 'FROZEN'
      AND "reservedUses" = 0
      AND "consumedUses" = 0
      AND (
        "allowance" = 'UNLIMITED'
        OR "remainingUses" = "grantedUses"
      )
    )
    OR (
      "status" = 'EXHAUSTED'
      AND "allowance" = 'LIMITED'
      AND "remainingUses" = 0
      AND "reservedUses" = 0
      AND "consumedUses" = "grantedUses"
    )
    OR (
      "status" = 'EXPIRED'
      AND "reservedUses" = 0
    )
    OR (
      "status" = 'REFUNDED'
      AND "reservedUses" = 0
      AND "consumedUses" = 0
      AND (
        "allowance" = 'UNLIMITED'
        OR "remainingUses" = "grantedUses"
      )
    )
  ),
  CONSTRAINT "HandoffEntitlementGrant_expiry_valid" CHECK (
    "expiresAt" IS NOT NULL
    AND "expiresAt" > "startsAt"
    AND "expiresAt" <= "startsAt" + INTERVAL '3650 days'
  )
);

CREATE UNIQUE INDEX "HandoffEntitlementGrant_rechargeOrderId_key"
  ON "HandoffEntitlementGrant"("rechargeOrderId");
CREATE INDEX "HandoffEntitlementGrant_audienceIdentityId_representativeId_idx"
  ON "HandoffEntitlementGrant"(
    "audienceIdentityId", "representativeId", "status", "expiresAt"
  );
CREATE INDEX "HandoffEntitlementGrant_representativeId_serviceLevel_statu_idx"
  ON "HandoffEntitlementGrant"(
    "representativeId", "serviceLevel", "status", "createdAt"
  );
CREATE INDEX "HandoffEntitlementGrant_billingPriceVersionId_createdAt_idx"
  ON "HandoffEntitlementGrant"("billingPriceVersionId", "createdAt");

ALTER TABLE "HandoffRequest"
  ADD COLUMN "audienceIdentityId" TEXT,
  ADD COLUMN "handoffEntitlementGrantId" TEXT,
  ADD COLUMN "entitlementReservationState" "HandoffEntitlementReservationState",
  ADD COLUMN "serviceLevelSnapshot" "BillingHandoffServiceLevel",
  ADD COLUMN "entitlementReservedAt" TIMESTAMP(3),
  ADD COLUMN "entitlementConsumedAt" TIMESTAMP(3),
  ADD COLUMN "entitlementReleasedAt" TIMESTAMP(3),
  ADD CONSTRAINT "HandoffRequest_entitlement_state_shape" CHECK (
    (
      "handoffEntitlementGrantId" IS NULL
      AND "entitlementReservationState" IS NULL
      AND "serviceLevelSnapshot" IS NULL
      AND "entitlementReservedAt" IS NULL
      AND "entitlementConsumedAt" IS NULL
      AND "entitlementReleasedAt" IS NULL
    )
    OR (
      "handoffEntitlementGrantId" IS NOT NULL
      AND "entitlementReservationState" IS NOT NULL
      AND "serviceLevelSnapshot" IS NOT NULL
      AND "entitlementReservedAt" IS NOT NULL
      AND (
        (
          "entitlementReservationState" = 'RESERVED'
          AND "entitlementConsumedAt" IS NULL
          AND "entitlementReleasedAt" IS NULL
        )
        OR (
          "entitlementReservationState" = 'CONSUMED'
          AND "entitlementConsumedAt" IS NOT NULL
          AND "entitlementReleasedAt" IS NULL
        )
        OR (
          "entitlementReservationState" = 'RELEASED'
          AND "entitlementConsumedAt" IS NULL
          AND "entitlementReleasedAt" IS NOT NULL
        )
      )
    )
  ) NOT VALID;

UPDATE "HandoffRequest" AS "handoff"
SET "audienceIdentityId" = "contact"."audienceIdentityId"
FROM "Contact" AS "contact"
WHERE
  "handoff"."contactId" = "contact"."id"
  AND "handoff"."audienceIdentityId" IS NULL;

ALTER TABLE "HandoffRequest"
  VALIDATE CONSTRAINT "HandoffRequest_entitlement_state_shape";

CREATE INDEX "HandoffRequest_audienceIdentityId_representativeId_status_c_idx"
  ON "HandoffRequest"(
    "audienceIdentityId", "representativeId", "status", "createdAt"
  );
CREATE INDEX "HandoffRequest_handoffEntitlementGrantId_status_createdAt_idx"
  ON "HandoffRequest"(
    "handoffEntitlementGrantId", "status", "createdAt"
  );
-- Preserve every historical request while deterministically closing duplicate
-- active rows before installing the canonical one-active-request constraints.
-- Every loser receives a stable audit event before it is closed.
CREATE TEMPORARY TABLE "commerce_handoff_duplicate_losers"
ON COMMIT DROP
AS
WITH "rankedHandoffs" AS (
  SELECT
    "id",
    "representativeId",
    "contactId",
    "conversationId",
    "status" AS "originalStatus",
    FIRST_VALUE("id") OVER (
      PARTITION BY
        "representativeId",
        CASE
          WHEN "audienceIdentityId" IS NOT NULL
            THEN 'audience:' || "audienceIdentityId"
          ELSE 'contact:' || "contactId"
        END
      ORDER BY
        CASE "status"
          WHEN 'ACCEPTED' THEN 3
          WHEN 'REVIEWING' THEN 2
          ELSE 1
        END DESC,
        "updatedAt" DESC,
        "createdAt" DESC,
        "id" ASC
    ) AS "keeperId",
    ROW_NUMBER() OVER (
      PARTITION BY
        "representativeId",
        CASE
          WHEN "audienceIdentityId" IS NOT NULL
            THEN 'audience:' || "audienceIdentityId"
          ELSE 'contact:' || "contactId"
        END
      ORDER BY
        CASE "status"
          WHEN 'ACCEPTED' THEN 3
          WHEN 'REVIEWING' THEN 2
          ELSE 1
        END DESC,
        "updatedAt" DESC,
        "createdAt" DESC,
        "id" ASC
    ) AS "activeRank"
  FROM "HandoffRequest"
  WHERE "status" IN ('OPEN', 'REVIEWING', 'ACCEPTED')
)
SELECT
  "id" AS "loserId",
  "keeperId",
  "representativeId",
  "contactId",
  "conversationId",
  "originalStatus"
FROM "rankedHandoffs"
WHERE "activeRank" > 1;

INSERT INTO "EventAudit" (
  "id",
  "ownerId",
  "representativeId",
  "idempotencyKey",
  "contactId",
  "conversationId",
  "type",
  "payload",
  "createdAt"
)
SELECT
  'commerce-handoff-dedupe:' || "loser"."loserId",
  "representative"."ownerId",
  "loser"."representativeId",
  'commerce-handoff-dedupe:' || "loser"."loserId",
  "loser"."contactId",
  "loser"."conversationId",
  'REPRESENTATIVE_COMMERCE_UPDATED',
  jsonb_build_object(
    'handoffRequestId', "loser"."loserId",
    'keeperHandoffRequestId', "loser"."keeperId",
    'originalStatus', "loser"."originalStatus",
    'reason', 'migration_duplicate_active_handoff_closed'
  ),
  CURRENT_TIMESTAMP
FROM "commerce_handoff_duplicate_losers" AS "loser"
INNER JOIN "Representative" AS "representative"
  ON "representative"."id" = "loser"."representativeId"
ON CONFLICT ("id") DO NOTHING;

UPDATE "HandoffRequest" AS "handoff"
SET "status" = 'CLOSED', "updatedAt" = CURRENT_TIMESTAMP
FROM "commerce_handoff_duplicate_losers" AS "loser"
WHERE "handoff"."id" = "loser"."loserId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "HandoffRequest"
    WHERE "status" IN ('OPEN', 'REVIEWING', 'ACCEPTED')
    GROUP BY
      "representativeId",
      CASE
        WHEN "audienceIdentityId" IS NOT NULL
          THEN 'audience:' || "audienceIdentityId"
        ELSE 'contact:' || "contactId"
      END
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'commerce migration could not reconcile duplicate active handoffs';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "HandoffRequest_one_active_per_audience_key"
  ON "HandoffRequest"("representativeId", "audienceIdentityId")
  WHERE
    "audienceIdentityId" IS NOT NULL
    AND "status" IN ('OPEN', 'REVIEWING', 'ACCEPTED');
CREATE UNIQUE INDEX "HandoffRequest_one_active_per_contact_key"
  ON "HandoffRequest"("representativeId", "contactId")
  WHERE
    "audienceIdentityId" IS NULL
    AND "status" IN ('OPEN', 'REVIEWING', 'ACCEPTED');

CREATE TABLE "HandoffEntitlementLedgerEntry" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "handoffRequestId" TEXT,
  "kind" "HandoffEntitlementLedgerKind" NOT NULL,
  "uses" INTEGER NOT NULL,
  "remainingAfter" INTEGER,
  "reservedAfter" INTEGER NOT NULL,
  "consumedAfter" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HandoffEntitlementLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HandoffEntitlementLedgerEntry_counters_valid" CHECK (
    "uses" > 0
    AND ("remainingAfter" IS NULL OR "remainingAfter" >= 0)
    AND "reservedAfter" >= 0
    AND "consumedAfter" >= 0
  )
);

CREATE UNIQUE INDEX "HandoffEntitlementLedgerEntry_idempotencyKey_key"
  ON "HandoffEntitlementLedgerEntry"("idempotencyKey");
CREATE INDEX "HandoffEntitlementLedgerEntry_grantId_createdAt_idx"
  ON "HandoffEntitlementLedgerEntry"("grantId", "createdAt");
CREATE INDEX "HandoffEntitlementLedgerEntry_handoffRequestId_createdAt_idx"
  ON "HandoffEntitlementLedgerEntry"("handoffRequestId", "createdAt");
CREATE INDEX "HandoffEntitlementLedgerEntry_kind_createdAt_idx"
  ON "HandoffEntitlementLedgerEntry"("kind", "createdAt");

CREATE TABLE "TipContribution" (
  "id" TEXT NOT NULL,
  "rechargeOrderId" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "agentWalletId" TEXT NOT NULL,
  "creatorEarningId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "creatorRevenueShareBps" INTEGER NOT NULL,
  "platformRevenueShareBps" INTEGER NOT NULL,
  "creatorAmountMinor" INTEGER NOT NULL,
  "platformAmountMinor" INTEGER NOT NULL,
  "status" "TipContributionStatus" NOT NULL DEFAULT 'COMPLETED',
  "idempotencyKey" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "refundedAt" TIMESTAMP(3),
  "reversedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TipContribution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TipContribution_amounts_valid" CHECK (
    "amountMinor" > 0
    AND "currency" = 'CNY'
    AND "creatorRevenueShareBps" BETWEEN 0 AND 10000
    AND "platformRevenueShareBps" BETWEEN 0 AND 10000
    AND "creatorRevenueShareBps" + "platformRevenueShareBps" = 10000
    AND "creatorAmountMinor" >= 0
    AND "platformAmountMinor" >= 0
    AND "creatorAmountMinor" + "platformAmountMinor" = "amountMinor"
    AND "creatorAmountMinor" = (
      "amountMinor"::BIGINT * "creatorRevenueShareBps"::BIGINT / 10000
    )
  ),
  CONSTRAINT "TipContribution_lifecycle_valid" CHECK (
    ("status" = 'COMPLETED' AND "refundedAt" IS NULL AND "reversedAt" IS NULL)
    OR (
      "status" = 'REFUNDED'
      AND "refundedAt" IS NOT NULL
      AND "refundedAt" >= "completedAt"
      AND "reversedAt" IS NULL
    )
    OR (
      "status" = 'REVERSED'
      AND "reversedAt" IS NOT NULL
      AND "reversedAt" >= "completedAt"
      AND "refundedAt" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "TipContribution_rechargeOrderId_key"
  ON "TipContribution"("rechargeOrderId");
CREATE UNIQUE INDEX "TipContribution_creatorEarningId_key"
  ON "TipContribution"("creatorEarningId");
CREATE UNIQUE INDEX "TipContribution_idempotencyKey_key"
  ON "TipContribution"("idempotencyKey");
CREATE INDEX "TipContribution_audienceIdentityId_representativeId_created_idx"
  ON "TipContribution"(
    "audienceIdentityId", "representativeId", "createdAt"
  );
CREATE INDEX "TipContribution_representativeId_status_createdAt_idx"
  ON "TipContribution"("representativeId", "status", "createdAt");
CREATE INDEX "TipContribution_agentWalletId_status_createdAt_idx"
  ON "TipContribution"("agentWalletId", "status", "createdAt");

ALTER TABLE "HandoffEntitlementGrant"
  ADD CONSTRAINT "HandoffEntitlementGrant_rechargeOrderId_fkey"
    FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "HandoffEntitlementGrant_audienceIdentityId_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "HandoffEntitlementGrant_representativeId_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "HandoffEntitlementGrant_billingPriceVersionId_fkey"
    FOREIGN KEY ("billingPriceVersionId") REFERENCES "BillingPriceVersion"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "HandoffRequest"
  ADD CONSTRAINT "HandoffRequest_audienceIdentityId_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "HandoffRequest_handoffEntitlementGrantId_fkey"
    FOREIGN KEY ("handoffEntitlementGrantId")
    REFERENCES "HandoffEntitlementGrant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HandoffEntitlementLedgerEntry"
  ADD CONSTRAINT "HandoffEntitlementLedgerEntry_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "HandoffEntitlementGrant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "HandoffEntitlementLedgerEntry_handoffRequestId_fkey"
    FOREIGN KEY ("handoffRequestId") REFERENCES "HandoffRequest"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "TipContribution"
  ADD CONSTRAINT "TipContribution_rechargeOrderId_fkey"
    FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TipContribution_audienceIdentityId_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TipContribution_representativeId_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TipContribution_agentWalletId_fkey"
    FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TipContribution_creatorEarningId_fkey"
    FOREIGN KEY ("creatorEarningId") REFERENCES "CreatorEarning"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A grant is a financial fulfillment record. Bind it to the exact paid order
-- snapshot on insert, and only allow its counters/status to advance afterward.
CREATE FUNCTION "enforce_handoff_entitlement_grant_binding"()
RETURNS TRIGGER AS $$
DECLARE
  "expected" RECORD;
  "sourceIdentity" RECORD;
  "targetIdentity" RECORD;
  "identityRekey" BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'HandoffEntitlementGrant rows are retained financial fulfillment records';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    "identityRekey" :=
      NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId";

    IF "identityRekey" THEN
      IF
        NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."rechargeOrderId" IS DISTINCT FROM OLD."rechargeOrderId"
        OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
        OR NEW."billingPriceVersionId" IS DISTINCT FROM OLD."billingPriceVersionId"
        OR NEW."allowance" IS DISTINCT FROM OLD."allowance"
        OR NEW."serviceLevel" IS DISTINCT FROM OLD."serviceLevel"
        OR NEW."grantedUses" IS DISTINCT FROM OLD."grantedUses"
        OR NEW."remainingUses" IS DISTINCT FROM OLD."remainingUses"
        OR NEW."reservedUses" IS DISTINCT FROM OLD."reservedUses"
        OR NEW."consumedUses" IS DISTINCT FROM OLD."consumedUses"
        OR NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
        OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      THEN
        RAISE EXCEPTION
          'HandoffEntitlementGrant identity merge may only rekey its beneficiary';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "sourceIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = OLD."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "sourceIdentity"."status" <> 'MERGED'
        OR "sourceIdentity"."mergedIntoId" IS DISTINCT FROM NEW."audienceIdentityId"
      THEN
        RAISE EXCEPTION
          'HandoffEntitlementGrant beneficiary rekey requires its merged source identity';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "targetIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = NEW."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "targetIdentity"."status" <> 'REGISTERED'
        OR "targetIdentity"."mergedIntoId" IS NOT NULL
      THEN
        RAISE EXCEPTION
          'HandoffEntitlementGrant beneficiary rekey requires a canonical registered target';
      END IF;
    ELSIF
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."rechargeOrderId" IS DISTINCT FROM OLD."rechargeOrderId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."billingPriceVersionId" IS DISTINCT FROM OLD."billingPriceVersionId"
      OR NEW."allowance" IS DISTINCT FROM OLD."allowance"
      OR NEW."serviceLevel" IS DISTINCT FROM OLD."serviceLevel"
      OR NEW."grantedUses" IS DISTINCT FROM OLD."grantedUses"
      OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION
        'HandoffEntitlementGrant order, beneficiary, terms, and time window are immutable';
    END IF;

    IF
      (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'FROZEN', 'EXHAUSTED', 'EXPIRED'))
      OR (OLD."status" = 'FROZEN' AND NEW."status" NOT IN ('FROZEN', 'ACTIVE', 'EXPIRED', 'REFUNDED'))
      OR (OLD."status" = 'EXPIRED' AND NEW."status" NOT IN ('EXPIRED', 'FROZEN'))
      OR (OLD."status" IN ('EXHAUSTED', 'REFUNDED') AND NEW."status" <> OLD."status")
    THEN
      RAISE EXCEPTION
        'HandoffEntitlementGrant status transition is invalid';
    END IF;

    IF NOT "identityRekey" THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT
    "order"."status" AS "orderStatus",
    "order"."representativeId" AS "representativeId",
    "order"."billingPriceVersionId" AS "billingPriceVersionId",
    "order"."productKindSnapshot" AS "productKind",
    "order"."handoffAllowanceSnapshot" AS "allowance",
    "order"."handoffUnitsSnapshot" AS "handoffUnits",
    "order"."handoffServiceLevelSnapshot" AS "serviceLevel",
    "order"."handoffValidityDaysSnapshot" AS "validityDays",
    "order"."paidAt" AS "paidAt",
    "wallet"."audienceIdentityId" AS "audienceIdentityId"
  INTO "expected"
  FROM "RechargeOrder" AS "order"
  INNER JOIN "UserWallet" AS "wallet" ON "wallet"."id" = "order"."userWalletId"
  INNER JOIN "BillingPriceVersion" AS "price"
    ON "price"."id" = "order"."billingPriceVersionId"
    AND "price"."billingProductId" = "order"."billingProductId"
  WHERE "order"."id" = NEW."rechargeOrderId"
  FOR SHARE OF "order", "wallet", "price";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HandoffEntitlementGrant recharge order was not found';
  END IF;

  IF
    (
      NOT "identityRekey"
      AND "expected"."orderStatus" <> 'PAID'
    )
    OR (
      "identityRekey"
      AND "expected"."orderStatus" NOT IN ('PAID', 'REFUNDED')
    )
    OR "expected"."productKind" <> 'SERVICE_PACKAGE'
    OR "expected"."allowance" NOT IN ('LIMITED', 'UNLIMITED')
    OR "expected"."audienceIdentityId" IS NULL
    OR NEW."representativeId" IS DISTINCT FROM "expected"."representativeId"
    OR NEW."billingPriceVersionId" IS DISTINCT FROM "expected"."billingPriceVersionId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM "expected"."audienceIdentityId"
    OR NEW."allowance" IS DISTINCT FROM "expected"."allowance"
    OR NEW."serviceLevel" IS DISTINCT FROM "expected"."serviceLevel"
    OR NEW."grantedUses" IS DISTINCT FROM "expected"."handoffUnits"
    OR (
      NOT "identityRekey"
      AND (
        (
          NEW."allowance" = 'LIMITED'
          AND NEW."remainingUses" IS DISTINCT FROM NEW."grantedUses"
        )
        OR NEW."reservedUses" <> 0
        OR NEW."consumedUses" <> 0
        OR NEW."status" <> 'ACTIVE'
      )
    )
    OR "expected"."validityDays" IS NULL
    OR "expected"."paidAt" IS NULL
    OR NEW."startsAt" IS DISTINCT FROM "expected"."paidAt"
    OR NEW."expiresAt" IS DISTINCT FROM (
      NEW."startsAt" + make_interval(days => "expected"."validityDays")
    )
  THEN
    RAISE EXCEPTION
      'HandoffEntitlementGrant does not match its paid service-package snapshot';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HandoffEntitlementGrant_binding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "HandoffEntitlementGrant"
  FOR EACH ROW EXECUTE FUNCTION "enforce_handoff_entitlement_grant_binding"();

-- Paid handoff requests may only use a grant for the same canonical audience
-- and representative, and reservation evidence advances monotonically.
CREATE FUNCTION "enforce_handoff_request_entitlement_binding"()
RETURNS TRIGGER AS $$
DECLARE
  "grant" RECORD;
  "contact" RECORD;
  "conversation" RECORD;
  "sourceIdentity" RECORD;
  "targetIdentity" RECORD;
  "identityRekey" BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HandoffRequest rows are retained handoff audit records';
  END IF;

  IF
    TG_OP = 'UPDATE'
    AND (
      (OLD."status" = 'OPEN' AND NEW."status" NOT IN ('OPEN', 'REVIEWING', 'ACCEPTED', 'DECLINED', 'CLOSED'))
      OR (OLD."status" = 'REVIEWING' AND NEW."status" NOT IN ('REVIEWING', 'ACCEPTED', 'DECLINED', 'CLOSED'))
      OR (OLD."status" = 'ACCEPTED' AND NEW."status" NOT IN ('ACCEPTED', 'CLOSED'))
      OR (OLD."status" IN ('DECLINED', 'CLOSED') AND NEW."status" <> OLD."status")
    )
  THEN
    RAISE EXCEPTION 'HandoffRequest status transition is invalid';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    "identityRekey" :=
      NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId";
    IF "identityRekey" THEN
      IF
        NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
        OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
        OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
        OR NEW."episodeId" IS DISTINCT FROM OLD."episodeId"
        OR NEW."intakeSubmissionId" IS DISTINCT FROM OLD."intakeSubmissionId"
        OR NEW."handoffEntitlementGrantId" IS DISTINCT FROM OLD."handoffEntitlementGrantId"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."summary" IS DISTINCT FROM OLD."summary"
        OR NEW."recommendedPriority" IS DISTINCT FROM OLD."recommendedPriority"
        OR NEW."recommendedOwnerAction" IS DISTINCT FROM OLD."recommendedOwnerAction"
        OR NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."entitlementReservationState" IS DISTINCT FROM OLD."entitlementReservationState"
        OR NEW."serviceLevelSnapshot" IS DISTINCT FROM OLD."serviceLevelSnapshot"
        OR NEW."entitlementReservedAt" IS DISTINCT FROM OLD."entitlementReservedAt"
        OR NEW."entitlementConsumedAt" IS DISTINCT FROM OLD."entitlementConsumedAt"
        OR NEW."entitlementReleasedAt" IS DISTINCT FROM OLD."entitlementReleasedAt"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      THEN
        RAISE EXCEPTION
          'HandoffRequest identity merge may only rekey its audience';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "sourceIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = OLD."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "sourceIdentity"."status" <> 'MERGED'
        OR "sourceIdentity"."mergedIntoId" IS DISTINCT FROM NEW."audienceIdentityId"
      THEN
        RAISE EXCEPTION
          'HandoffRequest audience rekey requires its merged source identity';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "targetIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = NEW."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "targetIdentity"."status" <> 'REGISTERED'
        OR "targetIdentity"."mergedIntoId" IS NOT NULL
      THEN
        RAISE EXCEPTION
          'HandoffRequest audience rekey requires a canonical registered target';
      END IF;
    END IF;
  END IF;

  IF
    TG_OP = 'UPDATE'
    AND OLD."handoffEntitlementGrantId" IS NOT NULL
    AND (
      NEW."handoffEntitlementGrantId" IS DISTINCT FROM OLD."handoffEntitlementGrantId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."serviceLevelSnapshot" IS DISTINCT FROM OLD."serviceLevelSnapshot"
      OR NEW."entitlementReservedAt" IS DISTINCT FROM OLD."entitlementReservedAt"
      OR (
        OLD."entitlementReservationState" IN ('CONSUMED', 'RELEASED')
        AND NEW."entitlementReservationState" <> OLD."entitlementReservationState"
      )
      OR (
        OLD."entitlementConsumedAt" IS NOT NULL
        AND NEW."entitlementConsumedAt" IS DISTINCT FROM OLD."entitlementConsumedAt"
      )
      OR (
        OLD."entitlementReleasedAt" IS NOT NULL
        AND NEW."entitlementReleasedAt" IS DISTINCT FROM OLD."entitlementReleasedAt"
      )
    )
  THEN
    RAISE EXCEPTION
      'Paid HandoffRequest entitlement coordinates and terminal evidence are immutable';
  END IF;

  SELECT "representativeId", "audienceIdentityId"
  INTO "contact"
  FROM "Contact"
  WHERE "id" = NEW."contactId"
  FOR SHARE;

  IF
    TG_OP = 'INSERT'
    AND NEW."audienceIdentityId" IS NULL
    AND "contact"."audienceIdentityId" IS NOT NULL
  THEN
    NEW."audienceIdentityId" := "contact"."audienceIdentityId";
  END IF;

  IF
    NOT FOUND
    OR NEW."representativeId" IS DISTINCT FROM "contact"."representativeId"
    OR (
      NEW."audienceIdentityId" IS NOT NULL
      AND NEW."audienceIdentityId" IS DISTINCT FROM "contact"."audienceIdentityId"
    )
  THEN
    RAISE EXCEPTION 'HandoffRequest contact does not match its representative or audience';
  END IF;

  IF NEW."conversationId" IS NOT NULL THEN
    SELECT "representativeId", "contactId", "audienceIdentityId"
    INTO "conversation"
    FROM "Conversation"
    WHERE "id" = NEW."conversationId"
    FOR SHARE;

    IF
      NOT FOUND
      OR NEW."representativeId" IS DISTINCT FROM "conversation"."representativeId"
      OR NEW."contactId" IS DISTINCT FROM "conversation"."contactId"
      OR (
        NEW."audienceIdentityId" IS NOT NULL
        AND NEW."audienceIdentityId" IS DISTINCT FROM "conversation"."audienceIdentityId"
      )
    THEN
      RAISE EXCEPTION 'HandoffRequest conversation does not match its canonical scope';
    END IF;
  END IF;

  IF NEW."handoffEntitlementGrantId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    "audienceIdentityId", "representativeId", "serviceLevel", "allowance",
    "status", "startsAt", "expiresAt", "remainingUses", "reservedUses",
    "consumedUses"
  INTO "grant"
  FROM "HandoffEntitlementGrant"
  WHERE "id" = NEW."handoffEntitlementGrantId"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paid HandoffRequest grant was not found';
  END IF;

  IF
    NEW."audienceIdentityId" IS DISTINCT FROM "grant"."audienceIdentityId"
    OR NEW."representativeId" IS DISTINCT FROM "grant"."representativeId"
    OR NEW."serviceLevelSnapshot" IS DISTINCT FROM "grant"."serviceLevel"
    OR NEW."audienceIdentityId" IS NULL
    OR NEW."entitlementConsumedAt" IS NOT NULL
      AND NEW."entitlementConsumedAt" < NEW."entitlementReservedAt"
    OR NEW."entitlementReleasedAt" IS NOT NULL
      AND NEW."entitlementReleasedAt" < NEW."entitlementReservedAt"
    OR (
      NEW."entitlementReservationState" = 'RESERVED'
      AND (
        NEW."status" NOT IN ('OPEN', 'REVIEWING')
        OR "grant"."reservedUses" < 1
        OR (
          (
            TG_OP = 'INSERT'
            OR OLD."entitlementReservationState" IS DISTINCT FROM 'RESERVED'
          )
          AND (
            "grant"."status" <> 'ACTIVE'
            OR "grant"."startsAt" > CURRENT_TIMESTAMP
            OR "grant"."expiresAt" <= CURRENT_TIMESTAMP
          )
        )
      )
    )
    OR (
      NEW."entitlementReservationState" = 'CONSUMED'
      AND NEW."status" NOT IN ('ACCEPTED', 'CLOSED')
    )
    OR (
      NEW."entitlementReservationState" = 'RELEASED'
      AND NEW."status" NOT IN ('DECLINED', 'CLOSED')
    )
  THEN
    RAISE EXCEPTION
      'Paid HandoffRequest does not match its grant or reservation state';
  END IF;

  IF
    NEW."status" IN ('OPEN', 'REVIEWING', 'ACCEPTED')
    AND EXISTS (
      SELECT 1
      FROM "HandoffRequest" AS "other"
      WHERE
        "other"."id" <> NEW."id"
        AND "other"."representativeId" = NEW."representativeId"
        AND "other"."audienceIdentityId" = NEW."audienceIdentityId"
        AND "other"."status" IN ('OPEN', 'REVIEWING', 'ACCEPTED')
    )
  THEN
    RAISE EXCEPTION
      'A paid handoff cannot overlap another active handoff for the audience';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HandoffRequest_entitlement_binding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "HandoffRequest"
  FOR EACH ROW EXECUTE FUNCTION "enforce_handoff_request_entitlement_binding"();

-- The entitlement ledger is append-only and every row must be an exact
-- post-transition receipt for its grant/request pair.
CREATE FUNCTION "enforce_handoff_entitlement_ledger_append_only"()
RETURNS TRIGGER AS $$
DECLARE
  "grant" RECORD;
  "request" RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HandoffEntitlementLedgerEntry rows are append-only';
  END IF;

  SELECT
    "allowance", "grantedUses", "remainingUses", "reservedUses",
    "consumedUses", "status"
  INTO "grant"
  FROM "HandoffEntitlementGrant"
  WHERE "id" = NEW."grantId"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Handoff entitlement ledger grant was not found';
  END IF;

  IF NEW."handoffRequestId" IS NOT NULL THEN
    SELECT "handoffEntitlementGrantId", "entitlementReservationState"
    INTO "request"
    FROM "HandoffRequest"
    WHERE "id" = NEW."handoffRequestId"
    FOR SHARE;

    IF
      NOT FOUND
      OR "request"."handoffEntitlementGrantId" IS DISTINCT FROM NEW."grantId"
      OR NEW."kind" NOT IN ('RESERVE', 'CONSUME', 'RELEASE')
      OR NEW."uses" <> 1
      OR (
        NEW."kind" = 'RESERVE'
        AND "request"."entitlementReservationState" <> 'RESERVED'
      )
      OR (
        NEW."kind" = 'CONSUME'
        AND "request"."entitlementReservationState" <> 'CONSUMED'
      )
      OR (
        NEW."kind" = 'RELEASE'
        AND "request"."entitlementReservationState" <> 'RELEASED'
      )
    THEN
      RAISE EXCEPTION
        'Handoff entitlement ledger request does not match its grant or event kind';
    END IF;
  ELSIF NEW."kind" IN ('RESERVE', 'CONSUME', 'RELEASE') THEN
    RAISE EXCEPTION
      'Reserve, consume, and release ledger entries require a handoff request';
  END IF;

  IF
    NEW."kind" = 'GRANT'
    AND (
      NEW."handoffRequestId" IS NOT NULL
      OR NEW."uses" IS DISTINCT FROM COALESCE("grant"."grantedUses", 1)
      OR "grant"."status" <> 'ACTIVE'
      OR "grant"."reservedUses" <> 0
      OR "grant"."consumedUses" <> 0
    )
  THEN
    RAISE EXCEPTION 'Handoff grant ledger entry does not match initial grant state';
  END IF;

  IF
    (NEW."kind" = 'REFUND' AND "grant"."status" <> 'REFUNDED')
    OR (NEW."kind" = 'EXPIRE' AND "grant"."status" <> 'EXPIRED')
  THEN
    RAISE EXCEPTION 'Handoff terminal ledger entry does not match grant status';
  END IF;

  IF
    NEW."remainingAfter" IS DISTINCT FROM "grant"."remainingUses"
    OR NEW."reservedAfter" IS DISTINCT FROM "grant"."reservedUses"
    OR NEW."consumedAfter" IS DISTINCT FROM "grant"."consumedUses"
  THEN
    RAISE EXCEPTION
      'Handoff entitlement ledger counters do not match the current grant';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HandoffEntitlementLedgerEntry_append_only_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "HandoffEntitlementLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "enforce_handoff_entitlement_ledger_append_only"();

-- At transaction commit, every grant counter and every paid request state must
-- have an append-only receipt. Deferred checks allow the application to update
-- counters/state first and append the receipt later in the same transaction.
CREATE FUNCTION "verify_handoff_entitlement_audit_closure"()
RETURNS TRIGGER AS $$
DECLARE
  "currentGrant" RECORD;
  "reservedRequestCount" INTEGER;
  "consumedRequestCount" INTEGER;
BEGIN
  SELECT
    "allowance", "grantedUses", "remainingUses", "reservedUses",
    "consumedUses", "status"
  INTO "currentGrant"
  FROM "HandoffEntitlementGrant"
  WHERE "id" = NEW."id";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE "entitlementReservationState" = 'RESERVED'
    )::INTEGER,
    COUNT(*) FILTER (
      WHERE "entitlementReservationState" = 'CONSUMED'
    )::INTEGER
  INTO "reservedRequestCount", "consumedRequestCount"
  FROM "HandoffRequest"
  WHERE "handoffEntitlementGrantId" = NEW."id";

  IF
    "currentGrant"."reservedUses" <> "reservedRequestCount"
    OR "currentGrant"."consumedUses" <> "consumedRequestCount"
    OR NOT EXISTS (
      SELECT 1
      FROM "HandoffEntitlementLedgerEntry" AS "entry"
      WHERE
        "entry"."grantId" = NEW."id"
        AND "entry"."remainingAfter" IS NOT DISTINCT FROM "currentGrant"."remainingUses"
        AND "entry"."reservedAfter" = "currentGrant"."reservedUses"
        AND "entry"."consumedAfter" = "currentGrant"."consumedUses"
    )
    OR (
      "currentGrant"."status" = 'REFUNDED'
      AND NOT EXISTS (
        SELECT 1
        FROM "HandoffEntitlementLedgerEntry" AS "entry"
        WHERE
          "entry"."grantId" = NEW."id"
          AND "entry"."kind" = 'REFUND'
          AND "entry"."remainingAfter" IS NOT DISTINCT FROM "currentGrant"."remainingUses"
          AND "entry"."reservedAfter" = "currentGrant"."reservedUses"
          AND "entry"."consumedAfter" = "currentGrant"."consumedUses"
      )
    )
    OR (
      "currentGrant"."status" = 'EXPIRED'
      AND NOT EXISTS (
        SELECT 1
        FROM "HandoffEntitlementLedgerEntry" AS "entry"
        WHERE
          "entry"."grantId" = NEW."id"
          AND "entry"."kind" = 'EXPIRE'
          AND "entry"."remainingAfter" IS NOT DISTINCT FROM "currentGrant"."remainingUses"
          AND "entry"."reservedAfter" = "currentGrant"."reservedUses"
          AND "entry"."consumedAfter" = "currentGrant"."consumedUses"
      )
    )
  THEN
    RAISE EXCEPTION
      'Handoff entitlement grant counters are not closed by requests and ledger evidence';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "HandoffEntitlementGrant_audit_closure_guard"
  AFTER INSERT OR UPDATE ON "HandoffEntitlementGrant"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verify_handoff_entitlement_audit_closure"();

CREATE FUNCTION "verify_handoff_request_audit_closure"()
RETURNS TRIGGER AS $$
DECLARE
  "expectedKind" "HandoffEntitlementLedgerKind";
  "currentRequest" RECORD;
BEGIN
  SELECT
    "handoffEntitlementGrantId", "entitlementReservationState"
  INTO "currentRequest"
  FROM "HandoffRequest"
  WHERE "id" = NEW."id";

  IF
    NOT FOUND
    OR "currentRequest"."handoffEntitlementGrantId" IS NULL
  THEN
    RETURN NULL;
  END IF;

  "expectedKind" := CASE "currentRequest"."entitlementReservationState"
    WHEN 'RESERVED' THEN 'RESERVE'::"HandoffEntitlementLedgerKind"
    WHEN 'CONSUMED' THEN 'CONSUME'::"HandoffEntitlementLedgerKind"
    WHEN 'RELEASED' THEN 'RELEASE'::"HandoffEntitlementLedgerKind"
  END;

  IF
    "expectedKind" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "HandoffEntitlementLedgerEntry" AS "entry"
      WHERE
        "entry"."handoffRequestId" = NEW."id"
        AND "entry"."grantId" = "currentRequest"."handoffEntitlementGrantId"
        AND "entry"."kind" = "expectedKind"
        AND "entry"."uses" = 1
    )
  THEN
    RAISE EXCEPTION
      'Paid HandoffRequest state is not closed by matching ledger evidence';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "HandoffRequest_audit_closure_guard"
  AFTER INSERT OR UPDATE ON "HandoffRequest"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verify_handoff_request_audit_closure"();

-- Tips are non-entitling financial receipts. Cross-check the paid TIP order,
-- beneficiary, wallet, and immediately-withdrawable creator earning.
CREATE FUNCTION "enforce_tip_contribution_binding"()
RETURNS TRIGGER AS $$
DECLARE
  "expected" RECORD;
  "sourceIdentity" RECORD;
  "targetIdentity" RECORD;
  "identityRekey" BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TipContribution rows are retained financial receipts';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    "identityRekey" :=
      NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId";
    IF "identityRekey" THEN
      IF
        NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."rechargeOrderId" IS DISTINCT FROM OLD."rechargeOrderId"
        OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
        OR NEW."agentWalletId" IS DISTINCT FROM OLD."agentWalletId"
        OR NEW."creatorEarningId" IS DISTINCT FROM OLD."creatorEarningId"
        OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
        OR NEW."currency" IS DISTINCT FROM OLD."currency"
        OR NEW."creatorRevenueShareBps" IS DISTINCT FROM OLD."creatorRevenueShareBps"
        OR NEW."platformRevenueShareBps" IS DISTINCT FROM OLD."platformRevenueShareBps"
        OR NEW."creatorAmountMinor" IS DISTINCT FROM OLD."creatorAmountMinor"
        OR NEW."platformAmountMinor" IS DISTINCT FROM OLD."platformAmountMinor"
        OR NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
        OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
        OR NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt"
        OR NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      THEN
        RAISE EXCEPTION
          'TipContribution identity merge may only rekey its contributor';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "sourceIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = OLD."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "sourceIdentity"."status" <> 'MERGED'
        OR "sourceIdentity"."mergedIntoId" IS DISTINCT FROM NEW."audienceIdentityId"
      THEN
        RAISE EXCEPTION
          'TipContribution contributor rekey requires its merged source identity';
      END IF;

      SELECT "status", "mergedIntoId"
      INTO "targetIdentity"
      FROM "AudienceIdentity"
      WHERE "id" = NEW."audienceIdentityId"
      FOR SHARE;
      IF
        NOT FOUND
        OR "targetIdentity"."status" <> 'REGISTERED'
        OR "targetIdentity"."mergedIntoId" IS NOT NULL
      THEN
        RAISE EXCEPTION
          'TipContribution contributor rekey requires a canonical registered target';
      END IF;
    ELSIF
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."rechargeOrderId" IS DISTINCT FROM OLD."rechargeOrderId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."agentWalletId" IS DISTINCT FROM OLD."agentWalletId"
      OR NEW."creatorEarningId" IS DISTINCT FROM OLD."creatorEarningId"
      OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."creatorRevenueShareBps" IS DISTINCT FROM OLD."creatorRevenueShareBps"
      OR NEW."platformRevenueShareBps" IS DISTINCT FROM OLD."platformRevenueShareBps"
      OR NEW."creatorAmountMinor" IS DISTINCT FROM OLD."creatorAmountMinor"
      OR NEW."platformAmountMinor" IS DISTINCT FROM OLD."platformAmountMinor"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR (
        OLD."refundedAt" IS NOT NULL
        AND NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt"
      )
      OR (
        OLD."reversedAt" IS NOT NULL
        AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt"
      )
      OR (
        OLD."status" <> 'COMPLETED'
        AND NEW."status" <> OLD."status"
      )
    THEN
      RAISE EXCEPTION
        'TipContribution commercial coordinates and terminal state are immutable';
    END IF;

    IF
      NEW."status" IN ('REFUNDED', 'REVERSED')
      AND NOT EXISTS (
        SELECT 1
        FROM "CreatorEarning" AS "earning"
        WHERE
          "earning"."id" = NEW."creatorEarningId"
          AND "earning"."status" = 'REVERSED'
          AND "earning"."pendingCents" = 0
          AND "earning"."withdrawableCents" = 0
          AND "earning"."frozenCents" = 0
          AND "earning"."withdrawnCents" = 0
      )
    THEN
      RAISE EXCEPTION
        'TipContribution cannot become terminal before creator earning reversal';
    END IF;

    IF NOT "identityRekey" THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT
    "order"."status" AS "orderStatus",
    "order"."representativeId" AS "representativeId",
    "order"."productKindSnapshot" AS "productKind",
    "order"."amountCents" AS "amountMinor",
    "order"."currency" AS "currency",
    "order"."creatorRevenueShareBpsSnapshot" AS "creatorRevenueShareBps",
    "order"."platformRevenueShareBpsSnapshot" AS "platformRevenueShareBps",
    "wallet"."audienceIdentityId" AS "audienceIdentityId",
    "agentWallet"."id" AS "agentWalletId",
    "representative"."ownerId" AS "representativeOwnerId",
    "earning"."ownerId" AS "earningOwnerId",
    "earning"."representativeId" AS "earningRepresentativeId",
    "earning"."agentWalletId" AS "earningAgentWalletId",
    "earning"."status" AS "earningStatus",
    "earning"."pendingCents" AS "pendingCents",
    "earning"."withdrawableCents" AS "withdrawableCents",
    "earning"."frozenCents" AS "frozenCents",
    "earning"."withdrawnCents" AS "withdrawnCents",
    "earning"."currency" AS "earningCurrency",
    "earning"."revenueShareBps" AS "earningRevenueShareBps",
    "earning"."tokenPurchaseId" AS "tokenPurchaseId",
    "earning"."usageChargeId" AS "usageChargeId"
  INTO "expected"
  FROM "RechargeOrder" AS "order"
  INNER JOIN "UserWallet" AS "wallet" ON "wallet"."id" = "order"."userWalletId"
  INNER JOIN "AgentWallet" AS "agentWallet"
    ON "agentWallet"."representativeId" = "order"."representativeId"
  INNER JOIN "Representative" AS "representative"
    ON "representative"."id" = "order"."representativeId"
  INNER JOIN "CreatorEarning" AS "earning" ON "earning"."id" = NEW."creatorEarningId"
  INNER JOIN "BillingPriceVersion" AS "price"
    ON "price"."id" = "order"."billingPriceVersionId"
    AND "price"."billingProductId" = "order"."billingProductId"
  WHERE "order"."id" = NEW."rechargeOrderId"
  FOR SHARE OF "order", "wallet", "agentWallet", "representative", "earning", "price";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TipContribution order, wallet, or earning was not found';
  END IF;

  IF
    (
      NOT "identityRekey"
      AND "expected"."orderStatus" <> 'PAID'
    )
    OR (
      "identityRekey"
      AND (
        (NEW."status" = 'COMPLETED' AND "expected"."orderStatus" <> 'PAID')
        OR (
          NEW."status" IN ('REFUNDED', 'REVERSED')
          AND "expected"."orderStatus" <> 'REFUNDED'
        )
      )
    )
    OR "expected"."productKind" <> 'TIP'
    OR "expected"."audienceIdentityId" IS NULL
    OR NEW."representativeId" IS DISTINCT FROM "expected"."representativeId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM "expected"."audienceIdentityId"
    OR NEW."agentWalletId" IS DISTINCT FROM "expected"."agentWalletId"
    OR NEW."amountMinor" IS DISTINCT FROM "expected"."amountMinor"
    OR NEW."currency" IS DISTINCT FROM "expected"."currency"
    OR NEW."creatorRevenueShareBps" IS DISTINCT FROM "expected"."creatorRevenueShareBps"
    OR NEW."platformRevenueShareBps" IS DISTINCT FROM "expected"."platformRevenueShareBps"
    OR "expected"."earningOwnerId" IS DISTINCT FROM "expected"."representativeOwnerId"
    OR NEW."representativeId" IS DISTINCT FROM "expected"."earningRepresentativeId"
    OR NEW."agentWalletId" IS DISTINCT FROM "expected"."earningAgentWalletId"
    OR (
      NOT "identityRekey"
      AND (
        "expected"."earningStatus" <> 'WITHDRAWABLE'
        OR "expected"."pendingCents" <> 0
        OR "expected"."withdrawableCents" IS DISTINCT FROM NEW."creatorAmountMinor"
        OR "expected"."frozenCents" <> 0
        OR "expected"."withdrawnCents" <> 0
      )
    )
    OR (
      "identityRekey"
      AND (
        (
          NEW."status" = 'COMPLETED'
          AND (
            "expected"."earningStatus" = 'REVERSED'
            OR (
              "expected"."pendingCents"
              + "expected"."withdrawableCents"
              + "expected"."frozenCents"
              + "expected"."withdrawnCents"
            ) IS DISTINCT FROM NEW."creatorAmountMinor"
          )
        )
        OR (
          NEW."status" IN ('REFUNDED', 'REVERSED')
          AND NOT (
            "expected"."earningStatus" = 'REVERSED'
            AND "expected"."pendingCents" = 0
            AND "expected"."withdrawableCents" = 0
            AND "expected"."frozenCents" = 0
            AND "expected"."withdrawnCents" = 0
          )
        )
      )
    )
    OR "expected"."earningCurrency" IS DISTINCT FROM NEW."currency"
    OR "expected"."earningRevenueShareBps" IS DISTINCT FROM NEW."creatorRevenueShareBps"
    OR "expected"."tokenPurchaseId" IS NOT NULL
    OR "expected"."usageChargeId" IS NOT NULL
    OR (
      NOT "identityRekey"
      AND (
        NEW."status" <> 'COMPLETED'
        OR NEW."refundedAt" IS NOT NULL
        OR NEW."reversedAt" IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION
      'TipContribution does not match its paid tip order and creator earning';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TipContribution_binding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "TipContribution"
  FOR EACH ROW EXECUTE FUNCTION "enforce_tip_contribution_binding"();

COMMIT;
