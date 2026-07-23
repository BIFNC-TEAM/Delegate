ALTER TABLE "WorkspaceSkillRelease"
ADD COLUMN "registryTrustSource" TEXT,
ADD COLUMN "registryVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "registryTrustEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "registryTrustEvidence" JSONB,
ADD COLUMN "runtimeRequirements" JSONB;
