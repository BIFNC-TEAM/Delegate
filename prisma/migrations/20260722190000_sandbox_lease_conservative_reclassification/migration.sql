-- The original backfill used a wall-clock cutoff and could miss leases created
-- between that cutoff and deployment. Reclassify every lease that exists at
-- upgrade time conservatively; newly provisioned leases persist their explicit
-- isolation mode after this migration completes.
UPDATE "SandboxLease"
SET "filesystemMode" = 'WORKSPACE_ONLY';
