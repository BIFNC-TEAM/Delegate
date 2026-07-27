-- Keep the provider's refund outcome separate from the local wallet reversal.
-- A verified refund can already be final at WeChat while Delegate still needs
-- to freeze service credits and route an unsafe reversal to reconciliation.
ALTER TYPE "PaymentProviderEventType" ADD VALUE 'REFUND_CLOSED';
ALTER TYPE "PaymentProviderEventType" ADD VALUE 'REFUND_ABNORMAL';

CREATE TYPE "RechargeRefundProviderStatus" AS ENUM (
  'PROCESSING',
  'SUCCEEDED',
  'CLOSED',
  'ABNORMAL'
);

CREATE TYPE "RechargeRefundReversalStatus" AS ENUM (
  'PENDING',
  'APPLIED',
  'NOT_REQUIRED',
  'RECONCILIATION_REQUIRED'
);

CREATE TABLE "RechargeRefund" (
  "id" TEXT NOT NULL,
  "rechargeOrderId" TEXT NOT NULL,
  "tokenPurchaseId" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "providerRefundOrderId" TEXT NOT NULL,
  "providerRefundId" TEXT NOT NULL,
  "paymentTransactionId" TEXT NOT NULL,
  "originalAmountCents" INTEGER NOT NULL,
  "refundAmountCents" INTEGER NOT NULL,
  "payerOriginalAmountCents" INTEGER NOT NULL,
  "payerRefundAmountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "providerStatus" "RechargeRefundProviderStatus" NOT NULL DEFAULT 'PROCESSING',
  "reversalStatus" "RechargeRefundReversalStatus" NOT NULL DEFAULT 'PENDING',
  "providerSucceededAt" TIMESTAMP(3),
  "reversalAppliedAt" TIMESTAMP(3),
  "processingError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RechargeRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RechargeRefund_amounts_valid" CHECK (
    "originalAmountCents" > 0
    AND "refundAmountCents" > 0
    AND "refundAmountCents" <= "originalAmountCents"
    AND "payerOriginalAmountCents" >= 0
    AND "payerOriginalAmountCents" <= "originalAmountCents"
    AND "payerRefundAmountCents" >= 0
    AND "payerRefundAmountCents" <= "refundAmountCents"
    AND "payerRefundAmountCents" <= "payerOriginalAmountCents"
  ),
  CONSTRAINT "RechargeRefund_provider_success_time_valid" CHECK (
    "providerStatus" <> 'SUCCEEDED'
    OR "providerSucceededAt" IS NOT NULL
  ),
  CONSTRAINT "RechargeRefund_reversal_state_valid" CHECK (
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
      AND "processingError" IS NULL
    )
    OR (
      "reversalStatus" = 'RECONCILIATION_REQUIRED'
      AND "reversalAppliedAt" IS NULL
      AND "processingError" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "RechargeRefund_provider_providerRefundOrderId_key"
  ON "RechargeRefund"("provider", "providerRefundOrderId");

CREATE UNIQUE INDEX "RechargeRefund_provider_providerRefundId_key"
  ON "RechargeRefund"("provider", "providerRefundId");

CREATE INDEX "RechargeRefund_rechargeOrderId_providerStatus_createdAt_idx"
  ON "RechargeRefund"("rechargeOrderId", "providerStatus", "createdAt");

CREATE INDEX "RechargeRefund_providerStatus_updatedAt_idx"
  ON "RechargeRefund"("providerStatus", "updatedAt");

CREATE INDEX "RechargeRefund_tokenPurchaseId_reversalStatus_createdAt_idx"
  ON "RechargeRefund"("tokenPurchaseId", "reversalStatus", "createdAt");

CREATE INDEX "RechargeRefund_reversalStatus_updatedAt_idx"
  ON "RechargeRefund"("reversalStatus", "updatedAt");

ALTER TABLE "RechargeRefund"
  ADD CONSTRAINT "RechargeRefund_rechargeOrderId_fkey"
  FOREIGN KEY ("rechargeOrderId")
  REFERENCES "RechargeOrder"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "RechargeRefund"
  ADD CONSTRAINT "RechargeRefund_tokenPurchaseId_fkey"
  FOREIGN KEY ("tokenPurchaseId")
  REFERENCES "AgentTokenPurchase"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "PaymentProviderEvent"
  ADD COLUMN "rechargeRefundId" TEXT;

CREATE INDEX "PaymentProviderEvent_rechargeRefundId_receivedAt_idx"
  ON "PaymentProviderEvent"("rechargeRefundId", "receivedAt");

ALTER TABLE "PaymentProviderEvent"
  ADD CONSTRAINT "PaymentProviderEvent_rechargeRefundId_fkey"
  FOREIGN KEY ("rechargeRefundId")
  REFERENCES "RechargeRefund"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- PostgreSQL is the shared lease authority for payment-provider operations.
-- scopeKey is a SHA-256 digest; no audience identity or IP address is stored.
CREATE TABLE "PaymentProviderOperationGate" (
  "scopeKey" VARCHAR(64) NOT NULL,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAllowedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentProviderOperationGate_pkey" PRIMARY KEY ("scopeKey")
);

CREATE INDEX "PaymentProviderOperationGate_leaseExpiresAt_idx"
  ON "PaymentProviderOperationGate"("leaseExpiresAt");

CREATE INDEX "PaymentProviderOperationGate_nextAllowedAt_idx"
  ON "PaymentProviderOperationGate"("nextAllowedAt");
