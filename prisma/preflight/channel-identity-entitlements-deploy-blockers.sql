-- Read-only pre-deployment gate for the channel/identity expansion.
-- This file intentionally references only columns that exist before
-- 20260723230000_channel_identity_entitlements.

WITH telegram_identity_claims AS (
  SELECT
    btrim(contact."telegramUserId") AS telegram_subject,
    contact."audienceIdentityId" AS audience_identity_id,
    'contact'::text AS claim_source,
    contact."id" AS claim_id
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
    AND contact."audienceIdentityId" IS NOT NULL

  UNION ALL

  SELECT
    btrim(wallet."telegramUserId") AS telegram_subject,
    wallet."audienceIdentityId" AS audience_identity_id,
    'user_wallet'::text AS claim_source,
    wallet."id" AS claim_id
  FROM "UserWallet" AS wallet
  WHERE wallet."telegramUserId" IS NOT NULL
    AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'
    AND wallet."audienceIdentityId" IS NOT NULL

  UNION ALL

  SELECT
    link."providerSubject" AS telegram_subject,
    link."audienceIdentityId" AS audience_identity_id,
    'identity_link'::text AS claim_source,
    link."id" AS claim_id
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
),
identity_conflicts AS (
  SELECT
    'TELEGRAM_IDENTITY_CONFLICT'::text AS issue_code,
    'telegram_subject'::text AS entity_type,
    claim.telegram_subject AS entity_key,
    jsonb_build_object(
      'audienceIdentityIds',
      jsonb_agg(DISTINCT claim.audience_identity_id),
      'claimSources',
      jsonb_agg(
        jsonb_build_object(
          'source', claim.claim_source,
          'id', claim.claim_id,
          'audienceIdentityId', claim.audience_identity_id
        )
        ORDER BY jsonb_build_object(
          'source', claim.claim_source,
          'id', claim.claim_id,
          'audienceIdentityId', claim.audience_identity_id
        )::text
      )
    ) AS details
  FROM telegram_identity_claims AS claim
  GROUP BY claim.telegram_subject
  HAVING count(DISTINCT claim.audience_identity_id) > 1
),
duplicate_payment_charges AS (
  SELECT
    'DUPLICATE_TELEGRAM_PAYMENT_CHARGE'::text AS issue_code,
    'invoice_charge'::text AS entity_type,
    invoice."telegramPaymentChargeId" AS entity_key,
    jsonb_build_object(
      'invoiceIds', jsonb_agg(invoice."id" ORDER BY invoice."id"),
      'count', count(*)
    ) AS details
  FROM "Invoice" AS invoice
  WHERE invoice."telegramPaymentChargeId" IS NOT NULL
  GROUP BY invoice."telegramPaymentChargeId"
  HAVING count(*) > 1
),
duplicate_channel_coordinates AS (
  SELECT
    'DUPLICATE_CHANNEL_COORDINATE'::text AS issue_code,
    'conversation_channel_binding'::text AS entity_type,
    conversation."representativeId" || ':' ||
      binding."kind"::text || ':' ||
      binding."externalConversationId" || ':' ||
      COALESCE(binding."externalThreadId", '') AS entity_key,
    jsonb_build_object(
      'bindingIds', jsonb_agg(binding."id" ORDER BY binding."id"),
      'conversationIds', jsonb_agg(binding."conversationId" ORDER BY binding."conversationId"),
      'count', count(*)
    ) AS details
  FROM "ConversationChannelBinding" AS binding
  INNER JOIN "Conversation" AS conversation
    ON conversation."id" = binding."conversationId"
  GROUP BY
    conversation."representativeId",
    binding."kind",
    binding."externalConversationId",
    COALESCE(binding."externalThreadId", '')
  HAVING count(*) > 1
),
serialized_channel_key_collisions AS (
  SELECT
    'SERIALIZED_CHANNEL_KEY_COLLISION'::text AS issue_code,
    'conversation_channel_binding'::text AS entity_type,
    conversation."representativeId" || ':' ||
      binding."kind"::text || ':' ||
      binding."externalConversationId" || ':' ||
      COALESCE(binding."externalThreadId", '') AS entity_key,
    jsonb_build_object(
      'bindingIds', jsonb_agg(binding."id" ORDER BY binding."id"),
      'logicalCoordinates', jsonb_agg(
        jsonb_build_object(
          'representativeId', conversation."representativeId",
          'kind', binding."kind",
          'externalConversationId', binding."externalConversationId",
          'externalThreadId', binding."externalThreadId"
        )
        ORDER BY binding."id"
      ),
      'count', count(*)
    ) AS details
  FROM "ConversationChannelBinding" AS binding
  INNER JOIN "Conversation" AS conversation
    ON conversation."id" = binding."conversationId"
  GROUP BY
    conversation."representativeId" || ':' ||
      binding."kind"::text || ':' ||
      binding."externalConversationId" || ':' ||
      COALESCE(binding."externalThreadId", '')
  HAVING count(DISTINCT ROW(
    conversation."representativeId",
    binding."kind",
    binding."externalConversationId",
    binding."externalThreadId"
  )) > 1
)
SELECT issue.issue_code, issue.entity_type, issue.entity_key, issue.details
FROM (
  SELECT * FROM identity_conflicts
  UNION ALL
  SELECT * FROM duplicate_payment_charges
  UNION ALL
  SELECT * FROM duplicate_channel_coordinates
  UNION ALL
  SELECT * FROM serialized_channel_key_collisions
) AS issue
ORDER BY issue.issue_code, issue.entity_type, issue.entity_key;
