-- Forward-only remediation for
-- 20260723231000_channel_identity_safe_backfill.
--
-- Matrix server names are case-sensitive. The earlier immutable migration
-- lowercased legacy server names, so their original identity cannot be
-- reconstructed from the database. Revoke only the links marked as touched by
-- that migration and require an explicit one-time rebind instead of silently
-- assigning a potentially different Matrix principal.
UPDATE "IdentityLink"
SET
  "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP),
  "proofMetadata" = COALESCE("proofMetadata", '{}'::jsonb) ||
    jsonb_build_object(
      'matrixCaseRemediation', 'rebind_required',
      'remediationMigration',
        '20260723231500_channel_identity_safe_forward_remediation'
    ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'MATRIX'::"IdentityLinkProvider"
  AND "proofMetadata"->>'migration'
    = '20260723231000_channel_identity_safe_backfill'
  AND (
    "revokedAt" IS NULL
    OR "proofMetadata"->>'matrixCaseRemediation'
      IS DISTINCT FROM 'rebind_required'
    OR "proofMetadata"->>'remediationMigration'
      IS DISTINCT FROM
        '20260723231500_channel_identity_safe_forward_remediation'
  );

-- A usage charge's authorization coordinates are an all-or-nothing unit. The
-- earlier migration could copy purchase ownership into a legacy charge with
-- missing wallet/entitlement/conversation/run coordinates. Clear only that
-- partial audience scope so later ownership invariants cannot treat it as an
-- authorized charge.
UPDATE "AgentUsageCharge"
SET
  "audienceIdentityId" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "audienceIdentityId" IS NOT NULL
  AND (
    "userAgentWalletId" IS NULL
    OR "entitlementAccountId" IS NULL
    OR "conversationId" IS NULL
    OR "generationRunId" IS NULL
  );
