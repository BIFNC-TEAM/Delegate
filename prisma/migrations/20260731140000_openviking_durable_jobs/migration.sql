ALTER TABLE "Representative"
  ADD COLUMN "openvikingLastSyncJobId" TEXT;

ALTER TABLE "RepresentativeContextSync"
  ADD COLUMN "requestedVersionId" TEXT,
  ADD COLUMN "trigger" TEXT,
  ADD COLUMN "requestedByOwnerId" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Legacy rows are terminal except for a process that died while it was
-- synchronizing. Recover those running rows against the version that is
-- active at migration time.
UPDATE "RepresentativeContextSync" AS sync
SET
  "requestedVersionId" = representative."activeVersionId",
  "trigger" = 'legacy_recovery',
  "status" = CASE
    WHEN sync."status" = 'running' THEN 'queued'
    ELSE sync."status"
  END,
  "availableAt" = CURRENT_TIMESTAMP
FROM "Representative" AS representative
WHERE representative."id" = sync."representativeId";

WITH latest_recovery_job AS (
  SELECT DISTINCT ON ("representativeId")
    "representativeId",
    "id"
  FROM "RepresentativeContextSync"
  WHERE
    "status" = 'queued'
    AND "trigger" = 'legacy_recovery'
  ORDER BY "representativeId", "createdAt" DESC
)
UPDATE "Representative" AS representative
SET
  "openvikingLastSyncJobId" = recovery."id",
  "openvikingLastSyncStatus" = 'queued',
  "openvikingLastSyncError" = NULL
FROM latest_recovery_job AS recovery
WHERE representative."id" = recovery."representativeId";

CREATE INDEX "RepContextSync_rep_version_created_idx"
  ON "RepresentativeContextSync"("representativeId", "requestedVersionId", "createdAt");

CREATE INDEX "RepContextSync_status_due_lease_idx"
  ON "RepresentativeContextSync"("status", "availableAt", "leaseExpiresAt");

ALTER TABLE "RepresentativeContextSync"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "OpenVikingMemoryRecord"
  ADD COLUMN "deletionRequestedByOwnerId" TEXT,
  ADD COLUMN "nextDeleteAttemptAt" TIMESTAMP(3);

UPDATE "OpenVikingMemoryRecord"
SET "nextDeleteAttemptAt" = CURRENT_TIMESTAMP
WHERE "status" = 'DELETE_FAILED';

CREATE INDEX "OVMemory_status_next_attempt_lease_idx"
  ON "OpenVikingMemoryRecord"("status", "nextDeleteAttemptAt", "lastDeleteAttemptAt");
