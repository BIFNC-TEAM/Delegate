BEGIN;

CREATE TYPE "BillableUnitStatus" AS ENUM (
  'PENDING_RESERVATION',
  'RESERVED',
  'TRANSFERRED',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'RELEASED',
  'HELD_FOR_RECONCILIATION'
);

CREATE TABLE "BillableUnit" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "actionId" TEXT,
  "goalId" TEXT,
  "deliverableId" TEXT,
  "productId" TEXT NOT NULL,
  "pricingVersionId" TEXT NOT NULL,
  "priceSnapshotHash" CHAR(64) NOT NULL,
  "representativeId" TEXT NOT NULL,
  "payerAccountId" TEXT NOT NULL,
  "entitlementAccountId" TEXT NOT NULL,
  "unitKind" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "scope" TEXT NOT NULL,
  "referenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "completionRule" TEXT NOT NULL,
  "settlementTrigger" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "billingPolicySnapshotHash" CHAR(64) NOT NULL,
  "authorizedPurposeHash" CHAR(64) NOT NULL,
  "status" "BillableUnitStatus" NOT NULL DEFAULT 'PENDING_RESERVATION',
  "reservationOwnerType" TEXT,
  "reservationOwnerId" TEXT,
  "reservationReference" TEXT,
  "reservedAt" TIMESTAMP(3),
  "transferredAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "reconciliationHeldAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillableUnit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillableUnit_idempotencyKey_key"
  ON "BillableUnit"("idempotencyKey");
CREATE INDEX "BillableUnit_plan_status_created_idx"
  ON "BillableUnit"("planId", "status", "createdAt");
CREATE INDEX "BillableUnit_action_status_idx"
  ON "BillableUnit"("actionId", "status");
CREATE INDEX "BillableUnit_accounts_status_idx"
  ON "BillableUnit"("payerAccountId", "entitlementAccountId", "status");
CREATE INDEX "BillableUnit_owner_status_idx"
  ON "BillableUnit"("reservationOwnerType", "reservationOwnerId", "status");

ALTER TABLE "BillableUnit" ADD CONSTRAINT "BillableUnit_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ConversationTurnPlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillableUnit" ADD CONSTRAINT "BillableUnit_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "ConversationPlanAction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillableUnit" ADD CONSTRAINT "BillableUnit_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
