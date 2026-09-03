ALTER TABLE "SandboxLease"
ADD COLUMN "networkAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "networkPolicyHash" VARCHAR(64) NOT NULL DEFAULT 'legacy';
