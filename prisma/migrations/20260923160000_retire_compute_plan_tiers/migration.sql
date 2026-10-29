-- Compute admission uses the server-verified consumption reservation attached
-- to the current generation. Membership tiers are no longer an authorization
-- input. Keep compatibility columns/history, but clear active legacy gates.
UPDATE "CapabilityPolicyRule"
SET "requiredPlanTier" = NULL,
    "requiresPaidPlan" = FALSE,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "requiredPlanTier" IS NOT NULL OR "requiresPaidPlan" = TRUE;
