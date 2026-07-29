-- Add owner-scoped settings audit event types.
ALTER TYPE "EventType" ADD VALUE 'OWNER_PROFILE_UPDATED';
ALTER TYPE "EventType" ADD VALUE 'OWNER_NOTIFICATION_PREFERENCES_UPDATED';

-- Persist the signed-in Owner's dashboard preferences independently from any
-- Representative. The account display name is deliberately separate from the
-- legacy/public Owner attribution. A nullable locale preserves the existing
-- request-derived locale until the Owner explicitly saves a preference.
ALTER TABLE "Owner"
  ADD COLUMN "accountDisplayName" VARCHAR(80),
  ADD COLUMN "preferredLocale" VARCHAR(16),
  ADD COLUMN "settingsVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Owner"
  ADD CONSTRAINT "Owner_preferredLocale_valid" CHECK (
    "preferredLocale" IS NULL
    OR "preferredLocale" IN ('zh', 'en')
  ) NOT VALID,
  ADD CONSTRAINT "Owner_settingsVersion_nonnegative" CHECK (
    "settingsVersion" >= 0
  ) NOT VALID;

ALTER TABLE "Owner"
  VALIDATE CONSTRAINT "Owner_preferredLocale_valid";

ALTER TABLE "Owner"
  VALIDATE CONSTRAINT "Owner_settingsVersion_nonnegative";

-- Keep the legacy provider-level verification timestamp while recording
-- email and phone assurance independently. The old timestamp does not prove
-- which channel was verified, so both new fields intentionally remain NULL
-- until a later Logto login supplies channel-specific verified claims.
ALTER TABLE "OwnerIdentityLink"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- Notification preferences are Owner-scoped. Missing rows are interpreted by
-- the application as the versioned safe defaults.
CREATE TABLE "OwnerNotificationSettings" (
  "ownerId" TEXT NOT NULL,
  "rules" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OwnerNotificationSettings_pkey" PRIMARY KEY ("ownerId"),
  CONSTRAINT "OwnerNotificationSettings_rules_object" CHECK (
    jsonb_typeof("rules") = 'object'
  ),
  CONSTRAINT "OwnerNotificationSettings_version_nonnegative" CHECK (
    "version" >= 0
  )
);

ALTER TABLE "OwnerNotificationSettings"
  ADD CONSTRAINT "OwnerNotificationSettings_ownerId_fkey"
  FOREIGN KEY ("ownerId")
  REFERENCES "Owner"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Generalize EventAudit without breaking any existing Representative writer.
-- Existing rows remain Representative-scoped and are resolved through their
-- relation; avoiding a full-table ownerId rewrite keeps this migration
-- metadata-only for legacy audit rows. Future events may be Owner-only,
-- Representative-only, or carry both scopes.
ALTER TABLE "EventAudit"
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "idempotencyKey" VARCHAR(191),
  ADD COLUMN "requestHash" VARCHAR(64),
  ALTER COLUMN "representativeId" DROP NOT NULL;

ALTER TABLE "EventAudit"
  ADD CONSTRAINT "EventAudit_scope_valid" CHECK (
    "ownerId" IS NOT NULL
    OR "representativeId" IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT "EventAudit_ownerId_fkey"
  FOREIGN KEY ("ownerId")
  REFERENCES "Owner"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "EventAudit"
  VALIDATE CONSTRAINT "EventAudit_scope_valid";

ALTER TABLE "EventAudit"
  VALIDATE CONSTRAINT "EventAudit_ownerId_fkey";
