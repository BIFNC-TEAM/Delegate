CREATE TYPE "DelegationKnowledgeScope" AS ENUM ('USER_INPUT_ONLY', 'PUBLIC_KNOWLEDGE');

ALTER TABLE "Representative"
ADD COLUMN "delegationEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "delegationNaturalLanguageEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "delegationExplicitComputeEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "delegationMaxSteps" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "delegationMaxCostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "delegationKnowledgeScope" "DelegationKnowledgeScope" NOT NULL DEFAULT 'USER_INPUT_ONLY';
