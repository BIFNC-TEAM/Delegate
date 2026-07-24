-- Read-only parity counters for the channel/identity migration.
-- Run before and after the safe backfill and archive both outputs.

SELECT metric, observed, expected, (observed = expected) AS reconciled
FROM (
  SELECT
    'numeric_telegram_contacts_with_identity'::text AS metric,
    count(*) FILTER (WHERE contact."audienceIdentityId" IS NOT NULL)::bigint AS observed,
    count(*)::bigint AS expected
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'

  UNION ALL

  SELECT
    'numeric_telegram_contacts_with_active_link',
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM "IdentityLink" AS link
        WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
          AND link."providerSubject" = btrim(contact."telegramUserId")
          AND link."revokedAt" IS NULL
          AND link."audienceIdentityId" = contact."audienceIdentityId"
      )
    )::bigint,
    count(*)::bigint
  FROM "Contact" AS contact
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'

  UNION ALL

  SELECT
    'telegram_wallets_with_identity',
    count(*) FILTER (WHERE wallet."audienceIdentityId" IS NOT NULL)::bigint,
    count(*)::bigint
  FROM "UserWallet" AS wallet
  WHERE wallet."telegramUserId" IS NOT NULL
    AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'

  UNION ALL

  SELECT
    'conversations_match_contact_identity',
    count(*) FILTER (
      WHERE conversation."audienceIdentityId" IS NOT DISTINCT FROM contact."audienceIdentityId"
    )::bigint,
    count(*)::bigint
  FROM "Conversation" AS conversation
  INNER JOIN "Contact" AS contact ON contact."id" = conversation."contactId"
  WHERE conversation."audienceIdentityId" IS NOT NULL
     OR contact."audienceIdentityId" IS NOT NULL

  UNION ALL

  SELECT
    'channel_bindings_with_route_and_key',
    count(*) FILTER (
      WHERE binding."transport" IS NOT NULL
        AND binding."sourceProvider" IS NOT NULL
        AND binding."bindingKey" IS NOT NULL
    )::bigint,
    count(*)::bigint
  FROM "ConversationChannelBinding" AS binding

  UNION ALL

  SELECT
    'token_purchases_match_wallet_identity',
    count(*) FILTER (
      WHERE purchase."audienceIdentityId" IS NOT NULL
        AND purchase."audienceIdentityId" IS NOT DISTINCT FROM wallet."audienceIdentityId"
    )::bigint,
    count(*)::bigint
  FROM "AgentTokenPurchase" AS purchase
  INNER JOIN "UserWallet" AS wallet ON wallet."id" = purchase."userWalletId"

  UNION ALL

  SELECT
    'usage_charges_with_audience_identity',
    count(*) FILTER (WHERE charge."audienceIdentityId" IS NOT NULL)::bigint,
    count(*)::bigint
  FROM "AgentUsageCharge" AS charge

  UNION ALL

  SELECT
    'paid_service_orders_with_grant_ledger',
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM "ServiceEntitlementLedgerEntry" AS ledger
        WHERE ledger."paymentOrderId" = payment_order."id"
          AND ledger."kind" = 'GRANT'::"ServiceEntitlementLedgerKind"
      )
    )::bigint,
    count(*)::bigint
  FROM "ServicePaymentOrder" AS payment_order
  WHERE payment_order."status" IN (
    'PAID'::"RechargeOrderStatus",
    'REFUNDED'::"RechargeOrderStatus"
  )
) AS result
ORDER BY metric;

-- Financial totals are shown separately because different rails must never be
-- summed as if they were one currency.
SELECT
  'legacy_user_wallet'::text AS source,
  upper(wallet."currency") AS currency,
  count(*) AS record_count,
  sum(wallet."cashBalanceCents") AS amount_minor
FROM "UserWallet" AS wallet
GROUP BY upper(wallet."currency")

UNION ALL

SELECT
  'service_payment_order',
  upper(payment_order."currency"),
  count(*),
  sum(payment_order."amountMinor")
FROM "ServicePaymentOrder" AS payment_order
WHERE payment_order."status" IN (
  'PAID'::"RechargeOrderStatus",
  'REFUNDED'::"RechargeOrderStatus"
)
GROUP BY upper(payment_order."currency")
ORDER BY source, currency;
