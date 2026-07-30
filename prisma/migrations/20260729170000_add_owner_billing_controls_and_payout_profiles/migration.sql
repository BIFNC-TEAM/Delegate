-- Owner billing controls and tokenized Creator payout destinations.
--
-- This migration intentionally keeps historical WithdrawRequest rows valid:
-- all new payout snapshot columns may remain NULL together. New application
-- writes bind a complete, immutable destination snapshot before any funds are
-- frozen.
--
-- PostgreSQL does not wrap migration files automatically. Keep enum additions,
-- schema objects, constraints, and trigger installation atomic.
BEGIN;

ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'BILLING_PRODUCT_CREATED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'BILLING_PRODUCT_UPDATED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'BILLING_PRICE_VERSION_PUBLISHED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'BILLING_PRODUCT_ARCHIVED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'WALLET_PAYOUT_PROFILE_SUBMITTED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'WALLET_PAYOUT_DESTINATION_CHANGED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'WALLET_PAYOUT_DESTINATION_VERIFIED';

CREATE TYPE "PayoutSubjectType" AS ENUM (
  'OWNER',
  'ORGANIZATION'
);

CREATE TYPE "CreatorPayoutProfileStatus" AS ENUM (
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED'
);

CREATE TYPE "PayoutDestinationKind" AS ENUM (
  'WECHAT_PAY'
);

CREATE TYPE "PayoutDestinationStatus" AS ENUM (
  'PENDING_VERIFICATION',
  'VERIFIED',
  'ACTIVE',
  'REJECTED',
  'DISABLED',
  'REPLACED'
);

-- BillingProduct is the optimistic-concurrency root for product metadata and
-- lifecycle mutations. Commercial price fields remain on immutable versions.
ALTER TABLE "BillingProduct"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "BillingProduct_revision_nonnegative"
    CHECK ("revision" >= 0) NOT VALID;

ALTER TABLE "BillingProduct"
  VALIDATE CONSTRAINT "BillingProduct_revision_nonnegative";

-- Replace the stability function installed by the preceding billing migration.
-- Metadata/status changes advance revision exactly once; unchanged writes may
-- not manufacture a new revision.
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

  "businessChanged" :=
    NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."description" IS DISTINCT FROM OLD."description"
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

-- An ACTIVE price cannot belong to a DRAFT or ARCHIVED product. The check is
-- deferred so publication and archival may update product and version rows in
-- either order inside one transaction. An ACTIVE product may temporarily have
-- no active version; public checkout already requires both rows to be active.
CREATE FUNCTION "enforce_billing_publication_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  "targetProductId" TEXT;
  "productStatus" "BillingProductStatus";
BEGIN
  IF TG_TABLE_NAME = 'BillingProduct' THEN
    "targetProductId" := NEW."id";
  ELSE
    "targetProductId" := NEW."billingProductId";
  END IF;

  SELECT "status"
  INTO "productStatus"
  FROM "BillingProduct"
  WHERE "id" = "targetProductId";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF
    "productStatus" <> 'ACTIVE'
    AND EXISTS (
      SELECT 1
      FROM "BillingPriceVersion"
      WHERE
        "billingProductId" = "targetProductId"
        AND "status" = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION
      'An active BillingPriceVersion requires an active BillingProduct';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $billing_publication_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "BillingPriceVersion" AS "price"
    INNER JOIN "BillingProduct" AS "product"
      ON "product"."id" = "price"."billingProductId"
    WHERE
      "price"."status" = 'ACTIVE'
      AND "product"."status" <> 'ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'billing publication preflight failed: active price belongs to an inactive product';
  END IF;
END
$billing_publication_preflight$;

CREATE CONSTRAINT TRIGGER "BillingProduct_publication_integrity"
  AFTER INSERT OR UPDATE ON "BillingProduct"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_billing_publication_integrity"();

CREATE CONSTRAINT TRIGGER "BillingPriceVersion_publication_integrity"
  AFTER INSERT OR UPDATE ON "BillingPriceVersion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_billing_publication_integrity"();

CREATE TABLE "CreatorPayoutProfile" (
  "id" TEXT NOT NULL,
  "subjectType" "PayoutSubjectType" NOT NULL,
  "ownerId" TEXT,
  "organizationId" TEXT,
  "status" "CreatorPayoutProfileStatus" NOT NULL
    DEFAULT 'PENDING_VERIFICATION',
  "version" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "rejectionReasonCode" TEXT,
  "suspendedAt" TIMESTAMP(3),
  "createdByOwnerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CreatorPayoutProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorPayoutProfile_subject_scope_valid" CHECK (
    (
      "subjectType" = 'OWNER'
      AND "ownerId" IS NOT NULL
      AND "organizationId" IS NULL
    )
    OR (
      "subjectType" = 'ORGANIZATION'
      AND "ownerId" IS NULL
      AND "organizationId" IS NOT NULL
    )
  ),
  CONSTRAINT "CreatorPayoutProfile_version_nonnegative" CHECK (
    "version" >= 0
  ),
  CONSTRAINT "CreatorPayoutProfile_rejection_code_nonempty" CHECK (
    "rejectionReasonCode" IS NULL
    OR LENGTH(BTRIM("rejectionReasonCode")) > 0
  ),
  CONSTRAINT "CreatorPayoutProfile_lifecycle_valid" CHECK (
    (
      "status" = 'PENDING_VERIFICATION'
      AND "verifiedAt" IS NULL
      AND "verifiedBy" IS NULL
      AND "rejectionReasonCode" IS NULL
      AND "suspendedAt" IS NULL
    )
    OR (
      "status" = 'VERIFIED'
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "rejectionReasonCode" IS NULL
      AND "suspendedAt" IS NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "verifiedAt" IS NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "rejectionReasonCode" IS NOT NULL
      AND "suspendedAt" IS NULL
    )
    OR (
      "status" = 'SUSPENDED'
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "rejectionReasonCode" IS NULL
      AND "suspendedAt" IS NOT NULL
      AND "suspendedAt" >= "verifiedAt"
    )
  )
);

CREATE UNIQUE INDEX "CreatorPayoutProfile_ownerId_key"
  ON "CreatorPayoutProfile"("ownerId");

CREATE UNIQUE INDEX "CreatorPayoutProfile_organizationId_key"
  ON "CreatorPayoutProfile"("organizationId");

CREATE INDEX "CreatorPayoutProfile_subjectType_status_updatedAt_idx"
  ON "CreatorPayoutProfile"("subjectType", "status", "updatedAt");

CREATE INDEX "CreatorPayoutProfile_createdByOwnerId_createdAt_idx"
  ON "CreatorPayoutProfile"("createdByOwnerId", "createdAt");

ALTER TABLE "CreatorPayoutProfile"
  ADD CONSTRAINT "CreatorPayoutProfile_ownerId_fkey"
  FOREIGN KEY ("ownerId")
  REFERENCES "Owner"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT,
  ADD CONSTRAINT "CreatorPayoutProfile_organizationId_fkey"
  FOREIGN KEY ("organizationId")
  REFERENCES "Organization"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT,
  ADD CONSTRAINT "CreatorPayoutProfile_createdByOwnerId_fkey"
  FOREIGN KEY ("createdByOwnerId")
  REFERENCES "Owner"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_creator_payout_profile_stability"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'CreatorPayoutProfile rows are stable identities and cannot be deleted';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."subjectType" IS DISTINCT FROM OLD."subjectType"
    OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."createdByOwnerId" IS DISTINCT FROM OLD."createdByOwnerId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'CreatorPayoutProfile subject and creation identity are immutable';
  END IF;

  IF
    (OLD."status" = 'PENDING_VERIFICATION'
      AND NEW."status" NOT IN (
        'PENDING_VERIFICATION',
        'VERIFIED',
        'REJECTED'
      ))
    OR (OLD."status" = 'VERIFIED'
      AND NEW."status" NOT IN (
        'VERIFIED',
        'PENDING_VERIFICATION',
        'SUSPENDED'
      ))
    OR (OLD."status" = 'REJECTED'
      AND NEW."status" NOT IN ('REJECTED', 'PENDING_VERIFICATION'))
    OR (OLD."status" = 'SUSPENDED'
      AND NEW."status" NOT IN ('SUSPENDED', 'PENDING_VERIFICATION'))
  THEN
    RAISE EXCEPTION
      'CreatorPayoutProfile status transitions must move forward';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION
        'CreatorPayoutProfile version must advance exactly once per status transition';
    END IF;
  ELSE
    IF
      NEW."version" NOT IN (OLD."version", OLD."version" + 1)
      OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
      OR NEW."verifiedBy" IS DISTINCT FROM OLD."verifiedBy"
      OR NEW."rejectionReasonCode" IS DISTINCT FROM OLD."rejectionReasonCode"
      OR NEW."suspendedAt" IS DISTINCT FROM OLD."suspendedAt"
    THEN
      RAISE EXCEPTION
        'CreatorPayoutProfile verification facts are immutable without a status transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CreatorPayoutProfile_stability"
  BEFORE UPDATE OR DELETE ON "CreatorPayoutProfile"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_creator_payout_profile_stability"();

CREATE TABLE "PayoutDestination" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "kind" "PayoutDestinationKind" NOT NULL DEFAULT 'WECHAT_PAY',
  "status" "PayoutDestinationStatus" NOT NULL
    DEFAULT 'PENDING_VERIFICATION',
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "maskedLabel" TEXT NOT NULL,
  "credentialCiphertext" BYTEA,
  "credentialIv" BYTEA,
  "credentialAuthTag" BYTEA,
  "credentialKeyVersion" TEXT NOT NULL,
  "credentialAlgorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
  "credentialFingerprint" TEXT NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "coolingOffUntil" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "activatedAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "replacedAt" TIMESTAMP(3),
  "createdByOwnerId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayoutDestination_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayoutDestination_v1_currency" CHECK (
    "currency" = 'CNY'
  ),
  CONSTRAINT "PayoutDestination_masked_label_nonempty" CHECK (
    LENGTH(BTRIM("maskedLabel")) > 0
  ),
  CONSTRAINT "PayoutDestination_credential_version_positive" CHECK (
    "credentialVersion" > 0
  ),
  CONSTRAINT "PayoutDestination_credential_metadata_valid" CHECK (
    LENGTH(BTRIM("credentialKeyVersion")) BETWEEN 1 AND 64
    AND "credentialAlgorithm" = 'aes-256-gcm'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PayoutDestination_credential_envelope_complete" CHECK (
    (
      "credentialCiphertext" IS NULL
      AND "credentialIv" IS NULL
      AND "credentialAuthTag" IS NULL
    )
    OR (
      "credentialCiphertext" IS NOT NULL
      AND OCTET_LENGTH("credentialCiphertext") > 0
      AND "credentialIv" IS NOT NULL
      AND OCTET_LENGTH("credentialIv") = 12
      AND "credentialAuthTag" IS NOT NULL
      AND OCTET_LENGTH("credentialAuthTag") = 16
    )
  ),
  CONSTRAINT "PayoutDestination_lifecycle_valid" CHECK (
    (
      "status" = 'PENDING_VERIFICATION'
      AND "credentialCiphertext" IS NOT NULL
      AND "verifiedAt" IS NULL
      AND "verifiedBy" IS NULL
      AND "activatedAt" IS NULL
      AND "disabledAt" IS NULL
      AND "replacedAt" IS NULL
    )
    OR (
      "status" = 'VERIFIED'
      AND "credentialCiphertext" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "activatedAt" IS NULL
      AND "disabledAt" IS NULL
      AND "replacedAt" IS NULL
    )
    OR (
      "status" = 'ACTIVE'
      AND "credentialCiphertext" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "activatedAt" IS NOT NULL
      AND (
        "coolingOffUntil" IS NULL
        OR "activatedAt" >= "coolingOffUntil"
      )
      AND "disabledAt" IS NULL
      AND "replacedAt" IS NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "credentialCiphertext" IS NOT NULL
      AND "verifiedAt" IS NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "activatedAt" IS NULL
      AND "disabledAt" IS NULL
      AND "replacedAt" IS NULL
    )
    OR (
      "status" = 'DISABLED'
      AND "credentialCiphertext" IS NULL
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "activatedAt" IS NOT NULL
      AND "disabledAt" IS NOT NULL
      AND "disabledAt" >= "activatedAt"
      AND "replacedAt" IS NULL
    )
    OR (
      "status" = 'REPLACED'
      AND "credentialCiphertext" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
      AND "verifiedBy" IS NOT NULL
      AND LENGTH(BTRIM("verifiedBy")) > 0
      AND "activatedAt" IS NOT NULL
      AND "disabledAt" IS NULL
      AND "replacedAt" IS NOT NULL
      AND "replacedAt" >= "activatedAt"
    )
  )
);

CREATE UNIQUE INDEX "PayoutDestination_profileId_credentialVersion_key"
  ON "PayoutDestination"("profileId", "credentialVersion");

CREATE UNIQUE INDEX "PayoutDestination_idempotencyKey_key"
  ON "PayoutDestination"("idempotencyKey");

CREATE UNIQUE INDEX "PayoutDestination_one_active_per_profile_currency_key"
  ON "PayoutDestination"("profileId", "currency")
  WHERE "status" = 'ACTIVE';

CREATE INDEX "PayoutDestination_profileId_status_currency_updatedAt_idx"
  ON "PayoutDestination"("profileId", "status", "currency", "updatedAt");

CREATE INDEX "PayoutDestination_credentialFingerprint_idx"
  ON "PayoutDestination"("credentialFingerprint");

ALTER TABLE "PayoutDestination"
  ADD CONSTRAINT "PayoutDestination_profileId_fkey"
  FOREIGN KEY ("profileId")
  REFERENCES "CreatorPayoutProfile"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT,
  ADD CONSTRAINT "PayoutDestination_createdByOwnerId_fkey"
  FOREIGN KEY ("createdByOwnerId")
  REFERENCES "Owner"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_payout_destination_stability"()
RETURNS TRIGGER AS $$
DECLARE
  "credentialEnvelopeChanged" BOOLEAN;
  "credentialRedacted" BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'PayoutDestination rows are stable credential versions and cannot be deleted';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."profileId" IS DISTINCT FROM OLD."profileId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."maskedLabel" IS DISTINCT FROM OLD."maskedLabel"
    OR NEW."credentialKeyVersion" IS DISTINCT FROM OLD."credentialKeyVersion"
    OR NEW."credentialAlgorithm" IS DISTINCT FROM OLD."credentialAlgorithm"
    OR NEW."credentialFingerprint" IS DISTINCT FROM OLD."credentialFingerprint"
    OR NEW."credentialVersion" IS DISTINCT FROM OLD."credentialVersion"
    OR NEW."coolingOffUntil" IS DISTINCT FROM OLD."coolingOffUntil"
    OR NEW."createdByOwnerId" IS DISTINCT FROM OLD."createdByOwnerId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'PayoutDestination identity, credential metadata, and cooling-off facts are immutable';
  END IF;

  IF
    (OLD."status" = 'PENDING_VERIFICATION'
      AND NEW."status" NOT IN (
        'PENDING_VERIFICATION',
        'VERIFIED',
        'REJECTED'
      ))
    OR (OLD."status" = 'VERIFIED'
      AND NEW."status" NOT IN ('VERIFIED', 'ACTIVE'))
    OR (OLD."status" = 'ACTIVE'
      AND NEW."status" NOT IN ('ACTIVE', 'DISABLED', 'REPLACED'))
    OR (OLD."status" = 'REJECTED' AND NEW."status" <> 'REJECTED')
    OR (OLD."status" = 'DISABLED' AND NEW."status" <> 'DISABLED')
    OR (OLD."status" = 'REPLACED' AND NEW."status" <> 'REPLACED')
  THEN
    RAISE EXCEPTION
      'PayoutDestination status transitions must move forward';
  END IF;

  "credentialEnvelopeChanged" :=
    NEW."credentialCiphertext" IS DISTINCT FROM OLD."credentialCiphertext"
    OR NEW."credentialIv" IS DISTINCT FROM OLD."credentialIv"
    OR NEW."credentialAuthTag" IS DISTINCT FROM OLD."credentialAuthTag";

  "credentialRedacted" :=
    NEW."status" = 'DISABLED'
    AND OLD."credentialCiphertext" IS NOT NULL
    AND OLD."credentialIv" IS NOT NULL
    AND OLD."credentialAuthTag" IS NOT NULL
    AND NEW."credentialCiphertext" IS NULL
    AND NEW."credentialIv" IS NULL
    AND NEW."credentialAuthTag" IS NULL;

  IF "credentialEnvelopeChanged" AND NOT "credentialRedacted" THEN
    RAISE EXCEPTION
      'PayoutDestination encrypted credentials are immutable except for terminal redaction';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF
      NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
      OR NEW."verifiedBy" IS DISTINCT FROM OLD."verifiedBy"
      OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
      OR NEW."disabledAt" IS DISTINCT FROM OLD."disabledAt"
      OR NEW."replacedAt" IS DISTINCT FROM OLD."replacedAt"
    THEN
      RAISE EXCEPTION
        'PayoutDestination lifecycle facts are immutable without a status transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayoutDestination_stability"
  BEFORE UPDATE OR DELETE ON "PayoutDestination"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_payout_destination_stability"();

-- A destination may become ACTIVE only while its profile is verified. Later
-- profile re-verification or suspension intentionally leaves the last active
-- destination in place while application reads fail closed on profile status.
-- The deferred check lets profile verification and activation happen in either
-- order inside one transaction.
CREATE FUNCTION "enforce_payout_profile_destination_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  "profileStatus" "CreatorPayoutProfileStatus";
BEGIN
  SELECT "status"
  INTO "profileStatus"
  FROM "CreatorPayoutProfile"
  WHERE "id" = NEW."profileId";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF
    NEW."status" = 'ACTIVE'
    AND "profileStatus" <> 'VERIFIED'
  THEN
    RAISE EXCEPTION
      'An active PayoutDestination requires a verified CreatorPayoutProfile';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PayoutDestination_profile_integrity"
  AFTER INSERT OR UPDATE ON "PayoutDestination"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_payout_profile_destination_integrity"();

ALTER TABLE "WithdrawRequest"
  ADD COLUMN "payoutProfileId" TEXT,
  ADD COLUMN "payoutDestinationId" TEXT,
  ADD COLUMN "payoutSubjectTypeSnapshot" "PayoutSubjectType",
  ADD COLUMN "payoutSubjectIdSnapshot" TEXT,
  ADD COLUMN "destinationMaskedLabelSnapshot" TEXT,
  ADD COLUMN "destinationVersionSnapshot" INTEGER;

ALTER TABLE "WithdrawRequest"
  ADD CONSTRAINT "WithdrawRequest_payout_snapshot_complete" CHECK (
    (
      "payoutProfileId" IS NULL
      AND "payoutDestinationId" IS NULL
      AND "payoutSubjectTypeSnapshot" IS NULL
      AND "payoutSubjectIdSnapshot" IS NULL
      AND "destinationMaskedLabelSnapshot" IS NULL
      AND "destinationVersionSnapshot" IS NULL
    )
    OR (
      "payoutProfileId" IS NOT NULL
      AND "payoutDestinationId" IS NOT NULL
      AND "payoutSubjectTypeSnapshot" IS NOT NULL
      AND "payoutSubjectIdSnapshot" IS NOT NULL
      AND LENGTH(BTRIM("payoutSubjectIdSnapshot")) > 0
      AND "destinationMaskedLabelSnapshot" IS NOT NULL
      AND LENGTH(BTRIM("destinationMaskedLabelSnapshot")) > 0
      AND "destinationVersionSnapshot" IS NOT NULL
      AND "destinationVersionSnapshot" > 0
    )
  ) NOT VALID;

ALTER TABLE "WithdrawRequest"
  ADD CONSTRAINT "WithdrawRequest_payoutProfileId_fkey"
  FOREIGN KEY ("payoutProfileId")
  REFERENCES "CreatorPayoutProfile"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT
  NOT VALID,
  ADD CONSTRAINT "WithdrawRequest_payoutDestinationId_fkey"
  FOREIGN KEY ("payoutDestinationId")
  REFERENCES "PayoutDestination"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT
  NOT VALID;

CREATE INDEX "WithdrawRequest_payoutDestinationId_status_requestedAt_idx"
  ON "WithdrawRequest"("payoutDestinationId", "status", "requestedAt");

CREATE FUNCTION "enforce_withdraw_request_payout_snapshot"()
RETURNS TRIGGER AS $$
DECLARE
  "expected" RECORD;
BEGIN
  -- Existing rows may keep the all-NULL compatibility shape, but every row
  -- created after this migration must bind a complete destination snapshot.
  IF TG_OP = 'INSERT' AND NEW."payoutProfileId" IS NULL THEN
    RAISE EXCEPTION
      'New WithdrawRequest rows require an active verified payout destination snapshot';
  END IF;

  IF
    TG_OP = 'UPDATE'
    AND (
      OLD."payoutProfileId" IS NOT NULL
      OR NEW."payoutProfileId" IS NOT NULL
    )
    AND (
      NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."payoutProfileId" IS DISTINCT FROM OLD."payoutProfileId"
      OR NEW."payoutDestinationId" IS DISTINCT FROM OLD."payoutDestinationId"
      OR NEW."payoutSubjectTypeSnapshot" IS DISTINCT FROM OLD."payoutSubjectTypeSnapshot"
      OR NEW."payoutSubjectIdSnapshot" IS DISTINCT FROM OLD."payoutSubjectIdSnapshot"
      OR NEW."destinationMaskedLabelSnapshot" IS DISTINCT FROM OLD."destinationMaskedLabelSnapshot"
      OR NEW."destinationVersionSnapshot" IS DISTINCT FROM OLD."destinationVersionSnapshot"
    )
  THEN
    RAISE EXCEPTION
      'Payout-bound WithdrawRequest commercial and destination snapshot fields are immutable';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."payoutProfileId" IS NOT NULL THEN
    SELECT
      "profile"."subjectType" AS "subjectType",
      "profile"."ownerId" AS "profileOwnerId",
      "profile"."organizationId" AS "profileOrganizationId",
      "profile"."status" AS "profileStatus",
      "destination"."profileId" AS "destinationProfileId",
      "destination"."status" AS "destinationStatus",
      "destination"."currency" AS "destinationCurrency",
      "destination"."maskedLabel" AS "maskedLabel",
      "destination"."credentialVersion" AS "credentialVersion",
      "subjectOwner"."organizationId" AS "requestOwnerOrganizationId"
    INTO "expected"
    FROM "PayoutDestination" AS "destination"
    INNER JOIN "CreatorPayoutProfile" AS "profile"
      ON "profile"."id" = "destination"."profileId"
    INNER JOIN "Owner" AS "subjectOwner"
      ON "subjectOwner"."id" = NEW."ownerId"
    WHERE
      "destination"."id" = NEW."payoutDestinationId"
      AND "profile"."id" = NEW."payoutProfileId"
    -- Serialize request insertion against concurrent profile suspension and
    -- destination disable/replacement. The first row-lock holder defines the
    -- binding boundary.
    FOR SHARE OF "destination", "profile", "subjectOwner";

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'WithdrawRequest payout profile and destination do not match';
    END IF;

    IF
      "expected"."profileStatus" <> 'VERIFIED'
      OR "expected"."destinationStatus" <> 'ACTIVE'
      OR NEW."currency" IS DISTINCT FROM "expected"."destinationCurrency"
      OR NEW."payoutSubjectTypeSnapshot" IS DISTINCT FROM "expected"."subjectType"
      OR NEW."destinationMaskedLabelSnapshot" IS DISTINCT FROM BTRIM("expected"."maskedLabel")
      OR NEW."destinationVersionSnapshot" IS DISTINCT FROM "expected"."credentialVersion"
      OR (
        "expected"."subjectType" = 'OWNER'
        AND (
          "expected"."profileOwnerId" IS DISTINCT FROM NEW."ownerId"
          OR NEW."payoutSubjectIdSnapshot" IS DISTINCT FROM "expected"."profileOwnerId"
        )
      )
      OR (
        "expected"."subjectType" = 'ORGANIZATION'
        AND (
          "expected"."profileOrganizationId"
            IS DISTINCT FROM "expected"."requestOwnerOrganizationId"
          OR NEW."payoutSubjectIdSnapshot"
            IS DISTINCT FROM "expected"."profileOrganizationId"
        )
      )
    THEN
      RAISE EXCEPTION
        'WithdrawRequest payout snapshot does not match an active verified destination';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WithdrawRequest_payout_snapshot"
  BEFORE INSERT OR UPDATE ON "WithdrawRequest"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_withdraw_request_payout_snapshot"();

ALTER TABLE "WithdrawRequest"
  VALIDATE CONSTRAINT "WithdrawRequest_payout_snapshot_complete";

ALTER TABLE "WithdrawRequest"
  VALIDATE CONSTRAINT "WithdrawRequest_payoutProfileId_fkey";

ALTER TABLE "WithdrawRequest"
  VALIDATE CONSTRAINT "WithdrawRequest_payoutDestinationId_fkey";

COMMIT;
