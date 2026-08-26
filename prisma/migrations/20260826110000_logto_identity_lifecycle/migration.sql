ALTER TYPE "AuthIdentityStatus"
  ADD VALUE IF NOT EXISTS 'SUSPENDED' BEFORE 'REVOKED';

CREATE TABLE "LogtoWebhookReceipt" (
  "id" TEXT NOT NULL,
  "issuer" VARCHAR(2048) NOT NULL,
  "hookId" VARCHAR(255) NOT NULL,
  "event" VARCHAR(96) NOT NULL,
  "providerSubject" VARCHAR(255),
  "payloadHash" CHAR(64) NOT NULL,
  "providerCreatedAt" TIMESTAMP(3) NOT NULL,
  "effect" VARCHAR(64) NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LogtoWebhookReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LogtoWebhookReceipt_payloadHash_key"
  ON "LogtoWebhookReceipt"("payloadHash");

CREATE INDEX "LogtoWebhookReceipt_issuer_providerSubject_processedAt_idx"
  ON "LogtoWebhookReceipt"("issuer", "providerSubject", "processedAt");

CREATE INDEX "LogtoWebhookReceipt_event_processedAt_idx"
  ON "LogtoWebhookReceipt"("event", "processedAt");
