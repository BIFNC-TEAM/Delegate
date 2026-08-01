BEGIN;

ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'OPENVIKING_CONFIG_CHANGED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'OPENVIKING_MEMORY_STATUS_CHANGED';
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'OPENVIKING_RESOURCE_SYNC_COMPLETED';

CREATE TYPE "OpenVikingMemoryStatus" AS ENUM (
  'ACTIVE',
  'SUPPRESSED',
  'DELETE_PENDING',
  'DELETED',
  'DELETE_FAILED'
);

ALTER TABLE "Representative"
  ALTER COLUMN "openvikingAutoCapture" SET DEFAULT false;

UPDATE "Representative"
SET "openvikingAutoCapture" = false
WHERE "openvikingAutoCapture" = true;

ALTER TABLE "OpenVikingMemoryRecord"
  ADD COLUMN "status" "OpenVikingMemoryStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suppressedAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "lastDeleteAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deletionAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletionError" TEXT;

-- Representative-wide learned patterns and payment state are no longer valid
-- recall sources. Mark historical rows non-recallable before the new service
-- is deployed; their remote copies can then be removed through retry.
UPDATE "OpenVikingMemoryRecord"
SET
  "status" = 'DELETE_PENDING',
  "suppressedAt" = CURRENT_TIMESTAMP,
  "summary" = ''
WHERE
  "scope" = 'agent'
  OR "category" = 'payment'
  OR "sourceKind" IN ('payment_unlock', 'handoff_resolution');

CREATE INDEX "OpenVikingMemoryRecord_representativeId_contactId_status_updatedAt_idx"
  ON "OpenVikingMemoryRecord"("representativeId", "contactId", "status", "updatedAt");

CREATE INDEX "OpenVikingMemoryRecord_status_updatedAt_idx"
  ON "OpenVikingMemoryRecord"("status", "updatedAt");

COMMIT;
