-- Prisma does not wrap PostgreSQL migrations in a transaction automatically.
-- Keep the new types, tables, triggers, order columns, and bootstrap rows
-- atomic so a failed deploy can be retried without manual schema repair.
BEGIN;

CREATE TYPE "BillingProductStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'ARCHIVED'
);

CREATE TYPE "BillingPriceVersionStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'RETIRED'
);

CREATE TYPE "BillingRefundPolicy" AS ENUM (
  'FULL_WHEN_UNUSED'
);

CREATE TYPE "BillingEntitlementExpiryPolicy" AS ENUM (
  'NEVER_EXPIRES'
);

-- A product is the stable commercial identity of one service-package tier.
-- Products are archived instead of being reused for a different entitlement.
CREATE TABLE "BillingProduct" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "BillingProductStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingProduct_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingProduct_code_nonempty" CHECK (
    LENGTH(BTRIM("code")) > 0
  ),
  CONSTRAINT "BillingProduct_name_nonempty" CHECK (
    LENGTH(BTRIM("name")) > 0
  )
);

CREATE UNIQUE INDEX "BillingProduct_representativeId_code_key"
  ON "BillingProduct"("representativeId", "code");

CREATE INDEX "BillingProduct_representativeId_status_updatedAt_idx"
  ON "BillingProduct"("representativeId", "status", "updatedAt");

ALTER TABLE "BillingProduct"
  ADD CONSTRAINT "BillingProduct_representativeId_fkey"
  FOREIGN KEY ("representativeId")
  REFERENCES "Representative"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_billing_product_stability"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'BillingProduct rows are stable identities and must be archived, not deleted';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'BillingProduct id, representative, code, and creation time are immutable';
  END IF;

  IF
    (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'ARCHIVED'))
    OR (OLD."status" = 'ARCHIVED' AND NEW."status" <> 'ARCHIVED')
  THEN
    RAISE EXCEPTION
      'BillingProduct status cannot move backward or reactivate an archived product';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BillingProduct_stability"
  BEFORE UPDATE OR DELETE ON "BillingProduct"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_billing_product_stability"();

-- A price version freezes every commercial input needed by fulfillment,
-- refunds, revenue sharing, and later audit. Commercial columns are protected
-- by a trigger below; publishing creates a forward-only lifecycle.
CREATE TABLE "BillingPriceVersion" (
  "id" TEXT NOT NULL,
  "billingProductId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "BillingPriceVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "amountMinor" INTEGER NOT NULL,
  "unitName" TEXT NOT NULL DEFAULT 'credit',
  "entitlementUnits" INTEGER NOT NULL,
  "creatorRevenueShareBps" INTEGER NOT NULL DEFAULT 2000,
  "platformRevenueShareBps" INTEGER NOT NULL DEFAULT 8000,
  "refundPolicy" "BillingRefundPolicy" NOT NULL DEFAULT 'FULL_WHEN_UNUSED',
  "expiryPolicy" "BillingEntitlementExpiryPolicy" NOT NULL DEFAULT 'NEVER_EXPIRES',
  "entitlementValidityDays" INTEGER,
  "publishedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BillingPriceVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingPriceVersion_version_positive" CHECK (
    "version" > 0
  ),
  CONSTRAINT "BillingPriceVersion_v1_currency" CHECK (
    "currency" = 'CNY'
  ),
  CONSTRAINT "BillingPriceVersion_amount_positive" CHECK (
    "amountMinor" > 0
  ),
  CONSTRAINT "BillingPriceVersion_v1_unit" CHECK (
    "unitName" = 'credit'
  ),
  CONSTRAINT "BillingPriceVersion_entitlement_positive" CHECK (
    "entitlementUnits" > 0
  ),
  CONSTRAINT "BillingPriceVersion_integer_unit_price" CHECK (
    MOD("amountMinor", "entitlementUnits") = 0
  ),
  CONSTRAINT "BillingPriceVersion_revenue_share_valid" CHECK (
    "creatorRevenueShareBps" BETWEEN 0 AND 10000
    AND "platformRevenueShareBps" BETWEEN 0 AND 10000
    AND "creatorRevenueShareBps" + "platformRevenueShareBps" = 10000
  ),
  CONSTRAINT "BillingPriceVersion_v1_expiry_valid" CHECK (
    "expiryPolicy" = 'NEVER_EXPIRES'
    AND "entitlementValidityDays" IS NULL
  ),
  CONSTRAINT "BillingPriceVersion_lifecycle_valid" CHECK (
    (
      "status" = 'DRAFT'
      AND "publishedAt" IS NULL
      AND "retiredAt" IS NULL
    )
    OR (
      "status" = 'ACTIVE'
      AND "publishedAt" IS NOT NULL
      AND "retiredAt" IS NULL
    )
    OR (
      "status" = 'RETIRED'
      AND "publishedAt" IS NOT NULL
      AND "retiredAt" IS NOT NULL
      AND "retiredAt" >= "publishedAt"
    )
  )
);

CREATE UNIQUE INDEX "BillingPriceVersion_billingProductId_version_key"
  ON "BillingPriceVersion"("billingProductId", "version");

CREATE INDEX "BillingPriceVersion_billingProductId_status_createdAt_idx"
  ON "BillingPriceVersion"("billingProductId", "status", "createdAt");

CREATE INDEX "BillingPriceVersion_status_currency_createdAt_idx"
  ON "BillingPriceVersion"("status", "currency", "createdAt");

CREATE UNIQUE INDEX "BillingPriceVersion_one_active_per_product_key"
  ON "BillingPriceVersion"("billingProductId")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "BillingPriceVersion"
  ADD CONSTRAINT "BillingPriceVersion_billingProductId_fkey"
  FOREIGN KEY ("billingProductId")
  REFERENCES "BillingProduct"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_billing_price_version_immutability"()
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

CREATE TRIGGER "BillingPriceVersion_immutability"
  BEFORE UPDATE OR DELETE ON "BillingPriceVersion"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_billing_price_version_immutability"();

-- Existing orders remain valid with every new column NULL. New product-bound
-- orders write a complete commercial snapshot before contacting the provider.
ALTER TABLE "RechargeOrder"
  ADD COLUMN "billingProductId" TEXT,
  ADD COLUMN "billingPriceVersionId" TEXT,
  ADD COLUMN "productNameSnapshot" TEXT,
  ADD COLUMN "unitNameSnapshot" TEXT,
  ADD COLUMN "entitlementUnitsSnapshot" INTEGER,
  ADD COLUMN "creatorRevenueShareBpsSnapshot" INTEGER,
  ADD COLUMN "platformRevenueShareBpsSnapshot" INTEGER,
  ADD COLUMN "refundPolicySnapshot" "BillingRefundPolicy",
  ADD COLUMN "expiryPolicySnapshot" "BillingEntitlementExpiryPolicy",
  ADD COLUMN "entitlementValidityDaysSnapshot" INTEGER;

ALTER TABLE "RechargeOrder"
  ADD CONSTRAINT "RechargeOrder_billing_snapshot_complete" CHECK (
    (
      "billingProductId" IS NULL
      AND "billingPriceVersionId" IS NULL
      AND "productNameSnapshot" IS NULL
      AND "unitNameSnapshot" IS NULL
      AND "entitlementUnitsSnapshot" IS NULL
      AND "creatorRevenueShareBpsSnapshot" IS NULL
      AND "platformRevenueShareBpsSnapshot" IS NULL
      AND "refundPolicySnapshot" IS NULL
      AND "expiryPolicySnapshot" IS NULL
      AND "entitlementValidityDaysSnapshot" IS NULL
    )
    OR (
      "billingProductId" IS NOT NULL
      AND "billingPriceVersionId" IS NOT NULL
      AND "currency" = 'CNY'
      AND "amountCents" > 0
      AND "productNameSnapshot" IS NOT NULL
      AND LENGTH(BTRIM("productNameSnapshot")) > 0
      AND "unitNameSnapshot" IS NOT NULL
      AND "unitNameSnapshot" = 'credit'
      AND "entitlementUnitsSnapshot" IS NOT NULL
      AND "entitlementUnitsSnapshot" > 0
      AND MOD("amountCents", "entitlementUnitsSnapshot") = 0
      AND "creatorRevenueShareBpsSnapshot" IS NOT NULL
      AND "creatorRevenueShareBpsSnapshot" BETWEEN 0 AND 10000
      AND "platformRevenueShareBpsSnapshot" IS NOT NULL
      AND "platformRevenueShareBpsSnapshot" BETWEEN 0 AND 10000
      AND (
        "creatorRevenueShareBpsSnapshot"
        + "platformRevenueShareBpsSnapshot"
      ) = 10000
      AND "refundPolicySnapshot" IS NOT NULL
      AND "refundPolicySnapshot" = 'FULL_WHEN_UNUSED'
      AND "expiryPolicySnapshot" IS NOT NULL
      AND "expiryPolicySnapshot" = 'NEVER_EXPIRES'
      AND "entitlementValidityDaysSnapshot" IS NULL
    )
  ) NOT VALID;

CREATE FUNCTION "enforce_recharge_order_billing_snapshot"()
RETURNS TRIGGER AS $$
DECLARE
  "expected" RECORD;
BEGIN
  -- Legacy orders keep their all-NULL compatibility path. Once an order is
  -- product-bound, neither that binding nor any commercial input can be
  -- attached later or rewritten after provider contact.
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
      OR NEW."unitNameSnapshot" IS DISTINCT FROM OLD."unitNameSnapshot"
      OR NEW."entitlementUnitsSnapshot" IS DISTINCT FROM OLD."entitlementUnitsSnapshot"
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
      "product"."status" AS "productStatus",
      "price"."status" AS "priceStatus",
      "price"."currency" AS "currency",
      "price"."amountMinor" AS "amountMinor",
      "price"."unitName" AS "unitName",
      "price"."entitlementUnits" AS "entitlementUnits",
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
    -- Serialize checkout insertion against concurrent archive/retire updates.
    -- The side that obtains the row locks first defines the sale boundary.
    FOR SHARE OF "price", "product";

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'RechargeOrder billing product and price version do not match';
    END IF;

    IF
      NEW."representativeId" IS DISTINCT FROM "expected"."representativeId"
      OR NEW."productCode" IS DISTINCT FROM 'agent-wallet:service-credit:v1'
      OR "expected"."productStatus" <> 'ACTIVE'
      OR "expected"."priceStatus" <> 'ACTIVE'
      OR NEW."productNameSnapshot" IS DISTINCT FROM BTRIM("expected"."productName")
      OR NEW."unitNameSnapshot" IS DISTINCT FROM BTRIM("expected"."unitName")
      OR NEW."entitlementUnitsSnapshot" IS DISTINCT FROM "expected"."entitlementUnits"
      OR NEW."creatorRevenueShareBpsSnapshot" IS DISTINCT FROM "expected"."creatorRevenueShareBps"
      OR NEW."platformRevenueShareBpsSnapshot" IS DISTINCT FROM "expected"."platformRevenueShareBps"
      OR NEW."refundPolicySnapshot" IS DISTINCT FROM "expected"."refundPolicy"
      OR NEW."expiryPolicySnapshot" IS DISTINCT FROM "expected"."expiryPolicy"
      OR NEW."entitlementValidityDaysSnapshot" IS DISTINCT FROM "expected"."entitlementValidityDays"
      OR NEW."amountCents" IS DISTINCT FROM "expected"."amountMinor"
      OR NEW."currency" IS DISTINCT FROM "expected"."currency"
    THEN
      RAISE EXCEPTION
        'RechargeOrder commercial snapshot does not match its active price version';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RechargeOrder_billing_snapshot"
  BEFORE INSERT OR UPDATE ON "RechargeOrder"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_recharge_order_billing_snapshot"();

CREATE INDEX "RechargeOrder_billingProductId_status_createdAt_idx"
  ON "RechargeOrder"("billingProductId", "status", "createdAt");

CREATE INDEX "RechargeOrder_billingPriceVersionId_status_createdAt_idx"
  ON "RechargeOrder"("billingPriceVersionId", "status", "createdAt");

ALTER TABLE "RechargeOrder"
  ADD CONSTRAINT "RechargeOrder_billingProductId_fkey"
  FOREIGN KEY ("billingProductId")
  REFERENCES "BillingProduct"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT
  NOT VALID,
  ADD CONSTRAINT "RechargeOrder_billingPriceVersionId_fkey"
  FOREIGN KEY ("billingPriceVersionId")
  REFERENCES "BillingPriceVersion"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT
  NOT VALID;

ALTER TABLE "RechargeOrder"
  VALIDATE CONSTRAINT "RechargeOrder_billing_snapshot_complete";

ALTER TABLE "RechargeOrder"
  VALIDATE CONSTRAINT "RechargeOrder_billingProductId_fkey";

ALTER TABLE "RechargeOrder"
  VALIDATE CONSTRAINT "RechargeOrder_billingPriceVersionId_fkey";

-- Bootstrap the three public CNY package tiers from each existing AgentWallet.
-- Deterministic IDs avoid requiring a database extension for cuid/uuid
-- generation. A tier is skipped unless it yields an exact integer unit price.
-- SHARE prevents AgentWallet inserts or price/share updates from changing the
-- eligible set between the product and version INSERT statements.
LOCK TABLE "AgentWallet" IN SHARE MODE;

WITH "EligibleDefaultPackage" AS (
  SELECT
    "wallet"."representativeId",
    "wallet"."creatorRevenueShareBps",
    "package"."code",
    "package"."name",
    "package"."amountMinor",
    "package"."amountMinor" / "wallet"."tokenUnitPriceCents"
      AS "entitlementUnits"
  FROM "AgentWallet" AS "wallet"
  CROSS JOIN (
    VALUES
      ('service-pack-cny-500', '¥5 服务包', 500),
      ('service-pack-cny-2000', '¥20 服务包', 2000),
      ('service-pack-cny-10000', '¥100 服务包', 10000)
  ) AS "package"("code", "name", "amountMinor")
  WHERE
    "wallet"."currency" = 'CNY'
    AND "wallet"."tokenUnitPriceCents" > 0
    AND "wallet"."creatorRevenueShareBps" BETWEEN 0 AND 10000
    AND MOD(
      "package"."amountMinor",
      "wallet"."tokenUnitPriceCents"
    ) = 0
)
INSERT INTO "BillingProduct" (
  "id",
  "representativeId",
  "code",
  "name",
  "description",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  'billing_product_' || SUBSTR(
    MD5("representativeId" || ':' || "code"),
    1,
    24
  ),
  "representativeId",
  "code",
  "name",
  '一次性购买，当前对外代理专属；永久有效；仅在完全未使用时支持全额退款。',
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "EligibleDefaultPackage"
ON CONFLICT ("representativeId", "code") DO NOTHING;

WITH "EligibleDefaultPackage" AS (
  SELECT
    "wallet"."representativeId",
    "wallet"."creatorRevenueShareBps",
    "package"."code",
    "package"."amountMinor",
    "package"."amountMinor" / "wallet"."tokenUnitPriceCents"
      AS "entitlementUnits"
  FROM "AgentWallet" AS "wallet"
  CROSS JOIN (
    VALUES
      ('service-pack-cny-500', 500),
      ('service-pack-cny-2000', 2000),
      ('service-pack-cny-10000', 10000)
  ) AS "package"("code", "amountMinor")
  WHERE
    "wallet"."currency" = 'CNY'
    AND "wallet"."tokenUnitPriceCents" > 0
    AND "wallet"."creatorRevenueShareBps" BETWEEN 0 AND 10000
    AND MOD(
      "package"."amountMinor",
      "wallet"."tokenUnitPriceCents"
    ) = 0
)
INSERT INTO "BillingPriceVersion" (
  "id",
  "billingProductId",
  "version",
  "status",
  "currency",
  "amountMinor",
  "unitName",
  "entitlementUnits",
  "creatorRevenueShareBps",
  "platformRevenueShareBps",
  "refundPolicy",
  "expiryPolicy",
  "entitlementValidityDays",
  "publishedAt",
  "createdAt"
)
SELECT
  'billing_price_' || SUBSTR(
    MD5("representativeId" || ':' || "code" || ':1'),
    1,
    24
  ),
  'billing_product_' || SUBSTR(
    MD5("representativeId" || ':' || "code"),
    1,
    24
  ),
  1,
  'ACTIVE',
  'CNY',
  "amountMinor",
  'credit',
  "entitlementUnits",
  "creatorRevenueShareBps",
  10000 - "creatorRevenueShareBps",
  'FULL_WHEN_UNUSED',
  'NEVER_EXPIRES',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "EligibleDefaultPackage"
ON CONFLICT ("billingProductId", "version") DO NOTHING;

COMMIT;
