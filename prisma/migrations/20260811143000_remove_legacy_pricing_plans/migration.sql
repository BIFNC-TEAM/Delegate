-- The Owner Billing Catalog is the only active source of prices and
-- entitlements. Historical Invoice rows keep their immutable PricingPlanType
-- snapshot, but the mutable four-tier representative catalog is retired.
DROP TABLE IF EXISTS "PricingPlan";
