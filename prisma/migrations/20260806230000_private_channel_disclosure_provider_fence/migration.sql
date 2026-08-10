BEGIN;

-- Every provider event observed before one disclosure becomes durable is an
-- immutable exclusion. This closes the race where two Matrix AS transactions
-- arrive concurrently and the transaction that triggered the notice is
-- persisted after another event with a later provider timestamp.
CREATE TABLE "MemoryChannelDisclosureExcludedInbound" (
  "deliveryId" TEXT NOT NULL,
  "externalInboundMessageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryDisclosureExcludedInbound_pkey"
    PRIMARY KEY ("deliveryId", "externalInboundMessageId"),
  CONSTRAINT "MemoryDisclosureExcludedInbound_message_check"
    CHECK (
      btrim("externalInboundMessageId") <> ''
      AND length("externalInboundMessageId") <= 512
    )
);

CREATE INDEX "MemoryDisclosureExcludedInbound_message_idx"
  ON "MemoryChannelDisclosureExcludedInbound"("externalInboundMessageId");

ALTER TABLE "MemoryChannelDisclosureExcludedInbound"
  ADD CONSTRAINT "MemoryDisclosureExcludedInbound_delivery_fkey"
  FOREIGN KEY ("deliveryId")
  REFERENCES "MemoryChannelDisclosureDelivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_memory_disclosure_excluded_inbound"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Memory disclosure provider-event exclusions are immutable.'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryDisclosureExcludedInbound_immutable_guard"
  BEFORE UPDATE ON "MemoryChannelDisclosureExcludedInbound"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_memory_disclosure_excluded_inbound"();

-- Exact-message authorization requires both the database receive-order proof
-- and absence from the provider-ID exclusion set. The latter is decisive when
-- concurrent provider deliveries are persisted out of arrival order.
CREATE OR REPLACE FUNCTION "memory_private_channel_disclosure_allows"(
  representative_id TEXT,
  contact_id TEXT,
  conversation_id TEXT,
  input_message_id TEXT,
  source_channel "RepresentativeChannelKind",
  policy_revision INTEGER,
  disclosure_contract_version TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  IF source_channel NOT IN (
       'MATRIX'::"RepresentativeChannelKind",
       'TELEGRAM'::"RepresentativeChannelKind"
     )
     OR policy_revision < 0
     OR disclosure_contract_version IS NULL
     OR btrim(disclosure_contract_version) = '' THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM "Message" AS input_message
      JOIN "ConversationChannelBinding" AS binding
        ON binding."id" = input_message."channelBindingId"
       AND binding."conversationId" = input_message."conversationId"
       AND binding."kind" = source_channel
      JOIN "MemoryChannelDisclosureDelivery" AS disclosure
        ON disclosure."representativeId" = representative_id
       AND disclosure."contactId" = contact_id
       AND disclosure."conversationId" = conversation_id
       AND disclosure."channelBindingId" = binding."id"
       AND disclosure."sourceChannel" = source_channel
       AND disclosure."policyRevision" = policy_revision
       AND disclosure."disclosureContractVersion" = disclosure_contract_version
       AND disclosure."representativeAssignmentRevision"
             IS NOT DISTINCT FROM binding."representativeAssignmentRevision"
       AND disclosure."connectionId" IS NOT DISTINCT FROM binding."connectionId"
       AND disclosure."status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
       AND disclosure."deliveredAfterIngressSequence" IS NOT NULL
       AND disclosure."externalMessageId" IS NOT NULL
       AND disclosure."proofHash" ~ '^[0-9a-f]{64}$'
      JOIN "MemoryChannelDisclosureActivation" AS activation
        ON activation."deliveryId" = disclosure."id"
       AND activation."firstExcludedIngressSequence"
             = disclosure."deliveredAfterIngressSequence" + 1
      JOIN "Message" AS boundary_message
        ON boundary_message."id" = activation."firstExcludedMessageId"
       AND boundary_message."conversationId" = conversation_id
       AND boundary_message."channelBindingId" = binding."id"
       AND boundary_message."ingressSequence"
             = activation."firstExcludedIngressSequence"
       AND boundary_message."senderType" = 'AUDIENCE'::"MessageSenderType"
     WHERE input_message."id" = input_message_id
       AND input_message."conversationId" = conversation_id
       AND input_message."senderType" = 'AUDIENCE'::"MessageSenderType"
       AND input_message."externalMessageId" IS NOT NULL
       AND input_message."ingressSequence" IS NOT NULL
       AND input_message."ingressSequence"
             > activation."firstExcludedIngressSequence"
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryChannelDisclosureExcludedInbound" AS excluded
          WHERE excluded."deliveryId" = disclosure."id"
            AND excluded."externalInboundMessageId"
                  = input_message."externalMessageId"
       )
       AND (
         (source_channel = 'MATRIX'::"RepresentativeChannelKind"
          AND disclosure."evidenceKind" = 'MATRIX_MESSAGE'::"MemoryDisclosureEvidenceKind")
         OR
         (source_channel = 'TELEGRAM'::"RepresentativeChannelKind"
          AND disclosure."evidenceKind" = 'TELEGRAM_MESSAGE'::"MemoryDisclosureEvidenceKind")
       )
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
