-- Read-only post-migration reconciliation report.
--
-- Zero rows means the conservative backfill has no unresolved identity,
-- channel-coordinate, or entitlement invariants. Rows are intentionally
-- actionable; this query never chooses a winner for ambiguous financial or
-- identity evidence.

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
      'audienceIdentityIds', jsonb_agg(DISTINCT claim.audience_identity_id),
      'claims', jsonb_agg(
        jsonb_build_object(
          'source', claim.claim_source,
          'id', claim.claim_id,
          'audienceIdentityId', claim.audience_identity_id
        )
        ORDER BY claim.claim_source, claim.claim_id
      )
    ) AS details
  FROM telegram_identity_claims AS claim
  GROUP BY claim.telegram_subject
  HAVING count(DISTINCT claim.audience_identity_id) > 1
),
unusable_telegram_links AS (
  SELECT
    CASE
      WHEN link."revokedAt" IS NOT NULL THEN 'REVOKED_TELEGRAM_LINK_REQUIRES_RELINK'
      ELSE 'NONCANONICAL_TELEGRAM_LINK'
    END::text AS issue_code,
    'identity_link'::text AS entity_type,
    link."id" AS entity_key,
    jsonb_build_object(
      'telegramSubject', link."providerSubject",
      'audienceIdentityId', link."audienceIdentityId",
      'identityStatus', identity."status",
      'mergedIntoId', identity."mergedIntoId",
      'revokedAt', link."revokedAt"
    ) AS details
  FROM "IdentityLink" AS link
  INNER JOIN "AudienceIdentity" AS identity
    ON identity."id" = link."audienceIdentityId"
  WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
    AND (
      link."revokedAt" IS NOT NULL
      OR identity."mergedIntoId" IS NOT NULL
      OR identity."status" IN (
        'MERGED'::"AudienceIdentityStatus",
        'DISABLED'::"AudienceIdentityStatus"
      )
  )
),
matrix_link_parts AS (
  SELECT
    link.*,
    CASE
      WHEN position(':' IN link."providerSubject") > 2
        THEN substring(
          link."providerSubject"
          FROM position(':' IN link."providerSubject") + 1
        )
      ELSE ''
    END AS matrix_server_name
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'MATRIX'::"IdentityLinkProvider"
),
matrix_link_server_parts AS (
  SELECT
    link.*,
    CASE
      WHEN link.matrix_server_name ~ '^\[[^]]+\]'
        THEN substring(
          link.matrix_server_name
          FROM 2 FOR position(']' IN link.matrix_server_name) - 2
        )
      WHEN link.matrix_server_name !~ '^\['
        THEN regexp_replace(link.matrix_server_name, ':[0-9]+$', '')
      ELSE NULL
    END AS matrix_server_host,
    CASE
      WHEN link.matrix_server_name ~ '^\[[^]]+\]:[0-9]+$'
        THEN substring(link.matrix_server_name FROM ':([0-9]+)$')
      WHEN link.matrix_server_name !~ '^\['
        AND link.matrix_server_name ~ ':[0-9]+$'
        THEN substring(link.matrix_server_name FROM ':([0-9]+)$')
      ELSE NULL
    END AS matrix_server_port
  FROM matrix_link_parts AS link
),
matrix_link_validation AS (
  SELECT
    link.*,
    (
      octet_length(link."providerSubject") <= 255
      AND link."providerSubject" ~ '^@[^[:space:]:]+:'
      AND length(link.matrix_server_name) BETWEEN 1 AND 255
      AND (
        (
          link.matrix_server_name
            ~ '^\[[0-9A-Fa-f:.]+\](:[1-9][0-9]{0,4})?$'
          AND CASE
            WHEN pg_input_is_valid(link.matrix_server_host, 'inet')
              THEN family(link.matrix_server_host::inet) = 6
            ELSE false
          END
        )
        OR (
          link.matrix_server_name !~ '^\['
          AND link.matrix_server_name !~ ':.*:'
          AND (
            link.matrix_server_port IS NULL
            OR (
              link.matrix_server_port ~ '^[1-9][0-9]{0,4}$'
              AND link.matrix_server_port::integer <= 65535
            )
          )
          AND CASE
            WHEN link.matrix_server_host ~ '^[0-9]+(\.[0-9]+){3}$'
              THEN CASE
                WHEN pg_input_is_valid(link.matrix_server_host, 'inet')
                  THEN family(link.matrix_server_host::inet) = 4
                    AND link.matrix_server_host !~ '(^|\.)0[0-9]'
                ELSE false
              END
            ELSE link.matrix_server_host
              ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
          END
        )
      )
    ) AS matrix_identifier_valid
  FROM matrix_link_server_parts AS link
),
unusable_matrix_links AS (
  SELECT
    'REVOKED_MATRIX_LINK_REQUIRES_RELINK'::text AS issue_code,
    'identity_link'::text AS entity_type,
    link."id" AS entity_key,
    jsonb_build_object(
      'providerSubject', link."providerSubject",
      'issuer', link."issuer",
      'audienceIdentityId', link."audienceIdentityId",
      'revokedAt', link."revokedAt",
      'remediation', link."proofMetadata"->>'matrixCaseRemediation'
    ) AS details
  FROM matrix_link_validation AS link
  WHERE link."revokedAt" IS NOT NULL
),
matrix_issuer_issues AS (
  SELECT
    CASE
      WHEN NOT link.matrix_identifier_valid
        THEN 'MATRIX_LINK_INVALID_FULL_MXID'
      WHEN link."issuer" = 'delegate'
        THEN 'MATRIX_LINK_DEFAULT_ISSUER'
      ELSE 'MATRIX_LINK_ISSUER_MISMATCH'
    END::text AS issue_code,
    'identity_link'::text AS entity_type,
    link."id" AS entity_key,
    jsonb_build_object(
      'providerSubject', link."providerSubject",
      'issuer', link."issuer",
      'expectedIssuer',
        CASE
          WHEN link.matrix_identifier_valid
            THEN link.matrix_server_name
          ELSE NULL
        END
    ) AS details
  FROM matrix_link_validation AS link
  WHERE link."revokedAt" IS NULL
    AND (
      NOT link.matrix_identifier_valid
      OR link."issuer" = 'delegate'
      OR link."issuer" <> link.matrix_server_name
    )
),
telegram_issuer_issues AS (
  SELECT
    'TELEGRAM_LINK_ISSUER_MISMATCH'::text AS issue_code,
    'identity_link'::text AS entity_type,
    link."id" AS entity_key,
    jsonb_build_object(
      'providerSubject', link."providerSubject",
      'issuer', link."issuer",
      'expectedIssuer', 'delegate-managed-bot',
      'connectionId', link."connectionId"
    ) AS details
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
    AND link."issuer" <> 'delegate-managed-bot'
),
wallet_without_provider_proof AS (
  SELECT
    'WALLET_TELEGRAM_SUBJECT_WITHOUT_PROVIDER_PROOF'::text AS issue_code,
    'user_wallet'::text AS entity_type,
    wallet."id" AS entity_key,
    jsonb_build_object(
      'telegramSubject', wallet."telegramUserId",
      'audienceIdentityId', wallet."audienceIdentityId",
      'cashBalanceCents', wallet."cashBalanceCents",
      'currency', wallet."currency"
    ) AS details
  FROM "UserWallet" AS wallet
  WHERE wallet."telegramUserId" IS NOT NULL
    AND btrim(wallet."telegramUserId") ~ '^[0-9]+$'
    AND NOT EXISTS (
      SELECT 1
      FROM "IdentityLink" AS link
      WHERE link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
        AND link."providerSubject" = btrim(wallet."telegramUserId")
        AND link."revokedAt" IS NULL
    )
),
contact_link_mismatch AS (
  SELECT
    'CONTACT_TELEGRAM_IDENTITY_MISMATCH'::text AS issue_code,
    'contact'::text AS entity_type,
    contact."id" AS entity_key,
    jsonb_build_object(
      'telegramSubject', contact."telegramUserId",
      'contactAudienceIdentityId', contact."audienceIdentityId",
      'linkedAudienceIdentityId', link."audienceIdentityId"
    ) AS details
  FROM "Contact" AS contact
  INNER JOIN "IdentityLink" AS link
    ON link."provider" = 'TELEGRAM'::"IdentityLinkProvider"
   AND link."providerSubject" = btrim(contact."telegramUserId")
   AND link."revokedAt" IS NULL
  WHERE contact."telegramUserId" IS NOT NULL
    AND btrim(contact."telegramUserId") ~ '^[0-9]+$'
    AND contact."audienceIdentityId" IS DISTINCT FROM link."audienceIdentityId"
),
conversation_identity_mismatch AS (
  SELECT
    'CONVERSATION_CONTACT_IDENTITY_MISMATCH'::text AS issue_code,
    'conversation'::text AS entity_type,
    conversation."id" AS entity_key,
    jsonb_build_object(
      'conversationAudienceIdentityId', conversation."audienceIdentityId",
      'contactId', contact."id",
      'contactAudienceIdentityId', contact."audienceIdentityId"
    ) AS details
  FROM "Conversation" AS conversation
  INNER JOIN "Contact" AS contact
    ON contact."id" = conversation."contactId"
  WHERE conversation."audienceIdentityId" IS DISTINCT FROM contact."audienceIdentityId"
    AND (
      conversation."audienceIdentityId" IS NOT NULL
      OR contact."audienceIdentityId" IS NOT NULL
    )
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
),
unkeyed_channel_bindings AS (
  SELECT
    'UNKEYED_CHANNEL_BINDING'::text AS issue_code,
    'conversation_channel_binding'::text AS entity_type,
    binding."id" AS entity_key,
    jsonb_build_object(
      'conversationId', binding."conversationId",
      'kind', binding."kind",
      'transport', binding."transport",
      'sourceProvider', binding."sourceProvider",
      'externalConversationId', binding."externalConversationId",
      'externalThreadId', binding."externalThreadId"
    ) AS details
  FROM "ConversationChannelBinding" AS binding
  WHERE binding."bindingKey" IS NULL
     OR binding."transport" IS NULL
     OR binding."sourceProvider" IS NULL
),
orphaned_channel_bindings AS (
  SELECT
    'ORPHANED_CONVERSATION_CHANNEL_BINDING'::text AS issue_code,
    'conversation_channel_binding'::text AS entity_type,
    binding."id" AS entity_key,
    jsonb_build_object(
      'conversationId', binding."conversationId",
      'representativeId', conversation."representativeId",
      'kind', binding."kind",
      'representativeBindingId', binding."representativeBindingId",
      'reason',
        'Ingress and generation require a matching representative channel binding; resolve or isolate this route before cutover.'
    ) AS details
  FROM "ConversationChannelBinding" AS binding
  INNER JOIN "Conversation" AS conversation
    ON conversation."id" = binding."conversationId"
  LEFT JOIN "RepresentativeChannelBinding" AS representative_binding
    ON representative_binding."id" = binding."representativeBindingId"
   AND representative_binding."representativeId" = conversation."representativeId"
   AND representative_binding."kind" = binding."kind"
  WHERE representative_binding."id" IS NULL
),
channel_connection_issues AS (
  SELECT
    'ACTIVE_CHANNEL_CONNECTION_ID_REQUIRED'::text AS issue_code,
    'representative_channel_binding'::text AS entity_type,
    binding."id" AS entity_key,
    jsonb_build_object(
      'representativeId', binding."representativeId",
      'kind', binding."kind",
      'transport', binding."transport",
      'sourceProvider', binding."sourceProvider",
      'desiredState', binding."desiredState",
      'externalUserId', binding."externalUserId",
      'reason',
        'The legacy database does not prove a bot, homeserver, or application-service connection identifier.'
    ) AS details
  FROM "RepresentativeChannelBinding" AS binding
  WHERE binding."kind" <> 'WEB'::"RepresentativeChannelKind"
    AND binding."desiredState" = 'ACTIVE'::"ChannelDesiredState"
    AND binding."connectionId" IS NULL
),
ambiguous_wallet_ownership AS (
  SELECT
    'MULTIPLE_USER_WALLETS_FOR_IDENTITY_CURRENCY'::text AS issue_code,
    'audience_identity'::text AS entity_type,
    wallet."audienceIdentityId" || ':' || upper(wallet."currency") AS entity_key,
    jsonb_build_object(
      'walletIds', jsonb_agg(wallet."id" ORDER BY wallet."id"),
      'cashBalanceCents', sum(wallet."cashBalanceCents"),
      'count', count(*)
    ) AS details
  FROM "UserWallet" AS wallet
  WHERE wallet."audienceIdentityId" IS NOT NULL
  GROUP BY wallet."audienceIdentityId", upper(wallet."currency")
  HAVING count(*) > 1
),
purchase_identity_issues AS (
  SELECT
    CASE
      WHEN purchase."audienceIdentityId" IS NULL
        THEN 'TOKEN_PURCHASE_WITHOUT_AUDIENCE_IDENTITY'
      ELSE 'TOKEN_PURCHASE_WALLET_IDENTITY_MISMATCH'
    END::text AS issue_code,
    'agent_token_purchase'::text AS entity_type,
    purchase."id" AS entity_key,
    jsonb_build_object(
      'purchaseAudienceIdentityId', purchase."audienceIdentityId",
      'walletId', wallet."id",
      'walletAudienceIdentityId', wallet."audienceIdentityId",
      'representativeId', purchase."representativeId",
      'tokenAmount', purchase."tokenAmount",
      'status', purchase."status"
    ) AS details
  FROM "AgentTokenPurchase" AS purchase
  INNER JOIN "UserWallet" AS wallet ON wallet."id" = purchase."userWalletId"
  WHERE purchase."audienceIdentityId" IS NULL
     OR purchase."audienceIdentityId" IS DISTINCT FROM wallet."audienceIdentityId"
),
unattributed_usage AS (
  SELECT
    'USAGE_CHARGE_WITHOUT_AUDIENCE_IDENTITY'::text AS issue_code,
    'agent_usage_charge'::text AS entity_type,
    charge."id" AS entity_key,
    jsonb_build_object(
      'representativeId', charge."representativeId",
      'tokenPurchaseId', charge."tokenPurchaseId",
      'tokenAmount', charge."tokenAmount",
      'status', charge."status"
    ) AS details
  FROM "AgentUsageCharge" AS charge
  WHERE charge."audienceIdentityId" IS NULL
),
invoice_reconciliation AS (
  SELECT
    invoice."id",
    invoice."representativeId",
    invoice."contactId",
    invoice."conversationId",
    invoice."planType",
    invoice."title",
    invoice."starsAmount",
    invoice."status",
    invoice."telegramPaymentChargeId",
    invoice."paidAt",
    invoice."refundedAt",
    contact."audienceIdentityId",
    conversation."passUnlockedAt",
    conversation."deepHelpUnlockedAt",
    0::bigint AS pricing_match_count,
    NULL::integer AS included_replies
  FROM "Invoice" AS invoice
  INNER JOIN "Contact" AS contact ON contact."id" = invoice."contactId"
  LEFT JOIN "Conversation" AS conversation ON conversation."id" = invoice."conversationId"
  WHERE invoice."planType" <> 'SPONSOR'::"PricingPlanType"
    AND invoice."status" IN (
      'PAID'::"InvoiceStatus",
      'FULFILLED'::"InvoiceStatus",
      'REFUNDED'::"InvoiceStatus"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "ServicePaymentOrder" AS payment_order
      WHERE payment_order."id" = 'service-payment:' || invoice."id"
    )
),
legacy_invoice_decisions AS (
  SELECT
    CASE
      WHEN invoice."audienceIdentityId" IS NULL
        THEN 'LEGACY_INVOICE_WITHOUT_AUDIENCE_IDENTITY'
      WHEN invoice."telegramPaymentChargeId" IS NULL OR invoice."paidAt" IS NULL
        THEN 'LEGACY_INVOICE_WITHOUT_PAYMENT_EVIDENCE'
      ELSE 'LEGACY_INVOICE_PRICE_CATALOG_RETIRED'
    END::text AS issue_code,
    'invoice'::text AS entity_type,
    invoice."id" AS entity_key,
    jsonb_build_object(
      'representativeId', invoice."representativeId",
      'contactId', invoice."contactId",
      'conversationId', invoice."conversationId",
      'audienceIdentityId', invoice."audienceIdentityId",
      'planType', invoice."planType",
      'title', invoice."title",
      'starsAmount', invoice."starsAmount",
      'status', invoice."status",
      'telegramPaymentChargeId', invoice."telegramPaymentChargeId",
      'paidAt', invoice."paidAt",
      'refundedAt', invoice."refundedAt",
      'pricingMatchCount', invoice.pricing_match_count,
      'includedReplies', invoice.included_replies,
      'legacyPassUnlockedAt', invoice."passUnlockedAt",
      'legacyDeepHelpUnlockedAt', invoice."deepHelpUnlockedAt",
      'reason',
        'The mutable four-tier catalog is retired; use the immutable invoice facts for manual historical reconciliation.'
    ) AS details
  FROM invoice_reconciliation AS invoice
),
legacy_pending_invoices AS (
  SELECT
    'LEGACY_PENDING_INVOICE_REISSUE_REQUIRED'::text AS issue_code,
    'invoice'::text AS entity_type,
    invoice."id" AS entity_key,
    jsonb_build_object(
      'representativeId', invoice."representativeId",
      'contactId', invoice."contactId",
      'conversationId', invoice."conversationId",
      'audienceIdentityId', contact."audienceIdentityId",
      'planType', invoice."planType",
      'starsAmount', invoice."starsAmount",
      'payload', invoice."payload",
      'reason',
        'The provider account is not recoverable from the legacy invoice; cancel and reissue it through the active Telegram connection.'
    ) AS details
  FROM "Invoice" AS invoice
  INNER JOIN "Contact" AS contact ON contact."id" = invoice."contactId"
  WHERE invoice."planType" <> 'SPONSOR'::"PricingPlanType"
    AND invoice."status" = 'PENDING'::"InvoiceStatus"
    AND NOT EXISTS (
      SELECT 1
      FROM "ServicePaymentOrder" AS payment_order
      WHERE payment_order."id" = 'service-payment:' || invoice."id"
    )
),
invoice_payment_order_mismatches AS (
  SELECT
    'INVOICE_SERVICE_PAYMENT_ORDER_MISMATCH'::text AS issue_code,
    'service_payment_order'::text AS entity_type,
    payment_order."id" AS entity_key,
    jsonb_build_object(
      'invoiceId', invoice."id",
      'invoiceRepresentativeId', invoice."representativeId",
      'orderRepresentativeId', payment_order."representativeId",
      'contactAudienceIdentityId', contact."audienceIdentityId",
      'payerAudienceIdentityId', payment_order."payerAudienceIdentityId",
      'invoicePayload', invoice."payload",
      'providerOrderId', payment_order."providerOrderId",
      'invoiceStarsAmount', invoice."starsAmount",
      'orderAmountMinor', payment_order."amountMinor",
      'orderCurrency', payment_order."currency",
      'orderProvider', payment_order."provider",
      'expectedProductCode', 'plan:' || lower(invoice."planType"::text),
      'actualProductCode', payment_order."productCode"
    ) AS details
  FROM "Invoice" AS invoice
  INNER JOIN "Contact" AS contact ON contact."id" = invoice."contactId"
  INNER JOIN "ServicePaymentOrder" AS payment_order
    ON payment_order."id" = 'service-payment:' || invoice."id"
  WHERE invoice."planType" <> 'SPONSOR'::"PricingPlanType"
    AND (
      payment_order."provider" <> 'TELEGRAM_STARS'::"PaymentProvider"
      OR upper(payment_order."currency") <> 'XTR'
      OR payment_order."amountMinor" <> invoice."starsAmount"
      OR payment_order."representativeId" <> invoice."representativeId"
      OR payment_order."payerAudienceIdentityId"
        IS DISTINCT FROM contact."audienceIdentityId"
      OR payment_order."providerOrderId" IS DISTINCT FROM invoice."payload"
      OR payment_order."productCode"
        <> 'plan:' || lower(invoice."planType"::text)
    )
),
payment_order_invariant_issues AS (
  SELECT
    'PAID_SERVICE_ORDER_WITHOUT_ENTITLEMENT_LEDGER'::text AS issue_code,
    'service_payment_order'::text AS entity_type,
    payment_order."id" AS entity_key,
    jsonb_build_object(
      'status', payment_order."status",
      'payerAudienceIdentityId', payment_order."payerAudienceIdentityId",
      'representativeId', payment_order."representativeId",
      'productCode', payment_order."productCode",
      'fulfillmentKey', payment_order."fulfillmentKey"
    ) AS details
  FROM "ServicePaymentOrder" AS payment_order
  WHERE payment_order."status" IN (
      'PAID'::"RechargeOrderStatus",
      'REFUNDED'::"RechargeOrderStatus"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "ServiceEntitlementLedgerEntry" AS ledger
      WHERE ledger."paymentOrderId" = payment_order."id"
        AND ledger."kind" = 'GRANT'::"ServiceEntitlementLedgerKind"
    )
),
entitlement_balance_issues AS (
  SELECT
    'ENTITLEMENT_BALANCE_INVARIANT'::text AS issue_code,
    'service_entitlement_account'::text AS entity_type,
    account."id" AS entity_key,
    jsonb_build_object(
      'audienceIdentityId', account."audienceIdentityId",
      'representativeId', account."representativeId",
      'productCode', account."productCode",
      'grantedUnits', account."grantedUnits",
      'remainingUnits', account."remainingUnits",
      'reservedUnits', account."reservedUnits",
      'status', account."status"
    ) AS details
  FROM "ServiceEntitlementAccount" AS account
  WHERE account."grantedUnits" < 0
     OR account."remainingUnits" < 0
     OR account."reservedUnits" < 0
     OR account."remainingUnits" + account."reservedUnits" > account."grantedUnits"
)
SELECT issue.issue_code, issue.entity_type, issue.entity_key, issue.details
FROM (
  SELECT * FROM identity_conflicts
  UNION ALL SELECT * FROM unusable_telegram_links
  UNION ALL SELECT * FROM unusable_matrix_links
  UNION ALL SELECT * FROM matrix_issuer_issues
  UNION ALL SELECT * FROM telegram_issuer_issues
  UNION ALL SELECT * FROM wallet_without_provider_proof
  UNION ALL SELECT * FROM contact_link_mismatch
  UNION ALL SELECT * FROM conversation_identity_mismatch
  UNION ALL SELECT * FROM duplicate_channel_coordinates
  UNION ALL SELECT * FROM serialized_channel_key_collisions
  UNION ALL SELECT * FROM unkeyed_channel_bindings
  UNION ALL SELECT * FROM orphaned_channel_bindings
  UNION ALL SELECT * FROM channel_connection_issues
  UNION ALL SELECT * FROM ambiguous_wallet_ownership
  UNION ALL SELECT * FROM purchase_identity_issues
  UNION ALL SELECT * FROM unattributed_usage
  UNION ALL SELECT * FROM legacy_invoice_decisions
  UNION ALL SELECT * FROM legacy_pending_invoices
  UNION ALL SELECT * FROM invoice_payment_order_mismatches
  UNION ALL SELECT * FROM payment_order_invariant_issues
  UNION ALL SELECT * FROM entitlement_balance_issues
) AS issue
ORDER BY issue.issue_code, issue.entity_type, issue.entity_key;
