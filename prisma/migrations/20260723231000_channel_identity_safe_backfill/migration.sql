-- Conservative, restartable backfill for the channel/identity expansion.
--
-- This migration only copies facts that are already proven by unique provider
-- identifiers or foreign keys. It deliberately does not synthesize historical
-- ServicePaymentOrder or ServiceEntitlementAccount rows from Invoice.isPaid /
-- Conversation unlock flags: the legacy runtime granted effectively unmetered
-- access while the new model grants counted units, so a remaining balance
-- cannot be reconstructed without a product decision. Those records are
-- surfaced by prisma/preflight/channel-identity-entitlements-conflicts.sql.

-- Matrix provider subjects created before issuer realms were enforced used the
-- generic "delegate" default. Normalize the homeserver portion and issuer only
-- when no other row would claim the normalized MXID. Malformed or colliding
-- rows remain untouched for explicit reconciliation.
WITH matrix_candidates AS (
  SELECT
    link."id",
    left(
      link."providerSubject",
      length(link."providerSubject") - length(split_part(link."providerSubject", ':', 2))
    ) || lower(split_part(link."providerSubject", ':', 2)) AS normalized_subject,
    lower(split_part(link."providerSubject", ':', 2)) AS normalized_issuer
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'MATRIX'::"IdentityLinkProvider"
    AND link."issuer" = 'delegate'
    AND link."providerSubject" ~ '^@[^[:space:]:]+:[^[:space:]:]+$'
),
safe_matrix_candidates AS (
  SELECT candidate.*
  FROM matrix_candidates AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM "IdentityLink" AS existing
    WHERE existing."provider" = 'MATRIX'::"IdentityLinkProvider"
      AND existing."id" <> candidate."id"
      AND existing."providerSubject" ~ '^@[^[:space:]:]+:[^[:space:]:]+$'
      AND (
        left(
          existing."providerSubject",
          length(existing."providerSubject") - length(split_part(existing."providerSubject", ':', 2))
        ) || lower(split_part(existing."providerSubject", ':', 2))
      ) = candidate.normalized_subject
  )
)
UPDATE "IdentityLink" AS link
SET
  "providerSubject" = candidate.normalized_subject,
  "issuer" = candidate.normalized_issuer,
  "proofMetadata" = COALESCE(link."proofMetadata", '{}'::jsonb) ||
    jsonb_build_object(
      'issuerBackfillSource', 'matrix_mxid_homeserver',
      'migration', '20260723231000_channel_identity_safe_backfill'
    ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM safe_matrix_candidates AS candidate
WHERE link."id" = candidate."id";

-- Telegram has one stable platform authentication realm. The concrete bot
-- username is a connection identifier and is not recoverable from legacy rows.
UPDATE "IdentityLink"
SET
  "issuer" = 'delegate-managed-bot',
  "proofMetadata" = COALESCE("proofMetadata", '{}'::jsonb) ||
    jsonb_build_object(
      'issuerBackfillSource', 'legacy_delegate_default',
      'migration', '20260723231000_channel_identity_safe_backfill'
    ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'TELEGRAM'::"IdentityLinkProvider"
  AND "issuer" = 'delegate';

-- A non-null legacy verifiedAt is explicit evidence. Preserve the original
-- timestamp while upgrading only the assurance classification introduced by
-- the preceding expansion migration.
UPDATE "IdentityLink"
SET
  "assuranceLevel" = 'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
  "proofMetadata" = COALESCE(
    "proofMetadata",
    jsonb_build_object('source', 'legacy_verified_at_backfill')
  )
WHERE "verifiedAt" IS NOT NULL
  AND "revokedAt" IS NULL
  AND "assuranceLevel" = 'UNVERIFIED'::"IdentityAssuranceLevel";

-- Create one provisional identity only for numeric Telegram subjects observed
-- on a Contact. Existing Contact, UserWallet, IdentityLink, or canonical
-- audience-key claims take precedence. Conflicting claims are not changed.
WITH telegram_subjects AS (
  SELECT DISTINCT btrim(contact."telegramUserId") AS telegram_subject
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
),
identity_claims AS (
  SELECT
    btrim(contact."telegramUserId") AS telegram_subject,
    contact."audienceIdentityId" AS audience_identity_id
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
    AND contact."audienceIdentityId" IS NOT NULL

  UNION

  SELECT
    btrim(wallet."telegramUserId") AS telegram_subject,
    wallet."audienceIdentityId" AS audience_identity_id
  FROM "UserWallet" AS wallet
  WHERE wallet."telegramUserId" IS NOT NULL
    AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'
    AND wallet."audienceIdentityId" IS NOT NULL

  UNION

  SELECT
    link."providerSubject" AS telegram_subject,
    link."audienceIdentityId" AS audience_identity_id
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"

  UNION

  SELECT
    split_part(identity."audienceKey", ':', 4) AS telegram_subject,
    identity."id" AS audience_identity_id
  FROM "AudienceIdentity" AS identity
  WHERE identity."audienceKey" ~ '^channel:telegram:[^:]+:[0-9]+$'
),
claim_counts AS (
  SELECT
    subject.telegram_subject,
    count(DISTINCT claim.audience_identity_id) AS identity_count
  FROM telegram_subjects AS subject
  LEFT JOIN identity_claims AS claim
    ON claim.telegram_subject = subject.telegram_subject
  GROUP BY subject.telegram_subject
)
INSERT INTO "AudienceIdentity" (
  "id",
  "audienceKey",
  "status",
  "createdAt",
  "updatedAt",
  "lastSeenAt"
)
SELECT
  'backfill_tg_identity_' || md5(claim.telegram_subject),
  'channel:telegram:delegate-managed-bot:' || claim.telegram_subject,
  'ANONYMOUS'::"AudienceIdentityStatus",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM claim_counts AS claim
WHERE claim.identity_count = 0
  AND NOT EXISTS (
    SELECT 1
    FROM "IdentityLink" AS existing_link
    WHERE existing_link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
      AND existing_link."providerSubject" = claim.telegram_subject
  )
ON CONFLICT DO NOTHING;

-- Resolve a subject only when every existing claim names the same live,
-- canonical identity. A revoked link blocks automatic relinking.
WITH telegram_subjects AS (
  SELECT
    btrim(contact."telegramUserId") AS telegram_subject,
    min(contact."createdAt") AS first_seen_at
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
  GROUP BY btrim(contact."telegramUserId")
),
identity_claims AS (
  SELECT
    btrim(contact."telegramUserId") AS telegram_subject,
    contact."audienceIdentityId" AS audience_identity_id
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
    AND contact."audienceIdentityId" IS NOT NULL

  UNION

  SELECT
    btrim(wallet."telegramUserId") AS telegram_subject,
    wallet."audienceIdentityId" AS audience_identity_id
  FROM "UserWallet" AS wallet
  WHERE wallet."telegramUserId" IS NOT NULL
    AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'
    AND wallet."audienceIdentityId" IS NOT NULL

  UNION

  SELECT
    link."providerSubject" AS telegram_subject,
    link."audienceIdentityId" AS audience_identity_id
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"

  UNION

  SELECT
    split_part(identity."audienceKey", ':', 4) AS telegram_subject,
    identity."id" AS audience_identity_id
  FROM "AudienceIdentity" AS identity
  WHERE identity."audienceKey" ~ '^channel:telegram:[^:]+:[0-9]+$'
),
resolved_claims AS (
  SELECT
    subject.telegram_subject,
    subject.first_seen_at,
    min(claim.audience_identity_id) AS audience_identity_id
  FROM telegram_subjects AS subject
  INNER JOIN identity_claims AS claim
    ON claim.telegram_subject = subject.telegram_subject
  GROUP BY subject.telegram_subject, subject.first_seen_at
  HAVING count(DISTINCT claim.audience_identity_id) = 1
)
INSERT INTO "IdentityLink" (
  "id",
  "audienceIdentityId",
  "provider",
  "providerSubject",
  "issuer",
  "verifiedAt",
  "assuranceLevel",
  "proofMetadata",
  "metadata",
  "createdAt",
  "updatedAt"
)
SELECT
  'backfill_tg_link_' || md5(resolved.telegram_subject),
  resolved.audience_identity_id,
  'TELEGRAM'::"IdentityLinkProvider",
  resolved.telegram_subject,
  -- The platform-managed Telegram authentication realm is stable; a concrete
  -- bot username belongs in connectionId and is intentionally not guessed.
  'delegate-managed-bot',
  resolved.first_seen_at,
  'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
  jsonb_build_object(
    'source', 'legacy_contact_numeric_telegram_user_id',
    'migration', '20260723231000_channel_identity_safe_backfill'
  ),
  jsonb_build_object('provisional', true, 'backfilled', true),
  resolved.first_seen_at,
  CURRENT_TIMESTAMP
FROM resolved_claims AS resolved
INNER JOIN "AudienceIdentity" AS identity
  ON identity."id" = resolved.audience_identity_id
WHERE identity."mergedIntoId" IS NULL
  AND identity."status" NOT IN (
    'MERGED'::"AudienceIdentityStatus",
    'DISABLED'::"AudienceIdentityStatus"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "IdentityLink" AS revoked_link
    WHERE revoked_link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
      AND revoked_link."providerSubject" = resolved.telegram_subject
  )
ON CONFLICT ("provider", "providerSubject") DO NOTHING;

-- Attach only previously-unattached records. Existing disagreements are left
-- untouched and remain visible in the reconciliation report.
UPDATE "Contact" AS contact
SET
  "audienceIdentityId" = link."audienceIdentityId",
  "channelUserId" = COALESCE(
    contact."channelUserId",
    'telegram:' || btrim(contact."telegramUserId")
  ),
  "externalUserId" = COALESCE(
    contact."externalUserId",
    'telegram:' || btrim(contact."telegramUserId")
  ),
  "sourceChannel" = COALESCE(contact."sourceChannel", 'telegram'),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "IdentityLink" AS link
INNER JOIN "AudienceIdentity" AS identity
  ON identity."id" = link."audienceIdentityId"
WHERE contact."audienceIdentityId" IS NULL
  AND contact."telegramUserId" IS NOT NULL
  AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
  AND link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
  AND link."providerSubject" = btrim(contact."telegramUserId")
  AND link."revokedAt" IS NULL
  AND identity."mergedIntoId" IS NULL
  AND identity."status" NOT IN (
    'MERGED'::"AudienceIdentityStatus",
    'DISABLED'::"AudienceIdentityStatus"
  );

-- Normalize the channel identifiers even when a Contact already had a
-- canonical identity. This remains restricted to numeric Telegram IDs so
-- legacy Web records that reused telegramUserId (for example "web:...") are
-- not mislabeled.
UPDATE "Contact"
SET
  "channelUserId" = COALESCE(
    "channelUserId",
    'telegram:' || btrim("telegramUserId")
  ),
  "externalUserId" = COALESCE(
    "externalUserId",
    'telegram:' || btrim("telegramUserId")
  ),
  "sourceChannel" = COALESCE("sourceChannel", 'telegram'),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "telegramUserId" IS NOT NULL
  AND btrim("telegramUserId") ~ '^[0-9]+$'
  AND (
    "channelUserId" IS NULL
    OR "externalUserId" IS NULL
    OR "sourceChannel" IS NULL
  );

UPDATE "UserWallet" AS wallet
SET
  "audienceIdentityId" = link."audienceIdentityId",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "IdentityLink" AS link
INNER JOIN "AudienceIdentity" AS identity
  ON identity."id" = link."audienceIdentityId"
WHERE wallet."audienceIdentityId" IS NULL
  AND wallet."telegramUserId" IS NOT NULL
  AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'
  AND link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
  AND link."providerSubject" = btrim(wallet."telegramUserId")
  AND link."revokedAt" IS NULL
  AND identity."mergedIntoId" IS NULL
  AND identity."status" NOT IN (
    'MERGED'::"AudienceIdentityStatus",
    'DISABLED'::"AudienceIdentityStatus"
  );

UPDATE "Conversation" AS conversation
SET
  "audienceIdentityId" = contact."audienceIdentityId",
  "sourceChannel" = COALESCE(conversation."sourceChannel", 'telegram'),
  "externalConversationId" = COALESCE(
    conversation."externalConversationId",
    conversation."telegramChatId"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Contact" AS contact
WHERE conversation."contactId" = contact."id"
  AND conversation."representativeId" = contact."representativeId"
  AND conversation."audienceIdentityId" IS NULL
  AND contact."audienceIdentityId" IS NOT NULL
  AND contact."telegramUserId" IS NOT NULL
  AND btrim(contact."telegramUserId") ~ '^[0-9]+$';

UPDATE "Conversation" AS conversation
SET
  "sourceChannel" = COALESCE(conversation."sourceChannel", 'telegram'),
  "externalConversationId" = COALESCE(
    conversation."externalConversationId",
    conversation."telegramChatId"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Contact" AS contact
WHERE conversation."contactId" = contact."id"
  AND conversation."representativeId" = contact."representativeId"
  AND contact."telegramUserId" IS NOT NULL
  AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
  AND (
    conversation."sourceChannel" IS NULL
    OR conversation."externalConversationId" IS NULL
  );

-- Restore the representative binding relation where the legacy row already
-- proves the representative and channel kind.
UPDATE "ConversationChannelBinding" AS binding
SET
  "representativeBindingId" = representative_binding."id",
  "connectionId" = COALESCE(
    binding."connectionId",
    representative_binding."connectionId"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Conversation" AS conversation
INNER JOIN "RepresentativeChannelBinding" AS representative_binding
  ON representative_binding."representativeId" = conversation."representativeId"
WHERE binding."conversationId" = conversation."id"
  AND binding."kind" = representative_binding."kind"
  AND binding."representativeBindingId" IS NULL;

-- Re-evaluate keys without selecting a winner. Both the logical coordinate
-- and its serialized key must be globally unambiguous before a key is set.
WITH coordinate_candidates AS (
  SELECT
    binding."id",
    binding."kind"::text || ':' ||
      conversation."representativeId" || ':' ||
      binding."externalConversationId" || ':' ||
      COALESCE(binding."externalThreadId", '') AS proposed_key,
    count(*) OVER (
      PARTITION BY
        conversation."representativeId",
        binding."kind",
        binding."externalConversationId",
        COALESCE(binding."externalThreadId", '')
    ) AS coordinate_count
  FROM "ConversationChannelBinding" AS binding
  INNER JOIN "Conversation" AS conversation
    ON conversation."id" = binding."conversationId"
  WHERE binding."bindingKey" IS NULL
),
key_candidates AS (
  SELECT
    candidate."id",
    candidate.proposed_key,
    candidate.coordinate_count,
    count(*) OVER (
      PARTITION BY candidate.proposed_key
    ) AS serialized_key_count
  FROM coordinate_candidates AS candidate
)
UPDATE "ConversationChannelBinding" AS binding
SET
  "bindingKey" = candidate.proposed_key,
  "updatedAt" = CURRENT_TIMESTAMP
FROM key_candidates AS candidate
WHERE candidate."id" = binding."id"
  AND candidate.coordinate_count = 1
  AND candidate.serialized_key_count = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "ConversationChannelBinding" AS existing
    WHERE existing."bindingKey" = candidate.proposed_key
  );

-- Propagate a route to old inbox/outbox rows only when every binding on the
-- conversation agrees on source and transport.
WITH unambiguous_routes AS (
  SELECT
    binding."conversationId",
    max(binding."transport"::text)::"ChannelTransport" AS transport,
    max(binding."sourceProvider"::text)::"ChannelSourceProvider" AS source_provider,
    CASE
      WHEN count(DISTINCT binding."connectionId") = 1
        THEN max(binding."connectionId")
      ELSE NULL
    END AS connection_id
  FROM "ConversationChannelBinding" AS binding
  WHERE binding."transport" IS NOT NULL
    AND binding."sourceProvider" IS NOT NULL
  GROUP BY binding."conversationId"
  HAVING count(DISTINCT binding."transport") = 1
    AND count(DISTINCT binding."sourceProvider") = 1
)
UPDATE "ChannelEventInbox" AS inbox
SET
  "transport" = COALESCE(inbox."transport", route.transport),
  "sourceProvider" = COALESCE(inbox."sourceProvider", route.source_provider),
  "connectionId" = COALESCE(inbox."connectionId", route.connection_id),
  "updatedAt" = CURRENT_TIMESTAMP
FROM unambiguous_routes AS route
WHERE inbox."conversationId" = route."conversationId"
  AND (
    inbox."transport" IS NULL
    OR inbox."sourceProvider" IS NULL
    OR (inbox."connectionId" IS NULL AND route.connection_id IS NOT NULL)
  );

WITH unambiguous_routes AS (
  SELECT
    binding."conversationId",
    max(binding."transport"::text)::"ChannelTransport" AS transport,
    max(binding."sourceProvider"::text)::"ChannelSourceProvider" AS source_provider,
    CASE
      WHEN count(DISTINCT binding."connectionId") = 1
        THEN max(binding."connectionId")
      ELSE NULL
    END AS connection_id
  FROM "ConversationChannelBinding" AS binding
  WHERE binding."transport" IS NOT NULL
    AND binding."sourceProvider" IS NOT NULL
  GROUP BY binding."conversationId"
  HAVING count(DISTINCT binding."transport") = 1
    AND count(DISTINCT binding."sourceProvider") = 1
)
UPDATE "OutboxEvent" AS outbox
SET
  "transport" = COALESCE(outbox."transport", route.transport),
  "sourceProvider" = COALESCE(outbox."sourceProvider", route.source_provider),
  "connectionId" = COALESCE(outbox."connectionId", route.connection_id),
  "updatedAt" = CURRENT_TIMESTAMP
FROM unambiguous_routes AS route
WHERE outbox."conversationId" = route."conversationId"
  AND (
    outbox."transport" IS NULL
    OR outbox."sourceProvider" IS NULL
    OR (outbox."connectionId" IS NULL AND route.connection_id IS NOT NULL)
  );

-- Preserve proven ownership on the legacy financial aggregates. Creating an
-- entitlement account is intentionally deferred until the reconciliation
-- report proves that every debit for the representative is attributable.
UPDATE "AgentTokenPurchase" AS purchase
SET "audienceIdentityId" = wallet."audienceIdentityId"
FROM "UserWallet" AS wallet
INNER JOIN "AudienceIdentity" AS identity
  ON identity."id" = wallet."audienceIdentityId"
WHERE purchase."userWalletId" = wallet."id"
  AND purchase."audienceIdentityId" IS NULL
  AND wallet."audienceIdentityId" IS NOT NULL
  AND identity."mergedIntoId" IS NULL
  AND identity."status" NOT IN (
    'MERGED'::"AudienceIdentityStatus",
    'DISABLED'::"AudienceIdentityStatus"
  );

UPDATE "AgentUsageCharge" AS charge
SET "audienceIdentityId" = purchase."audienceIdentityId"
FROM "AgentTokenPurchase" AS purchase
WHERE charge."tokenPurchaseId" = purchase."id"
  AND charge."audienceIdentityId" IS NULL
  AND purchase."audienceIdentityId" IS NOT NULL;
