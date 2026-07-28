-- Persist the merchant refund intent before the first provider call. Provider
-- identifiers and payer amounts are facts learned only from a signed WeChat
-- response or callback, so they must remain nullable while the outcome is
-- unknown.
ALTER TYPE "PaymentProviderEventType" ADD VALUE 'REFUND_PROCESSING';

CREATE TYPE "RechargeRefundSubmissionStatus" AS ENUM (
  'EXTERNAL',
  'QUEUED',
  'ACCEPTED',
  'UNKNOWN',
  'REJECTED'
);

ALTER TABLE "RechargeRefund"
  DROP CONSTRAINT "RechargeRefund_amounts_valid",
  DROP CONSTRAINT "RechargeRefund_provider_success_time_valid",
  DROP CONSTRAINT "RechargeRefund_reversal_state_valid",
  ALTER COLUMN "providerRefundId" DROP NOT NULL,
  ALTER COLUMN "payerOriginalAmountCents" DROP NOT NULL,
  ALTER COLUMN "payerRefundAmountCents" DROP NOT NULL,
  ALTER COLUMN "providerStatus" DROP DEFAULT,
  ALTER COLUMN "providerStatus" DROP NOT NULL,
  ADD COLUMN "requestedByOwnerId" TEXT,
  ADD COLUMN "submissionStatus" "RechargeRefundSubmissionStatus"
    NOT NULL DEFAULT 'EXTERNAL',
  ADD COLUMN "requestIdempotencyKey" TEXT,
  ADD COLUMN "requestReason" TEXT,
  ADD COLUMN "refundNotifyUrl" TEXT,
  ADD COLUMN "providerCreatedAt" TIMESTAMP(3),
  ADD COLUMN "lastProviderQueryAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RechargeRefund_requestIdempotencyKey_key"
  ON "RechargeRefund"("requestIdempotencyKey");

CREATE INDEX "RechargeRefund_requestedByOwnerId_createdAt_idx"
  ON "RechargeRefund"("requestedByOwnerId", "createdAt");

CREATE INDEX "RechargeRefund_submissionStatus_updatedAt_idx"
  ON "RechargeRefund"("submissionStatus", "updatedAt");

ALTER TABLE "RechargeRefund"
  ADD CONSTRAINT "RechargeRefund_requestedByOwnerId_fkey"
  FOREIGN KEY ("requestedByOwnerId")
  REFERENCES "Owner"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE,
  ADD CONSTRAINT "RechargeRefund_amounts_valid" CHECK (
    "originalAmountCents" > 0
    AND "refundAmountCents" > 0
    AND "refundAmountCents" <= "originalAmountCents"
    AND (
      (
        "payerOriginalAmountCents" IS NULL
        AND "payerRefundAmountCents" IS NULL
      )
      OR (
        "payerOriginalAmountCents" IS NOT NULL
        AND "payerRefundAmountCents" IS NOT NULL
        AND "payerOriginalAmountCents" >= 0
        AND "payerOriginalAmountCents" <= "originalAmountCents"
        AND "payerRefundAmountCents" >= 0
        AND "payerRefundAmountCents" <= "refundAmountCents"
        AND "payerRefundAmountCents" <= "payerOriginalAmountCents"
      )
    )
  ),
  ADD CONSTRAINT "RechargeRefund_provider_identity_valid" CHECK (
    (
      "providerStatus" IS NULL
      AND "providerRefundId" IS NULL
      AND "payerOriginalAmountCents" IS NULL
      AND "payerRefundAmountCents" IS NULL
    )
    OR (
      "providerStatus" IS NOT NULL
      AND "providerRefundId" IS NOT NULL
      AND "payerOriginalAmountCents" IS NOT NULL
      AND "payerRefundAmountCents" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "RechargeRefund_submission_state_valid" CHECK (
    (
      "submissionStatus" = 'EXTERNAL'
      AND "providerStatus" IS NOT NULL
    )
    OR (
      "submissionStatus" IN ('QUEUED', 'UNKNOWN')
      AND "requestIdempotencyKey" IS NOT NULL
      AND "requestedByOwnerId" IS NOT NULL
      AND "refundNotifyUrl" IS NOT NULL
      AND "providerStatus" IS NULL
      AND "reversalStatus" IN (
        'PENDING',
        'RECONCILIATION_REQUIRED'
      )
    )
    OR (
      "submissionStatus" = 'ACCEPTED'
      AND "requestIdempotencyKey" IS NOT NULL
      AND "requestedByOwnerId" IS NOT NULL
      AND "refundNotifyUrl" IS NOT NULL
      AND "providerStatus" IS NOT NULL
    )
    OR (
      "submissionStatus" = 'REJECTED'
      AND "requestIdempotencyKey" IS NOT NULL
      AND "requestedByOwnerId" IS NOT NULL
      AND "providerStatus" IS NULL
      AND "reversalStatus" = 'NOT_REQUIRED'
      AND "processingError" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "RechargeRefund_provider_success_time_valid" CHECK (
    "providerStatus" <> 'SUCCEEDED'
    OR "providerSucceededAt" IS NOT NULL
  ),
  ADD CONSTRAINT "RechargeRefund_reversal_state_valid" CHECK (
    (
      "reversalStatus" = 'PENDING'
      AND "reversalAppliedAt" IS NULL
    )
    OR (
      "reversalStatus" = 'APPLIED'
      AND "reversalAppliedAt" IS NOT NULL
      AND "processingError" IS NULL
    )
    OR (
      "reversalStatus" = 'NOT_REQUIRED'
      AND "reversalAppliedAt" IS NULL
      AND (
        "processingError" IS NULL
        OR "submissionStatus" = 'REJECTED'
      )
    )
    OR (
      "reversalStatus" = 'RECONCILIATION_REQUIRED'
      AND "reversalAppliedAt" IS NULL
      AND "processingError" IS NOT NULL
    )
  );
