BEGIN;

-- Telegram may redeliver or reorder edited_message updates around process
-- crashes and lease handoffs. Persist the provider ordering watermark on the
-- authoritative Message row so the text mutation and ordering decision share
-- one PostgreSQL transaction. update_id is the sole ordering authority;
-- telegramLastEditAt is retained only as provider audit metadata.
ALTER TABLE "Message"
  ADD COLUMN "telegramLastEditAt" TIMESTAMP(3),
  ADD COLUMN "telegramLastEditUpdateId" BIGINT;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_telegram_edit_watermark_pair_check" CHECK (
    (
      "telegramLastEditAt" IS NULL
      AND "telegramLastEditUpdateId" IS NULL
    ) OR (
      "telegramLastEditAt" IS NOT NULL
      AND "telegramLastEditUpdateId" IS NOT NULL
      AND "telegramLastEditUpdateId" >= 0
    )
  );

CREATE OR REPLACE FUNCTION "protect_telegram_message_edit_watermark"()
RETURNS TRIGGER AS $$
DECLARE
  binding_kind "RepresentativeChannelKind";
BEGIN
  IF NEW."telegramLastEditAt" IS NULL
     AND NEW."telegramLastEditUpdateId" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND (
         OLD."telegramLastEditAt" IS NOT NULL
         OR OLD."telegramLastEditUpdateId" IS NOT NULL
       ) THEN
      RAISE EXCEPTION
        'Telegram message edit watermark cannot be cleared.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."telegramLastEditAt" IS NULL
     OR NEW."telegramLastEditUpdateId" IS NULL
     OR NEW."telegramLastEditUpdateId" < 0 THEN
    RAISE EXCEPTION
      'Telegram message edit watermark is incomplete.'
      USING ERRCODE = '23514';
  END IF;

  SELECT binding."kind" INTO binding_kind
    FROM "ConversationChannelBinding" AS binding
   WHERE binding."id" = NEW."channelBindingId"
     AND binding."conversationId" = NEW."conversationId";

  IF NEW."senderType" <> 'AUDIENCE'::"MessageSenderType"
     OR binding_kind IS DISTINCT FROM 'TELEGRAM'::"RepresentativeChannelKind" THEN
    RAISE EXCEPTION
      'Telegram edit watermark is outside a Telegram audience message.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."telegramLastEditAt" IS NOT NULL
     AND OLD."telegramLastEditUpdateId" IS NOT NULL
     AND NEW."telegramLastEditUpdateId"
           <= OLD."telegramLastEditUpdateId" THEN
    RAISE EXCEPTION
      'Telegram message edit watermark must increase.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_telegram_edit_watermark_guard"
  BEFORE INSERT OR UPDATE OF
    "telegramLastEditAt",
    "telegramLastEditUpdateId"
  ON "Message"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_telegram_message_edit_watermark"();

-- ChannelEventInbox is shared by several transports. These nullable fields
-- add owner-fenced leases without changing existing Matrix/payment rows.
ALTER TABLE "ChannelEventInbox"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "ChannelEventInbox"
  ADD CONSTRAINT "ChannelEventInbox_lease_pair_check" CHECK (
    (
      "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
    ) OR (
      "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "ChannelEventInbox_leaseToken_key"
  ON "ChannelEventInbox"("leaseToken");

CREATE INDEX "ChannelEventInbox_channel_event_due_lease_idx"
  ON "ChannelEventInbox"(
    "kind",
    "connectionId",
    "eventType",
    "status",
    "availableAt",
    "leaseExpiresAt"
  );

COMMIT;
