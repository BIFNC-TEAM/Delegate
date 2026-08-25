ALTER TABLE "Representative"
  RENAME COLUMN "computeAutoApproveBudgetCents" TO "computeAutoApproveTokenLimit";

UPDATE "Representative"
SET "computeAutoApproveTokenLimit" = LEAST(
  "computeAutoApproveTokenLimit"::bigint * 100,
  2147483647
)::integer;

ALTER TABLE "Representative"
  RENAME COLUMN "delegationMaxCostCents" TO "delegationMaxEstimatedTokens";

UPDATE "Representative"
SET "delegationMaxEstimatedTokens" = LEAST(
  "delegationMaxEstimatedTokens"::bigint * 100,
  2147483647
)::integer;

ALTER TABLE "RepresentativeMcpBinding"
  RENAME COLUMN "estimatedCostCentsPerCall" TO "estimatedTokensPerCall";

UPDATE "RepresentativeMcpBinding"
SET "estimatedTokensPerCall" = LEAST(
  "estimatedTokensPerCall"::bigint * 100,
  2147483647
)::integer;

ALTER TABLE "CapabilityPolicyRule"
  RENAME COLUMN "maxCostCents" TO "maxEstimatedTokens";

UPDATE "CapabilityPolicyRule"
SET "maxEstimatedTokens" = LEAST(
  "maxEstimatedTokens"::bigint * 100,
  2147483647
)::integer
WHERE "maxEstimatedTokens" IS NOT NULL;

ALTER TABLE "DelegationTaskResourcePolicy"
  RENAME COLUMN "maxCostCents" TO "maxEstimatedTokens";

UPDATE "DelegationTaskResourcePolicy"
SET "maxEstimatedTokens" = LEAST(
  "maxEstimatedTokens"::bigint * 100,
  2147483647
)::integer
WHERE "maxEstimatedTokens" IS NOT NULL;

ALTER TABLE "DelegationTaskStep"
  RENAME COLUMN "maxCostCents" TO "maxEstimatedTokens";

UPDATE "DelegationTaskStep"
SET "maxEstimatedTokens" = LEAST(
  "maxEstimatedTokens"::bigint * 100,
  2147483647
)::integer
WHERE "maxEstimatedTokens" IS NOT NULL;
