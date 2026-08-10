BEGIN;

-- Provider timestamps are useful presentation metadata but are not a safe
-- authorization clock. Private-channel audience messages therefore receive a
-- monotonic, per-conversation sequence inside PostgreSQL while holding the
-- same advisory lock used by the conversation write path.
ALTER TABLE "Message"
  ADD COLUMN "ingressSequence" INTEGER;

CREATE UNIQUE INDEX "Message_conversation_ingress_sequence_key"
  ON "Message"("conversationId", "ingressSequence");

CREATE OR REPLACE FUNCTION "assign_private_channel_message_ingress_sequence"()
RETURNS TRIGGER AS $$
DECLARE
  binding_kind "RepresentativeChannelKind";
  next_sequence BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ingressSequence" IS DISTINCT FROM OLD."ingressSequence" THEN
      RAISE EXCEPTION
        'Message ingress sequence is immutable.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT binding."kind" INTO binding_kind
    FROM "ConversationChannelBinding" AS binding
   WHERE binding."id" = NEW."channelBindingId"
     AND binding."conversationId" = NEW."conversationId";

  IF NEW."senderType" = 'AUDIENCE'::"MessageSenderType"
     AND binding_kind IN (
       'MATRIX'::"RepresentativeChannelKind",
       'TELEGRAM'::"RepresentativeChannelKind"
     ) THEN
    IF NEW."ingressSequence" IS NOT NULL THEN
      RAISE EXCEPTION
        'Private-channel message ingress sequence is server assigned.'
        USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext(NEW."conversationId"));
    SELECT COALESCE(MAX(message_record."ingressSequence")::BIGINT, 0) + 1
      INTO next_sequence
      FROM "Message" AS message_record
     WHERE message_record."conversationId" = NEW."conversationId";
    IF next_sequence <= 0 OR next_sequence > 2147483647 THEN
      RAISE EXCEPTION
        'Private-channel message ingress sequence exhausted.'
        USING ERRCODE = '22003';
    END IF;
    NEW."ingressSequence" := next_sequence;
  ELSIF NEW."ingressSequence" IS NOT NULL THEN
    RAISE EXCEPTION
      'Ingress sequence is reserved for private-channel audience messages.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_private_channel_ingress_sequence_guard"
  BEFORE INSERT OR UPDATE OF "ingressSequence" ON "Message"
  FOR EACH ROW
  EXECUTE FUNCTION "assign_private_channel_message_ingress_sequence"();

-- When provider delivery becomes durable, snapshot the highest already-seen
-- server sequence. The next sequence is the immutable exclusion boundary.
ALTER TABLE "MemoryChannelDisclosureDelivery"
  ADD COLUMN "deliveredAfterIngressSequence" INTEGER;

CREATE OR REPLACE FUNCTION "stamp_memory_disclosure_ingress_floor"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
     AND NEW."status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus" THEN
    SELECT COALESCE(MAX(message_record."ingressSequence"), 0)
      INTO NEW."deliveredAfterIngressSequence"
      FROM "Message" AS message_record
     WHERE message_record."conversationId" = NEW."conversationId"
       AND message_record."channelBindingId" = NEW."channelBindingId";
  ELSIF NEW."deliveredAfterIngressSequence"
           IS DISTINCT FROM OLD."deliveredAfterIngressSequence" THEN
    RAISE EXCEPTION
      'Disclosure ingress floor is server assigned and immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "00_MemoryChannelDisclosureDelivery_ingress_floor"
  BEFORE UPDATE ON "MemoryChannelDisclosureDelivery"
  FOR EACH ROW
  EXECUTE FUNCTION "stamp_memory_disclosure_ingress_floor"();

-- The previous migration is already deployed. Backfill its delivered proofs
-- without rewriting any immutable provider evidence. Historical messages have
-- no ingress sequence, so zero correctly makes the next received message the
-- first excluded boundary.
ALTER TABLE "MemoryChannelDisclosureDelivery"
  DISABLE TRIGGER "MemoryChannelDisclosureDelivery_immutable_delivered_guard";
ALTER TABLE "MemoryChannelDisclosureDelivery"
  DISABLE TRIGGER "00_MemoryChannelDisclosureDelivery_ingress_floor";
UPDATE "MemoryChannelDisclosureDelivery"
   SET "deliveredAfterIngressSequence" = 0
 WHERE "status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
   AND "deliveredAfterIngressSequence" IS NULL;
ALTER TABLE "MemoryChannelDisclosureDelivery"
  ENABLE TRIGGER "00_MemoryChannelDisclosureDelivery_ingress_floor";
ALTER TABLE "MemoryChannelDisclosureDelivery"
  ENABLE TRIGGER "MemoryChannelDisclosureDelivery_immutable_delivered_guard";

ALTER TABLE "MemoryChannelDisclosureDelivery"
  ADD CONSTRAINT "MemoryDisclosureDelivery_ingress_floor_check" CHECK (
    ("status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
      AND "deliveredAfterIngressSequence" IS NOT NULL
      AND "deliveredAfterIngressSequence" >= 0)
    OR
    ("status" <> 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
      AND "deliveredAfterIngressSequence" IS NULL)
  );

CREATE TABLE "MemoryChannelDisclosureActivation" (
  "deliveryId" TEXT NOT NULL,
  "firstExcludedMessageId" TEXT NOT NULL,
  "firstExcludedIngressSequence" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryChannelDisclosureActivation_pkey"
    PRIMARY KEY ("deliveryId"),
  CONSTRAINT "MemoryDisclosureActivation_ingress_check"
    CHECK ("firstExcludedIngressSequence" > 0)
);

CREATE UNIQUE INDEX "MemoryChannelDisclosureActivation_firstExcludedMessageId_key"
  ON "MemoryChannelDisclosureActivation"("firstExcludedMessageId");
CREATE INDEX "MemoryDisclosureActivation_ingress_idx"
  ON "MemoryChannelDisclosureActivation"("firstExcludedIngressSequence");

ALTER TABLE "MemoryChannelDisclosureActivation"
  ADD CONSTRAINT "MemoryDisclosureActivation_delivery_fkey"
  FOREIGN KEY ("deliveryId")
  REFERENCES "MemoryChannelDisclosureDelivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryChannelDisclosureActivation"
  ADD CONSTRAINT "MemoryDisclosureActivation_message_fkey"
  FOREIGN KEY ("firstExcludedMessageId")
  REFERENCES "Message"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_memory_disclosure_activation"()
RETURNS TRIGGER AS $$
DECLARE
  disclosure_record "MemoryChannelDisclosureDelivery"%ROWTYPE;
  message_record "Message"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Memory disclosure activation proofs are immutable.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO disclosure_record
    FROM "MemoryChannelDisclosureDelivery"
   WHERE "id" = NEW."deliveryId";
  SELECT * INTO message_record
    FROM "Message"
   WHERE "id" = NEW."firstExcludedMessageId";
  IF disclosure_record."id" IS NULL
     OR disclosure_record."status" <> 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
     OR disclosure_record."deliveredAfterIngressSequence" IS NULL
     OR message_record."id" IS NULL
     OR message_record."senderType" <> 'AUDIENCE'::"MessageSenderType"
     OR message_record."conversationId" <> disclosure_record."conversationId"
     OR message_record."channelBindingId" IS DISTINCT FROM disclosure_record."channelBindingId"
     OR message_record."ingressSequence" IS NULL
     OR message_record."ingressSequence" <> NEW."firstExcludedIngressSequence"
     OR NEW."firstExcludedIngressSequence"
          <> disclosure_record."deliveredAfterIngressSequence" + 1 THEN
    RAISE EXCEPTION
      'Memory disclosure activation boundary is outside its delivered scope.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryDisclosureActivation_scope_guard"
  BEFORE INSERT OR UPDATE ON "MemoryChannelDisclosureActivation"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_memory_disclosure_activation"();

-- Exact-message authorization now compares only one PostgreSQL-assigned
-- receive order and an immutable first-message exclusion proof.
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
       AND input_message."ingressSequence" IS NOT NULL
       AND input_message."ingressSequence"
             > activation."firstExcludedIngressSequence"
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

-- Projection restoration is a scope-level operation. It requires the current
-- policy disclosure and its first-message boundary, but does not require an
-- old source message to occur after a newly delivered policy revision.
CREATE OR REPLACE FUNCTION "memory_private_channel_disclosure_scope_allows"(
  representative_id TEXT,
  contact_id TEXT,
  conversation_id TEXT,
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
      FROM "Conversation" AS conversation_record
      JOIN "ConversationChannelBinding" AS binding
        ON binding."conversationId" = conversation_record."id"
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
     WHERE conversation_record."id" = conversation_id
       AND conversation_record."representativeId" = representative_id
       AND conversation_record."contactId" = contact_id
       AND lower(conversation_record."sourceChannel") = lower(source_channel::TEXT)
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

CREATE OR REPLACE FUNCTION "memory_projection_policy_reenable_allowed"(
  old_record "MemoryProjectionItem",
  new_record "MemoryProjectionItem"
) RETURNS BOOLEAN AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  candidate_record "MemoryCandidate"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
BEGIN
  IF old_record."status" NOT IN ('DELETE_PENDING', 'DELETE_FAILED', 'DELETED')
     OR new_record."status" <> 'QUEUED'::"MemoryProjectionStatus" THEN
    RETURN FALSE;
  END IF;
  SELECT * INTO version_record
    FROM "GovernedMemoryVersion"
   WHERE "id" = new_record."memoryVersionId"
     AND "memoryId" = new_record."memoryId"
     AND "representativeId" = new_record."representativeId";
  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = new_record."memoryId"
     AND "representativeId" = new_record."representativeId";
  SELECT * INTO candidate_record
    FROM "MemoryCandidate"
   WHERE "id" = version_record."sourceCandidateId"
     AND "representativeId" = new_record."representativeId";
  SELECT * INTO policy_record
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = new_record."representativeId";
  RETURN
    old_record."lane" = 'RECALL'::"MemoryProjectionLane"
    AND old_record."deleteRequestedAt" IS NOT NULL
    AND new_record."lane" = old_record."lane"
    AND new_record."provider" = old_record."provider"
    AND new_record."memoryId" = old_record."memoryId"
    AND new_record."memoryVersionId" = old_record."memoryVersionId"
    AND new_record."contentHash" = old_record."contentHash"
    AND new_record."remoteObjectId" IS NULL
    AND new_record."writeReceiptHash" IS NULL
    AND new_record."writeVerifiedAt" IS NULL
    AND new_record."deleteReceiptHash" IS NULL
    AND new_record."remoteAbsentAt" IS NULL
    AND new_record."attemptCount" = 0
    AND new_record."leaseToken" IS NULL
    AND new_record."leaseExpiresAt" IS NULL
    AND new_record."projectedAt" IS NULL
    AND new_record."deleteRequestedAt" IS NULL
    AND new_record."deletedAt" IS NULL
    AND new_record."lastErrorCode" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "MemoryDeletionProof"
       WHERE "memoryId" = new_record."memoryId"
         AND "representativeId" = new_record."representativeId"
    )
    AND version_record."id" IS NOT NULL
    AND version_record."purgedAt" IS NULL
    AND version_record."safeText" IS NOT NULL
    AND version_record."contentHash" = new_record."contentHash"
    AND memory_record."id" IS NOT NULL
    AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
    AND memory_record."recallDisabledAt" IS NULL
    AND memory_record."currentVersionId" = new_record."memoryVersionId"
    AND (memory_record."expiresAt" IS NULL OR memory_record."expiresAt" > CURRENT_TIMESTAMP)
    AND policy_record."representativeId" IS NOT NULL
    AND policy_record."provider" = new_record."provider"
    AND policy_record."longTermMemoryEnabled"
    AND (
      (
        memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
        AND memory_record."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
        AND policy_record."contactMemoryEnabled"
        AND policy_record."webRecallEnabled"
      ) OR (
        memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
        AND memory_record."sourceChannel" IN (
          'MATRIX'::"RepresentativeChannelKind",
          'TELEGRAM'::"RepresentativeChannelKind"
        )
        AND policy_record."contactMemoryEnabled"
        AND candidate_record."id" IS NOT NULL
        AND candidate_record."contactId" IS NOT DISTINCT FROM memory_record."contactId"
        AND candidate_record."sourceContactId" IS NOT DISTINCT FROM memory_record."contactId"
        AND candidate_record."scopeChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"
        AND candidate_record."originChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"
        AND (
          (
            memory_record."sourceChannel" = 'MATRIX'::"RepresentativeChannelKind"
            AND policy_record."matrixRecallEnabled"
          ) OR (
            memory_record."sourceChannel" = 'TELEGRAM'::"RepresentativeChannelKind"
            AND policy_record."telegramRecallEnabled"
          )
        )
        AND "memory_private_channel_disclosure_scope_allows"(
          new_record."representativeId",
          candidate_record."sourceContactId",
          candidate_record."sourceConversationId",
          memory_record."sourceChannel",
          policy_record."revision",
          'private-channel-memory-v1'
        )
      ) OR (
        memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
        AND policy_record."representativeExperienceEnabled"
      )
    );
END;
$$ LANGUAGE plpgsql;

COMMIT;
