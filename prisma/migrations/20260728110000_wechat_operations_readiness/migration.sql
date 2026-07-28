CREATE TYPE "WalletExceptionCaseStatus" AS ENUM (
  'OPEN',
  'CLAIMED',
  'ACKNOWLEDGED',
  'RESOLVED'
);

CREATE TYPE "WalletExceptionSeverity" AS ENUM (
  'WARNING',
  'ERROR',
  'CRITICAL'
);

CREATE TYPE "WalletExceptionSourceType" AS ENUM (
  'ORDER_RECONCILIATION_OUTBOX',
  'REFUND_LIFECYCLE_OUTBOX',
  'REFUND_REVERSAL_OUTBOX',
  'REFUND_RECONCILIATION',
  'REFUND_ABNORMAL'
);

CREATE TYPE "WalletExceptionActionType" AS ENUM (
  'CLAIM',
  'RETRY',
  'ACKNOWLEDGE'
);

CREATE TABLE "OperationalWorkerCheckpoint" (
  "workerKey" VARCHAR(96) NOT NULL,
  "lastStartedAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" VARCHAR(96),
  "lastSummary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OperationalWorkerCheckpoint_pkey" PRIMARY KEY ("workerKey"),
  CONSTRAINT "OperationalWorkerCheckpoint_failures_check"
    CHECK ("consecutiveFailures" >= 0)
);

CREATE INDEX "OperationalWorkerCheckpoint_lastHeartbeatAt_idx"
  ON "OperationalWorkerCheckpoint"("lastHeartbeatAt");

CREATE TABLE "WalletExceptionCase" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "currency" VARCHAR(12) NOT NULL DEFAULT 'CNY',
  "kind" VARCHAR(96) NOT NULL,
  "reasonCode" VARCHAR(128) NOT NULL,
  "sourceType" "WalletExceptionSourceType" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "outboxEventId" TEXT,
  "rechargeRefundId" TEXT,
  "status" "WalletExceptionCaseStatus" NOT NULL DEFAULT 'OPEN',
  "severity" "WalletExceptionSeverity" NOT NULL,
  "claimedByOwnerId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "acknowledgedByOwnerId" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalletExceptionCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletExceptionCase_version_check" CHECK ("version" >= 0),
  CONSTRAINT "WalletExceptionCase_claim_check" CHECK (
    ("status" <> 'CLAIMED')
    OR ("claimedByOwnerId" IS NOT NULL AND "claimedAt" IS NOT NULL)
  ),
  CONSTRAINT "WalletExceptionCase_acknowledgement_check" CHECK (
    ("status" <> 'ACKNOWLEDGED')
    OR (
      "acknowledgedByOwnerId" IS NOT NULL
      AND "acknowledgedAt" IS NOT NULL
      AND LENGTH(BTRIM(COALESCE("note", ''))) > 0
    )
  ),
  CONSTRAINT "WalletExceptionCase_resolution_check" CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
    OR ("status" <> 'RESOLVED' AND "resolvedAt" IS NULL)
  ),
  CONSTRAINT "WalletExceptionCase_source_binding_check" CHECK (
    (
      "sourceType" = 'ORDER_RECONCILIATION_OUTBOX'
      AND "outboxEventId" IS NOT NULL
      AND "sourceId" = "outboxEventId"
    )
    OR (
      "sourceType" IN (
        'REFUND_LIFECYCLE_OUTBOX',
        'REFUND_REVERSAL_OUTBOX'
      )
      AND "outboxEventId" IS NOT NULL
      AND "rechargeRefundId" IS NOT NULL
      AND "sourceId" = "outboxEventId"
    )
    OR (
      "sourceType" IN (
        'REFUND_RECONCILIATION',
        'REFUND_ABNORMAL'
      )
      AND "outboxEventId" IS NULL
      AND "rechargeRefundId" IS NOT NULL
      AND "sourceId" = "rechargeRefundId"
    )
  )
);

CREATE UNIQUE INDEX "WalletExceptionCase_outboxEventId_key"
  ON "WalletExceptionCase"("outboxEventId");
CREATE UNIQUE INDEX "WalletExceptionCase_sourceType_sourceId_key"
  ON "WalletExceptionCase"("sourceType", "sourceId");
CREATE INDEX "WalletExceptionCase_ownerId_representativeId_status_severity_lastDetectedAt_idx"
  ON "WalletExceptionCase"(
    "ownerId",
    "representativeId",
    "status",
    "severity",
    "lastDetectedAt"
  );
CREATE INDEX "WalletExceptionCase_rechargeRefundId_status_idx"
  ON "WalletExceptionCase"("rechargeRefundId", "status");

CREATE TABLE "WalletExceptionAction" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "actorOwnerId" TEXT NOT NULL,
  "action" "WalletExceptionActionType" NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalletExceptionAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletExceptionAction_versions_check" CHECK (
    "expectedVersion" >= 0
    AND "resultingVersion" = "expectedVersion" + 1
  ),
  CONSTRAINT "WalletExceptionAction_acknowledgement_note_check" CHECK (
    ("action" <> 'ACKNOWLEDGE')
    OR LENGTH(BTRIM(COALESCE("note", ''))) > 0
  )
);

CREATE UNIQUE INDEX "WalletExceptionAction_actorOwnerId_idempotencyKey_key"
  ON "WalletExceptionAction"("actorOwnerId", "idempotencyKey");
CREATE INDEX "WalletExceptionAction_caseId_createdAt_idx"
  ON "WalletExceptionAction"("caseId", "createdAt");

ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "Owner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_claimedByOwnerId_fkey"
  FOREIGN KEY ("claimedByOwnerId") REFERENCES "Owner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_acknowledgedByOwnerId_fkey"
  FOREIGN KEY ("acknowledgedByOwnerId") REFERENCES "Owner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionCase"
  ADD CONSTRAINT "WalletExceptionCase_rechargeRefundId_fkey"
  FOREIGN KEY ("rechargeRefundId") REFERENCES "RechargeRefund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionAction"
  ADD CONSTRAINT "WalletExceptionAction_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "WalletExceptionCase"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletExceptionAction"
  ADD CONSTRAINT "WalletExceptionAction_actorOwnerId_fkey"
  FOREIGN KEY ("actorOwnerId") REFERENCES "Owner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
