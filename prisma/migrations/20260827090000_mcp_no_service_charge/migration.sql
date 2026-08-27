-- MCP execution remains governed by capability policy and approval, but it no
-- longer requires or consumes a Pass/service-credit entitlement. Keep all
-- non-MCP capability gates unchanged.
UPDATE "CapabilityPolicyRule"
SET
  "requiredPlanTier" = NULL,
  "requiresPaidPlan" = false
WHERE "capability" = 'MCP';
