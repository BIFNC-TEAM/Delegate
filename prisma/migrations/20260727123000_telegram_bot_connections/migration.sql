-- Expand the channel control plane from one deployment-level Telegram token
-- to owner-scoped, reusable Bot connections. This migration intentionally
-- imports metadata only: provider credentials must be verified and encrypted
-- by the trusted application bootstrap, never read by SQL.

CREATE TYPE "TelegramBotConnectionScope" AS ENUM (
  'OWNER_MANAGED',
  'PLATFORM_MANAGED'
);

CREATE TYPE "TelegramBotConnectionStatus" AS ENUM (
  'PENDING_CREDENTIAL',
  'ACTIVE',
  'DISABLED',
  'REVOKED'
);

CREATE TYPE "TelegramBotCredentialStatus" AS ENUM (
  'ACTIVE',
  'RETIRED',
  'REVOKED'
);

CREATE TABLE "TelegramBotConnection" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT,
  "scope" "TelegramBotConnectionScope" NOT NULL DEFAULT 'OWNER_MANAGED',
  "botId" TEXT NOT NULL,
  "username" TEXT,
  "displayName" TEXT,
  "label" TEXT,
  "status" "TelegramBotConnectionStatus" NOT NULL DEFAULT 'PENDING_CREDENTIAL',
  "healthStatus" "ChannelHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "activeCredentialId" TEXT,
  "credentialRevision" INTEGER NOT NULL DEFAULT 0,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastHealthCheckAt" TIMESTAMP(3),
  "lastError" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramBotConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TelegramBotConnection_bot_id_numeric_check"
    CHECK ("botId" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "TelegramBotConnection_owner_scope_check"
    CHECK (
      ("scope" = 'OWNER_MANAGED' AND "ownerId" IS NOT NULL)
      OR
      ("scope" = 'PLATFORM_MANAGED' AND "ownerId" IS NULL)
    ),
  CONSTRAINT "TelegramBotConnection_revision_nonnegative_check"
    CHECK ("credentialRevision" >= 0)
);

CREATE TABLE "TelegramBotCredential" (
  "id" TEXT NOT NULL,
  "telegramBotConnectionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "ciphertext" BYTEA,
  "iv" BYTEA,
  "authTag" BYTEA,
  "keyVersion" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
  "fingerprint" TEXT NOT NULL,
  "status" "TelegramBotCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdBy" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramBotCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TelegramBotCredential_version_positive_check"
    CHECK ("version" > 0),
  CONSTRAINT "TelegramBotCredential_payload_consistency_check"
    CHECK (
      (
        "ciphertext" IS NULL
        AND "iv" IS NULL
        AND "authTag" IS NULL
      )
      OR
      (
        octet_length("ciphertext") > 0
        AND octet_length("iv") = 12
        AND octet_length("authTag") = 16
      )
    )
);

CREATE TABLE "IdentityLinkConnectionProof" (
  "id" TEXT NOT NULL,
  "identityLinkId" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "assuranceLevel" "IdentityAssuranceLevel" NOT NULL DEFAULT 'UNVERIFIED',
  "revokedAt" TIMESTAMP(3),
  "proofMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IdentityLinkConnectionProof_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityLinkConnectionProof_scope_nonempty_check"
    CHECK (
      length(btrim("issuer")) > 0
      AND length(btrim("connectionId")) > 0
    )
);

ALTER TABLE "RepresentativeChannelBinding"
  ADD COLUMN "telegramBotConnectionId" TEXT;

ALTER TABLE "ChatSession"
  ADD COLUMN "telegramBotConnectionId" TEXT;

-- Preserve existing direct Telegram binding metadata. If one Bot was shared by
-- multiple owners in the legacy deployment, retain it as platform-managed
-- rather than guessing ownership or duplicating a credential.
WITH legacy_bot_owners AS (
  SELECT
    btrim(binding."connectionId") AS "botId",
    COUNT(DISTINCT representative."ownerId") AS "ownerCount",
    MIN(representative."ownerId") AS "ownerId",
    MAX(
      NULLIF(
        regexp_replace(
          COALESCE(
            binding."configuration" ->> 'botUsername',
            binding."externalUserId",
            ''
          ),
          '^@',
          ''
        ),
        ''
      )
    ) AS "username",
    MIN(binding."createdAt") AS "createdAt"
  FROM "RepresentativeChannelBinding" AS binding
  INNER JOIN "Representative" AS representative
    ON representative."id" = binding."representativeId"
  WHERE binding."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
    AND (
      binding."transport" IS NULL
      OR binding."transport" = 'TELEGRAM'::"ChannelTransport"
    )
    AND binding."connectionId" IS NOT NULL
    AND btrim(binding."connectionId") ~ '^[1-9][0-9]*$'
  GROUP BY btrim(binding."connectionId")
)
INSERT INTO "TelegramBotConnection" (
  "id",
  "ownerId",
  "scope",
  "botId",
  "username",
  "status",
  "healthStatus",
  "credentialRevision",
  "createdAt",
  "updatedAt"
)
SELECT
  'telegram_bot_connection_' || md5(legacy."botId"),
  CASE WHEN legacy."ownerCount" = 1 THEN legacy."ownerId" ELSE NULL END,
  CASE
    WHEN legacy."ownerCount" = 1
      THEN 'OWNER_MANAGED'::"TelegramBotConnectionScope"
    ELSE 'PLATFORM_MANAGED'::"TelegramBotConnectionScope"
  END,
  legacy."botId",
  legacy."username",
  'PENDING_CREDENTIAL'::"TelegramBotConnectionStatus",
  'UNKNOWN'::"ChannelHealthStatus",
  0,
  legacy."createdAt",
  CURRENT_TIMESTAMP
FROM legacy_bot_owners AS legacy
ON CONFLICT DO NOTHING;

UPDATE "RepresentativeChannelBinding" AS binding
SET "telegramBotConnectionId" = connection."id"
FROM "TelegramBotConnection" AS connection
WHERE binding."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
  AND (
    binding."transport" IS NULL
    OR binding."transport" = 'TELEGRAM'::"ChannelTransport"
  )
  AND btrim(binding."connectionId") = connection."botId";

UPDATE "ChatSession" AS session
SET "telegramBotConnectionId" = binding."telegramBotConnectionId"
FROM "RepresentativeChannelBinding" AS binding
WHERE binding."representativeId" = session."representativeId"
  AND binding."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
  AND binding."telegramBotConnectionId" IS NOT NULL;

WITH inferred_inbox_connections AS (
  SELECT
    inbox."id",
    MIN(channel_binding."connectionId") AS "connectionId"
  FROM "ChannelEventInbox" AS inbox
  INNER JOIN "ConversationChannelBinding" AS channel_binding
    ON channel_binding."conversationId" = inbox."conversationId"
  WHERE inbox."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
    AND inbox."connectionId" IS NULL
    AND channel_binding."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
    AND channel_binding."connectionId" IS NOT NULL
    AND length(btrim(channel_binding."connectionId")) > 0
  GROUP BY inbox."id"
  HAVING COUNT(DISTINCT channel_binding."connectionId") = 1
)
UPDATE "ChannelEventInbox" AS inbox
SET
  "connectionId" = inferred."connectionId",
  "originKey" = CASE
    WHEN inbox."originKey" IS NULL
      THEN 'telegram:' || inferred."connectionId" || ':' || inbox."externalEventId"
    ELSE inbox."originKey"
  END
FROM inferred_inbox_connections AS inferred
WHERE inbox."id" = inferred."id";

INSERT INTO "IdentityLinkConnectionProof" (
  "id",
  "identityLinkId",
  "issuer",
  "connectionId",
  "verifiedAt",
  "assuranceLevel",
  "revokedAt",
  "proofMetadata",
  "createdAt",
  "updatedAt"
)
SELECT
  'identity_link_connection_proof_' ||
    md5(link."id" || ':' || link."issuer" || ':' || link."connectionId"),
  link."id",
  link."issuer",
  link."connectionId",
  link."verifiedAt",
  link."assuranceLevel",
  link."revokedAt",
  link."proofMetadata",
  link."createdAt",
  CURRENT_TIMESTAMP
FROM "IdentityLink" AS link
WHERE link."connectionId" IS NOT NULL
  AND length(btrim(link."connectionId")) > 0
ON CONFLICT DO NOTHING;

DROP INDEX "ChatSession_telegramChatId_key";
CREATE UNIQUE INDEX "ChatSession_telegramBotConnectionId_telegramChatId_key"
  ON "ChatSession"("telegramBotConnectionId", "telegramChatId");
-- PostgreSQL treats NULL values as distinct in a normal unique index. Keep a
-- separate legacy boundary until every old environment-backed session has a
-- persisted connection row.
CREATE UNIQUE INDEX "ChatSession_legacy_telegramChatId_key"
  ON "ChatSession"("telegramChatId")
  WHERE "telegramBotConnectionId" IS NULL;
CREATE INDEX "ChatSession_telegramChatId_idx"
  ON "ChatSession"("telegramChatId");
CREATE INDEX "ChatSession_representativeId_telegramBotConnectionId_idx"
  ON "ChatSession"("representativeId", "telegramBotConnectionId");

DROP INDEX "ChannelEventInbox_kind_externalEventId_key";
CREATE UNIQUE INDEX "ChannelEventInbox_kind_connectionId_externalEventId_key"
  ON "ChannelEventInbox"("kind", "connectionId", "externalEventId");
CREATE UNIQUE INDEX "ChannelEventInbox_legacy_kind_externalEventId_key"
  ON "ChannelEventInbox"("kind", "externalEventId")
  WHERE "connectionId" IS NULL;

CREATE INDEX "OutboxEvent_transport_connectionId_status_availableAt_idx"
  ON "OutboxEvent"("transport", "connectionId", "status", "availableAt");

CREATE UNIQUE INDEX "TelegramBotConnection_botId_key"
  ON "TelegramBotConnection"("botId");
CREATE UNIQUE INDEX "TelegramBotConnection_activeCredentialId_key"
  ON "TelegramBotConnection"("activeCredentialId");
CREATE INDEX "TelegramBotConnection_ownerId_status_updatedAt_idx"
  ON "TelegramBotConnection"("ownerId", "status", "updatedAt");
CREATE INDEX "TelegramBotConnection_status_healthStatus_updatedAt_idx"
  ON "TelegramBotConnection"("status", "healthStatus", "updatedAt");

CREATE UNIQUE INDEX "TelegramBotCredential_telegramBotConnectionId_version_key"
  ON "TelegramBotCredential"("telegramBotConnectionId", "version");
CREATE INDEX "TelegramBotCredential_telegramBotConnectionId_fingerprint_idx"
  ON "TelegramBotCredential"("telegramBotConnectionId", "fingerprint");
CREATE UNIQUE INDEX "TelegramBotCredential_telegramBotConnectionId_idempotencyKey_key"
  ON "TelegramBotCredential"("telegramBotConnectionId", "idempotencyKey");
CREATE INDEX "TelegramBotCredential_telegramBotConnectionId_status_createdAt_idx"
  ON "TelegramBotCredential"("telegramBotConnectionId", "status", "createdAt");

CREATE UNIQUE INDEX "IdentityLinkConnectionProof_identityLinkId_issuer_connectionId_key"
  ON "IdentityLinkConnectionProof"("identityLinkId", "issuer", "connectionId");
CREATE INDEX "IdentityLinkConnectionProof_issuer_connectionId_revokedAt_idx"
  ON "IdentityLinkConnectionProof"("issuer", "connectionId", "revokedAt");

CREATE INDEX "RepresentativeChannelBinding_telegramBotConnectionId_desiredState_updatedAt_idx"
  ON "RepresentativeChannelBinding"(
    "telegramBotConnectionId",
    "desiredState",
    "updatedAt"
  );

ALTER TABLE "TelegramBotConnection"
  ADD CONSTRAINT "TelegramBotConnection_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "Owner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TelegramBotCredential"
  ADD CONSTRAINT "TelegramBotCredential_telegramBotConnectionId_fkey"
  FOREIGN KEY ("telegramBotConnectionId") REFERENCES "TelegramBotConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramBotConnection"
  ADD CONSTRAINT "TelegramBotConnection_activeCredentialId_fkey"
  FOREIGN KEY ("activeCredentialId") REFERENCES "TelegramBotCredential"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RepresentativeChannelBinding"
  ADD CONSTRAINT "RepresentativeChannelBinding_telegramBotConnectionId_fkey"
  FOREIGN KEY ("telegramBotConnectionId") REFERENCES "TelegramBotConnection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatSession"
  ADD CONSTRAINT "ChatSession_telegramBotConnectionId_fkey"
  FOREIGN KEY ("telegramBotConnectionId") REFERENCES "TelegramBotConnection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdentityLinkConnectionProof"
  ADD CONSTRAINT "IdentityLinkConnectionProof_identityLinkId_fkey"
  FOREIGN KEY ("identityLinkId") REFERENCES "IdentityLink"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
