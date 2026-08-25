-- A delivery attempt must distinguish a claimed/pre-call lease from a remote
-- call whose outcome may be unknown. Plan-bound deliveries also freeze the
-- exact plan revision/epoch that authorized the provider side effect.
ALTER TYPE "MessageDeliveryAttemptStatus"
  ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

CREATE TYPE "MessageDeliveryAttemptPhase" AS ENUM (
  'CREATED',
  'CLAIMED',
  'CALL_PREPARED',
  'CALL_STARTED',
  'RESPONSE_RECEIVED',
  'PROVIDER_ACCEPTED',
  'COMPLETED',
  'FAILED_CONFIRMED',
  'OUTCOME_UNKNOWN',
  'LEASE_EXPIRED',
  'CANCELED_BEFORE_START',
  'RECONCILIATION_REQUIRED'
);

ALTER TABLE "MessageDeliveryAttempt"
  ADD COLUMN "planId" TEXT,
  ADD COLUMN "planRevision" INTEGER,
  ADD COLUMN "executionEpoch" INTEGER,
  ADD COLUMN "deliveryOutboxId" TEXT,
  ADD COLUMN "deliveryLeaseAttempt" INTEGER,
  ADD COLUMN "attemptPhase" "MessageDeliveryAttemptPhase" NOT NULL DEFAULT 'CREATED',
  ADD COLUMN "providerCallStartedAt" TIMESTAMP(3),
  ADD COLUMN "responseReceivedAt" TIMESTAMP(3);

-- Existing PROCESSING rows predate the call boundary and therefore cannot be
-- proven pre-call. Fail them closed as uncertain instead of treating the
-- default CREATED phase as permission to resend.
UPDATE "MessageDeliveryAttempt"
SET "attemptPhase" = CASE
  WHEN "status" = 'QUEUED' THEN 'CLAIMED'::"MessageDeliveryAttemptPhase"
  WHEN "status" = 'PROCESSING' THEN 'RECONCILIATION_REQUIRED'::"MessageDeliveryAttemptPhase"
  WHEN "status" = 'PROVIDER_ACCEPTED' THEN 'PROVIDER_ACCEPTED'::"MessageDeliveryAttemptPhase"
  WHEN "status" = 'CONFIRMED' THEN 'COMPLETED'::"MessageDeliveryAttemptPhase"
  WHEN "status" IN ('FAILED', 'DEAD_LETTER') THEN 'FAILED_CONFIRMED'::"MessageDeliveryAttemptPhase"
  WHEN "status" = 'CANCELED' THEN 'CANCELED_BEFORE_START'::"MessageDeliveryAttemptPhase"
  ELSE "attemptPhase"
END;

ALTER TABLE "MessageDeliveryAttempt"
  ADD CONSTRAINT "MessageDeliveryAttempt_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ConversationTurnPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MessageDeliveryAttempt_planId_planRevision_executionEpoch_status_idx"
  ON "MessageDeliveryAttempt"("planId", "planRevision", "executionEpoch", "status");

CREATE INDEX "MessageDeliveryAttempt_deliveryOutboxId_deliveryLeaseAttempt_idx"
  ON "MessageDeliveryAttempt"("deliveryOutboxId", "deliveryLeaseAttempt");

CREATE INDEX "MessageDeliveryAttempt_attemptPhase_leaseExpiresAt_idx"
  ON "MessageDeliveryAttempt"("attemptPhase", "leaseExpiresAt");
