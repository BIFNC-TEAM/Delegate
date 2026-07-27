-- A provider notification id identifies one delivery event, while the
-- provider transaction id identifies the underlying money movement. Both are
-- required to make differently-id'd retries unable to credit two orders.
ALTER TABLE "PaymentProviderEvent"
  ADD COLUMN "providerTransactionId" TEXT,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

ALTER TABLE "RechargeOrder"
  ADD COLUMN "providerTransactionId" TEXT;

CREATE UNIQUE INDEX "PaymentProviderEvent_provider_providerTransactionId_key"
  ON "PaymentProviderEvent"("provider", "providerTransactionId");

CREATE UNIQUE INDEX "RechargeOrder_provider_providerTransactionId_key"
  ON "RechargeOrder"("provider", "providerTransactionId");
