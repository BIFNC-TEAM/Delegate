BEGIN;

-- Provider timestamps are presentation data, not authorization clocks. A
-- PostgreSQL sequence gives every audience message one global, immutable
-- receive order so a contact-channel forget command can fence work across
-- multiple conversations and providers.
CREATE SEQUENCE "Message_memory_ingress_ordinal_seq" AS BIGINT;

ALTER TABLE "Message"
  ADD COLUMN "memoryIngressOrdinal" BIGINT;

WITH ordered_message AS (
  SELECT message_record."id",
         row_number() OVER (
           ORDER BY message_record."createdAt", message_record."id"
         )::BIGINT AS ordinal
    FROM "Message" AS message_record
   WHERE message_record."senderType" = 'AUDIENCE'::"MessageSenderType"
)
UPDATE "Message" AS message_record
   SET "memoryIngressOrdinal" = ordered_message.ordinal
  FROM ordered_message
 WHERE message_record."id" = ordered_message."id";

SELECT setval(
  '"Message_memory_ingress_ordinal_seq"',
  COALESCE((SELECT MAX("memoryIngressOrdinal") FROM "Message"), 0) + 1,
  FALSE
);

CREATE UNIQUE INDEX "Message_memory_ingress_ordinal_key"
  ON "Message"("memoryIngressOrdinal");

CREATE OR REPLACE FUNCTION "assign_message_memory_ingress_ordinal"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."memoryIngressOrdinal" IS DISTINCT FROM OLD."memoryIngressOrdinal" THEN
      RAISE EXCEPTION
        'Message memory ingress ordinal is immutable.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."senderType" = 'AUDIENCE'::"MessageSenderType"
       AND NEW."memoryIngressOrdinal" IS NULL THEN
      RAISE EXCEPTION
        'Audience messages require a memory ingress ordinal.'
        USING ERRCODE = '23514';
    ELSIF NEW."senderType" <> 'AUDIENCE'::"MessageSenderType"
          AND NEW."memoryIngressOrdinal" IS NOT NULL THEN
      RAISE EXCEPTION
        'Message memory ingress ordinal is reserved for audience messages.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."senderType" = 'AUDIENCE'::"MessageSenderType" THEN
    IF NEW."memoryIngressOrdinal" IS NOT NULL THEN
      RAISE EXCEPTION
        'Message memory ingress ordinal is server assigned.'
        USING ERRCODE = '23514';
    END IF;
    NEW."memoryIngressOrdinal" := nextval('"Message_memory_ingress_ordinal_seq"');
  ELSIF NEW."memoryIngressOrdinal" IS NOT NULL THEN
    RAISE EXCEPTION
      'Message memory ingress ordinal is reserved for audience messages.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "00_Message_memory_ingress_ordinal_guard"
  BEFORE INSERT OR UPDATE OF "memoryIngressOrdinal", "senderType" ON "Message"
  FOR EACH ROW
  EXECUTE FUNCTION "assign_message_memory_ingress_ordinal"();

ALTER TABLE "MemoryExtractionRun"
  ADD COLUMN "contactChannelMemoryEpoch" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "MemoryExtractionRun"
  ADD CONSTRAINT "MemoryExtractionRun_contact_channel_epoch_check"
  CHECK ("contactChannelMemoryEpoch" >= 0);

CREATE OR REPLACE FUNCTION "protect_memory_extraction_forget_epoch"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."contactChannelMemoryEpoch"
       IS DISTINCT FROM OLD."contactChannelMemoryEpoch" THEN
    RAISE EXCEPTION
      'Memory extraction forget epoch is immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryExtractionRun_forget_epoch_immutable_guard"
  BEFORE UPDATE OF "contactChannelMemoryEpoch" ON "MemoryExtractionRun"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_memory_extraction_forget_epoch"();

-- One immutable, bodyless row is retained for every exact forget request,
-- including requests which matched zero materialized memories.
CREATE TABLE "ContactChannelMemoryForgetBoundary" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "epoch" INTEGER NOT NULL,
  "sourceConversationId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "cutoffMemoryIngressOrdinal" BIGINT NOT NULL,
  "cutoffIngressSequence" INTEGER,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactChannelMemoryForgetBoundary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactMemoryForgetBoundary_epoch_check" CHECK ("epoch" > 0),
  CONSTRAINT "ContactMemoryForgetBoundary_ordinal_check"
    CHECK ("cutoffMemoryIngressOrdinal" > 0),
  CONSTRAINT "ContactMemoryForgetBoundary_request_hash_check"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ContactMemoryForgetBoundary_channel_ingress_check" CHECK (
    ("sourceChannel" = 'WEB'::"RepresentativeChannelKind"
      AND "cutoffIngressSequence" IS NULL)
    OR
    ("sourceChannel" IN (
        'MATRIX'::"RepresentativeChannelKind",
        'TELEGRAM'::"RepresentativeChannelKind"
      )
      AND "cutoffIngressSequence" > 0)
  )
);

CREATE UNIQUE INDEX "ContactChannelMemoryForgetBoundary_sourceMessageId_key"
  ON "ContactChannelMemoryForgetBoundary"("sourceMessageId");
CREATE UNIQUE INDEX "ContactMemoryForgetBoundary_message_scope_key"
  ON "ContactChannelMemoryForgetBoundary"(
    "sourceMessageId", "sourceConversationId"
  );
CREATE UNIQUE INDEX "ContactChannelMemoryForgetBoundary_requestHash_key"
  ON "ContactChannelMemoryForgetBoundary"("requestHash");
CREATE UNIQUE INDEX "ContactMemoryForgetBoundary_scope_epoch_key"
  ON "ContactChannelMemoryForgetBoundary"(
    "representativeId", "contactId", "sourceChannel", "epoch"
  );
CREATE INDEX "ContactMemoryForgetBoundary_scope_created_idx"
  ON "ContactChannelMemoryForgetBoundary"(
    "representativeId", "contactId", "sourceChannel", "createdAt"
  );
CREATE INDEX "ContactMemoryForgetBoundary_conversation_ingress_idx"
  ON "ContactChannelMemoryForgetBoundary"(
    "sourceConversationId", "cutoffIngressSequence"
  );

ALTER TABLE "ContactChannelMemoryForgetBoundary"
  ADD CONSTRAINT "ContactMemoryForgetBoundary_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactChannelMemoryForgetBoundary"
  ADD CONSTRAINT "ContactMemoryForgetBoundary_contact_scope_fkey"
  FOREIGN KEY ("contactId", "representativeId")
  REFERENCES "Contact"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactChannelMemoryForgetBoundary"
  ADD CONSTRAINT "ContactMemoryForgetBoundary_message_scope_fkey"
  FOREIGN KEY ("sourceMessageId", "sourceConversationId")
  REFERENCES "Message"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_contact_channel_memory_forget_boundary"()
RETURNS TRIGGER AS $$
DECLARE
  source_record RECORD;
  expected_epoch INTEGER;
  latest_cutoff BIGINT;
  coordinate_lock_key TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Contact-channel memory forget proofs are immutable.'
      USING ERRCODE = '23514';
  END IF;

  coordinate_lock_key := concat_ws(
    ':',
    'contact-channel-memory',
    NEW."representativeId",
    NEW."contactId",
    NEW."sourceChannel"::TEXT
  );
  PERFORM pg_advisory_xact_lock(hashtext(coordinate_lock_key));

  SELECT message_record."senderType",
         message_record."contentType",
         message_record."text",
         message_record."ingressSequence",
         message_record."memoryIngressOrdinal",
         conversation_record."representativeId",
         conversation_record."contactId",
         upper(btrim(COALESCE(conversation_record."sourceChannel", ''))) AS channel
    INTO source_record
    FROM "Message" AS message_record
    JOIN "Conversation" AS conversation_record
      ON conversation_record."id" = message_record."conversationId"
   WHERE message_record."id" = NEW."sourceMessageId"
     AND message_record."conversationId" = NEW."sourceConversationId"
   FOR SHARE OF message_record, conversation_record;

  IF source_record IS NULL
     OR source_record."senderType" <> 'AUDIENCE'::"MessageSenderType"
     OR source_record."contentType" <> 'TEXT'::"MessageContentType"
     OR regexp_replace(
       lower(btrim(regexp_replace(
         normalize(COALESCE(source_record."text", ''), NFKC),
         '[[:blank:]]+',
         ' ',
         'g'
       ))),
       '[。.!！?？]+[[:space:]]*$',
       ''
     ) NOT IN (
       '/delete_memory',
       '/forget',
       'delete my memory',
       'forget my memory',
       '删除我的记忆'
     )
     OR source_record."representativeId" <> NEW."representativeId"
     OR source_record."contactId" <> NEW."contactId"
     OR source_record.channel <> NEW."sourceChannel"::TEXT
     OR source_record."memoryIngressOrdinal"
          IS DISTINCT FROM NEW."cutoffMemoryIngressOrdinal"
     OR source_record."ingressSequence"
          IS DISTINCT FROM NEW."cutoffIngressSequence" THEN
    RAISE EXCEPTION
      'Contact-channel memory forget boundary has invalid source coordinates.'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(boundary."epoch"), 0) + 1,
         MAX(boundary."cutoffMemoryIngressOrdinal")
    INTO expected_epoch, latest_cutoff
    FROM "ContactChannelMemoryForgetBoundary" AS boundary
   WHERE boundary."representativeId" = NEW."representativeId"
     AND boundary."contactId" = NEW."contactId"
     AND boundary."sourceChannel" = NEW."sourceChannel";
  IF NEW."epoch" <> expected_epoch THEN
    RAISE EXCEPTION
      'Contact-channel memory forget epoch is not the next scope epoch.'
      USING ERRCODE = '23514';
  END IF;
  IF latest_cutoff IS NOT NULL
     AND NEW."cutoffMemoryIngressOrdinal" <= latest_cutoff THEN
    RAISE EXCEPTION
      'Contact-channel memory forget cutoff must advance monotonically.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactChannelMemoryForgetBoundary_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ContactChannelMemoryForgetBoundary"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_contact_channel_memory_forget_boundary"();

-- A stale candidate can never reopen a contact memory after a forget request,
-- even if application code regresses. Representative experience already
-- active before the request is not revoked, but new activation from that
-- contact's pre-boundary evidence is forbidden.
CREATE OR REPLACE FUNCTION "governed_memory_forget_boundary_guard"()
RETURNS TRIGGER AS $$
DECLARE
  source_record RECORD;
  latest_boundary RECORD;
  coordinate_lock_key TEXT;
BEGIN
  IF NEW."status" <> 'ACTIVE'::"GovernedMemoryStatus"
     OR (
       TG_OP = 'UPDATE'
       AND OLD."status" = 'ACTIVE'::"GovernedMemoryStatus"
       AND OLD."currentVersionId" IS NOT DISTINCT FROM NEW."currentVersionId"
     ) THEN
    RETURN NEW;
  END IF;

  SELECT candidate."sourceContactId",
         candidate."originChannel",
         source_message."memoryIngressOrdinal",
         extraction_run."contactChannelMemoryEpoch"
    INTO source_record
    FROM "GovernedMemoryVersion" AS version_record
    JOIN "MemoryCandidate" AS candidate
      ON candidate."id" = version_record."sourceCandidateId"
     AND candidate."representativeId" = version_record."representativeId"
    JOIN "Message" AS source_message
      ON source_message."id" = candidate."sourceMessageId"
     AND source_message."conversationId" = candidate."sourceConversationId"
    LEFT JOIN "MemoryExtractionRun" AS extraction_run
      ON extraction_run."id" = candidate."extractionRunId"
     AND extraction_run."representativeId" = candidate."representativeId"
   WHERE version_record."id" = NEW."currentVersionId"
     AND version_record."memoryId" = NEW."id"
     AND version_record."representativeId" = NEW."representativeId";
  IF source_record IS NULL THEN
    RETURN NEW;
  END IF;

  coordinate_lock_key := concat_ws(
    ':',
    'contact-channel-memory',
    NEW."representativeId",
    source_record."sourceContactId",
    source_record."originChannel"::TEXT
  );
  PERFORM pg_advisory_xact_lock(hashtext(coordinate_lock_key));
  SELECT boundary."epoch", boundary."cutoffMemoryIngressOrdinal"
    INTO latest_boundary
    FROM "ContactChannelMemoryForgetBoundary" AS boundary
   WHERE boundary."representativeId" = NEW."representativeId"
     AND boundary."contactId" = source_record."sourceContactId"
     AND boundary."sourceChannel" = source_record."originChannel"
   ORDER BY boundary."epoch" DESC
   LIMIT 1;
  IF latest_boundary IS NOT NULL AND (
    COALESCE(source_record."contactChannelMemoryEpoch", 0)
      < latest_boundary."epoch"
    OR source_record."memoryIngressOrdinal" IS NULL
    OR source_record."memoryIngressOrdinal"
      <= latest_boundary."cutoffMemoryIngressOrdinal"
  ) THEN
    RAISE EXCEPTION
      'Pre-forget memory evidence cannot activate.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "00_GovernedMemory_forget_boundary_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW
  EXECUTE FUNCTION "governed_memory_forget_boundary_guard"();

-- Injection is the last durable Recall boundary. Acquire the same coordinate
-- lock as deletion, then reject both pre-forget source evidence and a question
-- that itself falls on or before the boundary.
CREATE OR REPLACE FUNCTION "memory_use_forget_boundary_guard"()
RETURNS TRIGGER AS $$
DECLARE
  use_record RECORD;
  source_record RECORD;
  latest_boundary RECORD;
  coordinate_lock_key TEXT;
BEGIN
  IF NEW."sourceKind" <> 'CONTACT_MEMORY'::"MemoryUseSourceKind"
     OR NEW."injectedAt" IS NULL
     OR OLD."injectedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT use_run."representativeId",
         use_run."contactId",
         use_run."sourceChannel",
         input_message."memoryIngressOrdinal" AS input_ordinal
    INTO use_record
    FROM "MemoryUseRun" AS use_run
    JOIN "Message" AS input_message
      ON input_message."id" = use_run."inputMessageId"
     AND input_message."conversationId" = use_run."conversationId"
   WHERE use_run."id" = NEW."useRunId"
     AND use_run."representativeId" = NEW."representativeId";
  SELECT source_message."memoryIngressOrdinal" AS source_ordinal,
         extraction_run."contactChannelMemoryEpoch" AS source_epoch
    INTO source_record
    FROM "GovernedMemoryVersion" AS version_record
    JOIN "MemoryCandidate" AS candidate
      ON candidate."id" = version_record."sourceCandidateId"
     AND candidate."representativeId" = version_record."representativeId"
    JOIN "Message" AS source_message
      ON source_message."id" = candidate."sourceMessageId"
     AND source_message."conversationId" = candidate."sourceConversationId"
    LEFT JOIN "MemoryExtractionRun" AS extraction_run
      ON extraction_run."id" = candidate."extractionRunId"
     AND extraction_run."representativeId" = candidate."representativeId"
   WHERE version_record."id" = NEW."memoryVersionId"
     AND version_record."representativeId" = NEW."representativeId";
  IF use_record IS NULL OR source_record IS NULL THEN
    RETURN NEW;
  END IF;

  coordinate_lock_key := concat_ws(
    ':',
    'contact-channel-memory',
    use_record."representativeId",
    use_record."contactId",
    use_record."sourceChannel"::TEXT
  );
  PERFORM pg_advisory_xact_lock(hashtext(coordinate_lock_key));
  SELECT boundary."epoch", boundary."cutoffMemoryIngressOrdinal"
    INTO latest_boundary
    FROM "ContactChannelMemoryForgetBoundary" AS boundary
   WHERE boundary."representativeId" = use_record."representativeId"
     AND boundary."contactId" = use_record."contactId"
     AND boundary."sourceChannel" = use_record."sourceChannel"
   ORDER BY boundary."epoch" DESC
   LIMIT 1;
  IF latest_boundary IS NOT NULL AND (
    COALESCE(source_record.source_epoch, 0) < latest_boundary."epoch"
    OR source_record.source_ordinal IS NULL
    OR source_record.source_ordinal
      <= latest_boundary."cutoffMemoryIngressOrdinal"
    OR use_record.input_ordinal IS NULL
    OR use_record.input_ordinal
      <= latest_boundary."cutoffMemoryIngressOrdinal"
  ) THEN
    RAISE EXCEPTION
      'Contact memory cannot be injected across a forget boundary.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "00_MemoryUseItem_forget_boundary_guard"
  BEFORE UPDATE OF "injectedAt" ON "MemoryUseItem"
  FOR EACH ROW
  EXECUTE FUNCTION "memory_use_forget_boundary_guard"();

COMMIT;
