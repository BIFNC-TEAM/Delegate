-- Bind every private-channel capability to one concrete adapter connection.
-- Existing unconsumed capabilities predate that security boundary, so revoke
-- them rather than guessing which bot/application-service instance owns them.
ALTER TABLE "IdentityBindingChallenge"
  ADD COLUMN "connectionId" TEXT;

UPDATE "IdentityBindingChallenge"
SET
  "connectionId" = 'legacy-unscoped',
  "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)
WHERE "connectionId" IS NULL;

ALTER TABLE "IdentityBindingChallenge"
  ALTER COLUMN "connectionId" SET NOT NULL,
  ADD CONSTRAINT "IdentityBindingChallenge_issuer_connection_nonempty_check"
    CHECK (length(btrim("issuer")) > 0 AND length(btrim("connectionId")) > 0);

CREATE INDEX "IdentityBindingChallenge_provider_issuer_connectionId_expiresAt_idx"
  ON "IdentityBindingChallenge"("provider", "issuer", "connectionId", "expiresAt");

-- A LOGTO subject is created by the authenticated Web callback. Preserve any
-- stronger timestamp while marking that platform-authenticated proof so only
-- registered Web identities can mint private-channel binding capabilities.
UPDATE "IdentityLink"
SET
  "verifiedAt" = COALESCE("verifiedAt", "createdAt"),
  "assuranceLevel" = 'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
  "proofMetadata" = COALESCE("proofMetadata", '{}'::jsonb) ||
    jsonb_build_object(
      'method', 'authenticated_web_session_backfill',
      'migration', '20260723232000_identity_binding_connection_scope'
    ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'LOGTO'::"IdentityLinkProvider"
  AND "revokedAt" IS NULL
  AND "assuranceLevel" = 'UNVERIFIED'::"IdentityAssuranceLevel";
