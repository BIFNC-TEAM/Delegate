-- Account/AuthIdentity/AppSession v2 expand-only shadow foundation.
--
-- This migration does not backfill, merge, or delete any legacy identity.
-- Owner and AudienceIdentity links remain nullable until separately reviewed,
-- bounded reconciliation has completed.

CREATE TYPE "AccountStatus" AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'DELETION_PENDING',
  'DELETED'
);

CREATE TYPE "AuthIdentityProvider" AS ENUM ('LOGTO');

CREATE TYPE "AuthIdentityStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TYPE "AppSessionApplication" AS ENUM (
  'DASHBOARD',
  'PUBLIC_REPRESENTATIVES'
);

CREATE TABLE "Account" (
  "id" TEXT NOT NULL,
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthIdentity" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "provider" "AuthIdentityProvider" NOT NULL,
  "issuer" VARCHAR(2048) NOT NULL,
  "subject" VARCHAR(255) NOT NULL,
  "status" "AuthIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
  "email" VARCHAR(320),
  "emailVerifiedAt" TIMESTAMP(3),
  "phone" VARCHAR(64),
  "phoneVerifiedAt" TIMESTAMP(3),
  "displayName" VARCHAR(160),
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "lastAuthenticatedAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthIdentity_issuer_nonblank_check"
    CHECK (btrim("issuer") <> ''),
  CONSTRAINT "AuthIdentity_subject_nonblank_check"
    CHECK (btrim("subject") <> ''),
  CONSTRAINT "AuthIdentity_authentication_time_check"
    CHECK ("verifiedAt" <= "lastAuthenticatedAt"),
  CONSTRAINT "AuthIdentity_email_verification_check"
    CHECK ("emailVerifiedAt" IS NULL OR "email" IS NOT NULL),
  CONSTRAINT "AuthIdentity_phone_verification_check"
    CHECK ("phoneVerifiedAt" IS NULL OR "phone" IS NOT NULL)
);

CREATE TABLE "AppSession" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "authIdentityId" TEXT NOT NULL,
  "application" "AppSessionApplication" NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "activeOrganizationId" TEXT,
  "logtoSessionId" VARCHAR(255),
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt" TIMESTAMP(3) NOT NULL,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" VARCHAR(200),
  "deviceLabel" VARCHAR(120),
  "userAgent" VARCHAR(512),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppSession_token_hash_length_check"
    CHECK (octet_length("tokenHash") = 32),
  CONSTRAINT "AppSession_expiry_order_check"
    CHECK (
      "issuedAt" <= "lastSeenAt"
      AND "lastSeenAt" < "idleExpiresAt"
      AND "issuedAt" < "idleExpiresAt"
      AND "idleExpiresAt" <= "absoluteExpiresAt"
    ),
  CONSTRAINT "AppSession_active_organization_disabled_check"
    CHECK ("activeOrganizationId" IS NULL),
  CONSTRAINT "AppSession_revocation_reason_check"
    CHECK (
      (
        "revokedAt" IS NULL
        AND "revokedReason" IS NULL
      )
      OR
      (
        "revokedAt" IS NOT NULL
        AND "revokedReason" IS NOT NULL
        AND btrim("revokedReason") <> ''
      )
    )
);

ALTER TABLE "Owner"
  ADD COLUMN "accountId" TEXT;

ALTER TABLE "AudienceIdentity"
  ADD COLUMN "accountId" TEXT;

CREATE INDEX "Account_status_updatedAt_idx"
  ON "Account"("status", "updatedAt");

CREATE UNIQUE INDEX "AuthIdentity_provider_issuer_subject_key"
  ON "AuthIdentity"("provider", "issuer", "subject");

CREATE UNIQUE INDEX "AuthIdentity_id_accountId_key"
  ON "AuthIdentity"("id", "accountId");

CREATE INDEX "AuthIdentity_accountId_status_idx"
  ON "AuthIdentity"("accountId", "status");

CREATE UNIQUE INDEX "AppSession_tokenHash_key"
  ON "AppSession"("tokenHash");

CREATE INDEX "AppSession_accountId_application_revokedAt_idx"
  ON "AppSession"("accountId", "application", "revokedAt");

CREATE INDEX "AppSession_authIdentityId_application_revokedAt_idx"
  ON "AppSession"("authIdentityId", "application", "revokedAt");

CREATE INDEX "AppSession_application_idleExpiresAt_idx"
  ON "AppSession"("application", "idleExpiresAt");

CREATE INDEX "AppSession_application_absoluteExpiresAt_idx"
  ON "AppSession"("application", "absoluteExpiresAt");

CREATE INDEX "AppSession_activeOrganizationId_revokedAt_idx"
  ON "AppSession"("activeOrganizationId", "revokedAt");

ALTER TABLE "Owner"
  ADD CONSTRAINT "Owner_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "AudienceIdentity"
  ADD CONSTRAINT "AudienceIdentity_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "AuthIdentity"
  ADD CONSTRAINT "AuthIdentity_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppSession"
  ADD CONSTRAINT "AppSession_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite provenance key prevents a session from naming an identity
-- that belongs to a different Account.
ALTER TABLE "AppSession"
  ADD CONSTRAINT "AppSession_authIdentityId_accountId_fkey"
  FOREIGN KEY ("authIdentityId", "accountId")
  REFERENCES "AuthIdentity"("id", "accountId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppSession"
  ADD CONSTRAINT "AppSession_activeOrganizationId_fkey"
  FOREIGN KEY ("activeOrganizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- This cross-field rule can be enforced without guessing any legacy mapping.
-- NOT VALID avoids scanning the existing AudienceIdentity table during the
-- expand deploy while still rejecting invalid new/updated links.
ALTER TABLE "AudienceIdentity"
  ADD CONSTRAINT "AudienceIdentity_registered_account_check"
  CHECK ("accountId" IS NULL OR "status" = 'REGISTERED'::"AudienceIdentityStatus")
  NOT VALID;
