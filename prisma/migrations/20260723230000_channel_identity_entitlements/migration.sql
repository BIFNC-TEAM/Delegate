-- Expand-only channel, identity, and entitlement foundation.
-- Legacy channel and wallet fields remain available during the migration window.

ALTER TYPE "IdentityLinkProvider" ADD VALUE IF NOT EXISTS 'MATRIX';

CREATE TYPE "IdentityAssuranceLevel" AS ENUM (
  'UNVERIFIED',
  'PLATFORM_VERIFIED',
  'STEP_UP_VERIFIED'
);

CREATE TYPE "ChannelTransport" AS ENUM ('WEB', 'MATRIX', 'TELEGRAM');
CREATE TYPE "ChannelSourceProvider" AS ENUM ('WEB', 'MATRIX', 'TELEGRAM');
CREATE TYPE "ChannelDesiredState" AS ENUM ('ACTIVE', 'PAUSED', 'DISCONNECTED');
CREATE TYPE "ChannelHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "ChannelInteractionMode" AS ENUM (
  'PRIVATE_CHAT',
  'GROUP_MENTION',
  'GROUP_REPLY',
  'CHANNEL_ENTRY'
);
CREATE TYPE "ServiceEntitlementStatus" AS ENUM (
  'ACTIVE',
  'FROZEN',
  'EXHAUSTED',
  'EXPIRED'
);
CREATE TYPE "ServiceEntitlementLedgerKind" AS ENUM (
  'GRANT',
  'RESERVE',
  'CONSUME',
  'RELEASE',
  'REFUND',
  'EXPIRE',
  'ADJUST'
);

ALTER TABLE "IdentityLink"
  ADD COLUMN "issuer" TEXT NOT NULL DEFAULT 'delegate',
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "assuranceLevel" "IdentityAssuranceLevel" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "proofMetadata" JSONB;

CREATE INDEX "IdentityLink_provider_issuer_providerSubject_idx"
  ON "IdentityLink"("provider", "issuer", "providerSubject");
CREATE INDEX "IdentityLink_revokedAt_idx" ON "IdentityLink"("revokedAt");

ALTER TABLE "RepresentativeChannelBinding"
  ADD COLUMN "transport" "ChannelTransport",
  ADD COLUMN "sourceProvider" "ChannelSourceProvider",
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "desiredState" "ChannelDesiredState" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "healthStatus" "ChannelHealthStatus" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "RepresentativeChannelBinding"
SET
  "transport" = "kind"::text::"ChannelTransport",
  "sourceProvider" = "kind"::text::"ChannelSourceProvider",
  "desiredState" = CASE
    WHEN upper("status") = 'PAUSED' THEN 'PAUSED'::"ChannelDesiredState"
    WHEN upper("status") = 'DISCONNECTED' THEN 'DISCONNECTED'::"ChannelDesiredState"
    ELSE 'ACTIVE'::"ChannelDesiredState"
  END,
  "healthStatus" = CASE
    WHEN upper("status") IN ('CONNECTED', 'ACTIVE', 'HEALTHY') THEN 'HEALTHY'::"ChannelHealthStatus"
    WHEN upper("status") IN ('DEGRADED', 'RETRYING') THEN 'DEGRADED'::"ChannelHealthStatus"
    WHEN upper("status") IN ('ERROR', 'FAILED', 'UNHEALTHY') THEN 'UNHEALTHY'::"ChannelHealthStatus"
    ELSE 'UNKNOWN'::"ChannelHealthStatus"
  END;

CREATE INDEX "RepresentativeChannelBinding_desiredState_healthStatus_updatedAt_idx"
  ON "RepresentativeChannelBinding"("desiredState", "healthStatus", "updatedAt");
CREATE INDEX "RepresentativeChannelBinding_sourceProvider_transport_updatedAt_idx"
  ON "RepresentativeChannelBinding"("sourceProvider", "transport", "updatedAt");

ALTER TABLE "Contact" ALTER COLUMN "telegramUserId" DROP NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "telegramChatId" DROP NOT NULL;

ALTER TABLE "ConversationChannelBinding"
  ADD COLUMN "transport" "ChannelTransport",
  ADD COLUMN "sourceProvider" "ChannelSourceProvider",
  ADD COLUMN "interactionMode" "ChannelInteractionMode" NOT NULL DEFAULT 'PRIVATE_CHAT',
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "bindingKey" TEXT;

UPDATE "ConversationChannelBinding"
SET
  "transport" = "kind"::text::"ChannelTransport",
  "sourceProvider" = "kind"::text::"ChannelSourceProvider";

DROP INDEX IF EXISTS "ConversationChannelBinding_kind_externalConversationId_exte_key";

WITH ranked_bindings AS (
  SELECT
    binding."id",
    conversation."representativeId",
    binding."kind"::text || ':' ||
      conversation."representativeId" || ':' ||
      binding."externalConversationId" || ':' ||
      COALESCE(binding."externalThreadId", '') AS proposed_key,
    count(*) OVER (
      PARTITION BY
        conversation."representativeId",
        binding."kind",
        binding."externalConversationId",
        COALESCE(binding."externalThreadId", '')
    ) AS binding_count,
    row_number() OVER (
      PARTITION BY
        conversation."representativeId",
        binding."kind",
        binding."externalConversationId",
        COALESCE(binding."externalThreadId", '')
      ORDER BY binding."createdAt", binding."id"
    ) AS binding_rank
  FROM "ConversationChannelBinding" AS binding
  INNER JOIN "Conversation" AS conversation
    ON conversation."id" = binding."conversationId"
),
key_ranked_bindings AS (
  SELECT
    ranked.*,
    count(*) OVER (
      PARTITION BY ranked.proposed_key
    ) AS serialized_key_count
  FROM ranked_bindings AS ranked
)
UPDATE "ConversationChannelBinding" AS binding
SET "bindingKey" = ranked_bindings.proposed_key
FROM key_ranked_bindings AS ranked_bindings
WHERE ranked_bindings."id" = binding."id"
  -- A duplicate group is an ownership ambiguity, not an ordering problem.
  -- Leave every member without a key so the preflight report can quarantine
  -- the whole group instead of silently selecting one conversation.
  AND ranked_bindings.binding_count = 1
  AND ranked_bindings.binding_rank = 1
  -- The serialized compatibility key also has to be unambiguous. Provider
  -- identifiers may contain the ':' delimiter, so two different logical
  -- coordinates can otherwise collapse onto one key.
  AND ranked_bindings.serialized_key_count = 1;

CREATE UNIQUE INDEX "ConversationChannelBinding_bindingKey_key"
  ON "ConversationChannelBinding"("bindingKey");
CREATE INDEX "ConversationChannelBinding_sourceProvider_transport_externalConversationId_idx"
  ON "ConversationChannelBinding"("sourceProvider", "transport", "externalConversationId");

ALTER TABLE "ChannelEventInbox"
  ADD COLUMN "transport" "ChannelTransport",
  ADD COLUMN "sourceProvider" "ChannelSourceProvider",
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "originKey" TEXT,
  ADD COLUMN "isBackfill" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ChannelEventInbox"
SET
  "transport" = "kind"::text::"ChannelTransport",
  "sourceProvider" = "kind"::text::"ChannelSourceProvider",
  "originKey" = "kind"::text || ':' || "externalEventId";

CREATE UNIQUE INDEX "ChannelEventInbox_originKey_key"
  ON "ChannelEventInbox"("originKey");
CREATE INDEX "ChannelEventInbox_sourceProvider_transport_createdAt_idx"
  ON "ChannelEventInbox"("sourceProvider", "transport", "createdAt");

ALTER TABLE "OutboxEvent"
  ADD COLUMN "transport" "ChannelTransport",
  ADD COLUMN "sourceProvider" "ChannelSourceProvider",
  ADD COLUMN "connectionId" TEXT;

ALTER TABLE "AgentTokenPurchase"
  ADD COLUMN "audienceIdentityId" TEXT,
  ADD COLUMN "entitlementAccountId" TEXT;

ALTER TABLE "AgentUsageCharge"
  ADD COLUMN "audienceIdentityId" TEXT,
  ADD COLUMN "entitlementAccountId" TEXT,
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "generationRunId" TEXT;

CREATE TABLE "IdentityBindingChallenge" (
  "id" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "provider" "IdentityLinkProvider" NOT NULL,
  "issuer" TEXT NOT NULL DEFAULT 'delegate',
  "expectedProviderSubject" TEXT,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityBindingChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdentityBindingChallenge_tokenHash_key"
  ON "IdentityBindingChallenge"("tokenHash");
CREATE INDEX "IdentityBindingChallenge_audienceIdentityId_provider_createdAt_idx"
  ON "IdentityBindingChallenge"("audienceIdentityId", "provider", "createdAt");
CREATE INDEX "IdentityBindingChallenge_expiresAt_consumedAt_revokedAt_idx"
  ON "IdentityBindingChallenge"("expiresAt", "consumedAt", "revokedAt");

CREATE TABLE "BridgeIdentityMapping" (
  "id" TEXT NOT NULL,
  "audienceIdentityId" TEXT,
  "transport" "ChannelTransport" NOT NULL,
  "sourceProvider" "ChannelSourceProvider" NOT NULL,
  "connectionId" TEXT NOT NULL,
  "transportSubject" TEXT NOT NULL,
  "sourceSubject" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BridgeIdentityMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BridgeIdentityMapping_connectionId_transport_transportSubject_key"
  ON "BridgeIdentityMapping"("connectionId", "transport", "transportSubject");
CREATE UNIQUE INDEX "BridgeIdentityMapping_connectionId_sourceProvider_sourceSubject_key"
  ON "BridgeIdentityMapping"("connectionId", "sourceProvider", "sourceSubject");
CREATE INDEX "BridgeIdentityMapping_audienceIdentityId_sourceProvider_idx"
  ON "BridgeIdentityMapping"("audienceIdentityId", "sourceProvider");
CREATE INDEX "BridgeIdentityMapping_revokedAt_idx"
  ON "BridgeIdentityMapping"("revokedAt");

CREATE TABLE "ServiceEntitlementAccount" (
  "id" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "productCode" TEXT NOT NULL,
  "unitName" TEXT NOT NULL DEFAULT 'credit',
  "status" "ServiceEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "grantedUnits" INTEGER NOT NULL DEFAULT 0,
  "remainingUnits" INTEGER NOT NULL DEFAULT 0,
  "reservedUnits" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceEntitlementAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceEntitlementAccount_nonnegative_units_check"
    CHECK ("grantedUnits" >= 0 AND "remainingUnits" >= 0 AND "reservedUnits" >= 0),
  CONSTRAINT "ServiceEntitlementAccount_allocated_units_check"
    CHECK ("remainingUnits" + "reservedUnits" <= "grantedUnits")
);

CREATE UNIQUE INDEX "ServiceEntitlementAccount_audienceIdentityId_representativeId_productCode_key"
  ON "ServiceEntitlementAccount"("audienceIdentityId", "representativeId", "productCode");
CREATE INDEX "ServiceEntitlementAccount_representativeId_status_updatedAt_idx"
  ON "ServiceEntitlementAccount"("representativeId", "status", "updatedAt");
CREATE INDEX "ServiceEntitlementAccount_audienceIdentityId_status_updatedAt_idx"
  ON "ServiceEntitlementAccount"("audienceIdentityId", "status", "updatedAt");

CREATE TABLE "ServicePaymentOrder" (
  "id" TEXT NOT NULL,
  "payerAudienceIdentityId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "providerOrderId" TEXT,
  "providerOrderKey" TEXT,
  "productCode" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "entitlementUnits" INTEGER NOT NULL,
  "status" "RechargeOrderStatus" NOT NULL DEFAULT 'CREATED',
  "priceSnapshot" JSONB NOT NULL,
  "checkoutUrl" TEXT,
  "providerPayload" JSONB,
  "fulfillmentKey" TEXT,
  "paidAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServicePaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServicePaymentOrder_providerOrderKey_key"
  ON "ServicePaymentOrder"("providerOrderKey");
CREATE UNIQUE INDEX "ServicePaymentOrder_fulfillmentKey_key"
  ON "ServicePaymentOrder"("fulfillmentKey");
CREATE INDEX "ServicePaymentOrder_payerAudienceIdentityId_status_createdAt_idx"
  ON "ServicePaymentOrder"("payerAudienceIdentityId", "status", "createdAt");
CREATE INDEX "ServicePaymentOrder_representativeId_status_createdAt_idx"
  ON "ServicePaymentOrder"("representativeId", "status", "createdAt");
CREATE INDEX "ServicePaymentOrder_provider_providerAccountId_status_createdAt_idx"
  ON "ServicePaymentOrder"("provider", "providerAccountId", "status", "createdAt");

CREATE TABLE "ServicePaymentEvent" (
  "id" TEXT NOT NULL,
  "paymentOrderId" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" "PaymentProviderEventType" NOT NULL DEFAULT 'UNKNOWN',
  "verifiedAt" TIMESTAMP(3),
  "rawPayload" JSONB NOT NULL,
  "normalizedPayload" JSONB,
  "processingError" TEXT,
  "processedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServicePaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServicePaymentEvent_provider_providerAccountId_providerEventId_key"
  ON "ServicePaymentEvent"("provider", "providerAccountId", "providerEventId");
CREATE INDEX "ServicePaymentEvent_paymentOrderId_receivedAt_idx"
  ON "ServicePaymentEvent"("paymentOrderId", "receivedAt");
CREATE INDEX "ServicePaymentEvent_provider_eventType_receivedAt_idx"
  ON "ServicePaymentEvent"("provider", "eventType", "receivedAt");

CREATE TABLE "ServiceEntitlementLedgerEntry" (
  "id" TEXT NOT NULL,
  "entitlementAccountId" TEXT NOT NULL,
  "paymentOrderId" TEXT,
  "generationRunId" TEXT,
  "kind" "ServiceEntitlementLedgerKind" NOT NULL,
  "units" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "reservedAfter" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL,
  "notes" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceEntitlementLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceEntitlementLedgerEntry_positive_units_check"
    CHECK ("units" > 0),
  CONSTRAINT "ServiceEntitlementLedgerEntry_nonnegative_balances_check"
    CHECK ("balanceAfter" >= 0 AND "reservedAfter" >= 0)
);

CREATE UNIQUE INDEX "ServiceEntitlementLedgerEntry_idempotencyKey_key"
  ON "ServiceEntitlementLedgerEntry"("idempotencyKey");
CREATE INDEX "ServiceEntitlementLedgerEntry_entitlementAccountId_createdAt_idx"
  ON "ServiceEntitlementLedgerEntry"("entitlementAccountId", "createdAt");
CREATE INDEX "ServiceEntitlementLedgerEntry_paymentOrderId_createdAt_idx"
  ON "ServiceEntitlementLedgerEntry"("paymentOrderId", "createdAt");
CREATE INDEX "ServiceEntitlementLedgerEntry_generationRunId_createdAt_idx"
  ON "ServiceEntitlementLedgerEntry"("generationRunId", "createdAt");

CREATE INDEX "AgentTokenPurchase_audienceIdentityId_representativeId_createdAt_idx"
  ON "AgentTokenPurchase"("audienceIdentityId", "representativeId", "createdAt");
CREATE INDEX "AgentTokenPurchase_entitlementAccountId_createdAt_idx"
  ON "AgentTokenPurchase"("entitlementAccountId", "createdAt");
CREATE INDEX "AgentUsageCharge_audienceIdentityId_representativeId_createdAt_idx"
  ON "AgentUsageCharge"("audienceIdentityId", "representativeId", "createdAt");
CREATE INDEX "AgentUsageCharge_entitlementAccountId_status_createdAt_idx"
  ON "AgentUsageCharge"("entitlementAccountId", "status", "createdAt");
CREATE INDEX "AgentUsageCharge_conversationId_createdAt_idx"
  ON "AgentUsageCharge"("conversationId", "createdAt");
CREATE INDEX "AgentUsageCharge_generationRunId_idx"
  ON "AgentUsageCharge"("generationRunId");

DO $$
DECLARE
  duplicate_charge_ids TEXT;
BEGIN
  SELECT string_agg(duplicate."telegramPaymentChargeId", ', ' ORDER BY duplicate."telegramPaymentChargeId")
  INTO duplicate_charge_ids
  FROM (
    SELECT "telegramPaymentChargeId"
    FROM "Invoice"
    WHERE "telegramPaymentChargeId" IS NOT NULL
    GROUP BY "telegramPaymentChargeId"
    HAVING count(*) > 1
    LIMIT 20
  ) AS duplicate;

  IF duplicate_charge_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot add Invoice.telegramPaymentChargeId uniqueness: duplicate Telegram charge ids exist.',
      DETAIL = duplicate_charge_ids,
      HINT = 'Run prisma/preflight/channel-identity-entitlements-deploy-blockers.sql and reconcile provider evidence before deployment.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "Invoice_telegramPaymentChargeId_key"
  ON "Invoice"("telegramPaymentChargeId");

ALTER TABLE "IdentityBindingChallenge"
  ADD CONSTRAINT "IdentityBindingChallenge_audienceIdentityId_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BridgeIdentityMapping"
  ADD CONSTRAINT "BridgeIdentityMapping_audienceIdentityId_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServiceEntitlementAccount"
  ADD CONSTRAINT "ServiceEntitlementAccount_audienceIdentityId_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceEntitlementAccount"
  ADD CONSTRAINT "ServiceEntitlementAccount_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServicePaymentOrder"
  ADD CONSTRAINT "ServicePaymentOrder_payerAudienceIdentityId_fkey"
  FOREIGN KEY ("payerAudienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServicePaymentOrder"
  ADD CONSTRAINT "ServicePaymentOrder_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServicePaymentEvent"
  ADD CONSTRAINT "ServicePaymentEvent_paymentOrderId_fkey"
  FOREIGN KEY ("paymentOrderId") REFERENCES "ServicePaymentOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServiceEntitlementLedgerEntry"
  ADD CONSTRAINT "ServiceEntitlementLedgerEntry_entitlementAccountId_fkey"
  FOREIGN KEY ("entitlementAccountId") REFERENCES "ServiceEntitlementAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceEntitlementLedgerEntry"
  ADD CONSTRAINT "ServiceEntitlementLedgerEntry_paymentOrderId_fkey"
  FOREIGN KEY ("paymentOrderId") REFERENCES "ServicePaymentOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceEntitlementLedgerEntry"
  ADD CONSTRAINT "ServiceEntitlementLedgerEntry_generationRunId_fkey"
  FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTokenPurchase"
  ADD CONSTRAINT "AgentTokenPurchase_audienceIdentityId_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentTokenPurchase"
  ADD CONSTRAINT "AgentTokenPurchase_entitlementAccountId_fkey"
  FOREIGN KEY ("entitlementAccountId") REFERENCES "ServiceEntitlementAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentUsageCharge"
  ADD CONSTRAINT "AgentUsageCharge_audienceIdentityId_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentUsageCharge"
  ADD CONSTRAINT "AgentUsageCharge_entitlementAccountId_fkey"
  FOREIGN KEY ("entitlementAccountId") REFERENCES "ServiceEntitlementAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentUsageCharge"
  ADD CONSTRAINT "AgentUsageCharge_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentUsageCharge"
  ADD CONSTRAINT "AgentUsageCharge_generationRunId_fkey"
  FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
