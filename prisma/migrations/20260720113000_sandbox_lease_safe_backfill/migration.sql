-- Existing leases predate persisted isolation attributes. Classify them
-- conservatively so they cannot be reused by the public ephemeral lane.
UPDATE "SandboxLease"
SET "filesystemMode" = 'WORKSPACE_ONLY'
WHERE "createdAt" < TIMESTAMP '2026-07-20 10:00:00';

ALTER TABLE "SandboxLease"
ALTER COLUMN "filesystemMode" SET DEFAULT 'WORKSPACE_ONLY';
