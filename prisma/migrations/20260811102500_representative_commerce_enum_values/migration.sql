-- PostgreSQL requires newly-added enum values to be committed before a later
-- transaction may reference them in constraints or data. Keep this migration
-- separate from the commerce schema migration for that commit boundary.
ALTER TYPE "EventType"
  ADD VALUE IF NOT EXISTS 'REPRESENTATIVE_COMMERCE_UPDATED';

ALTER TYPE "BillingRefundPolicy"
  ADD VALUE IF NOT EXISTS 'NON_REFUNDABLE';
