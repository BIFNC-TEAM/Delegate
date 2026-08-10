-- Message.ingressSequence is allocated per conversation, not per channel
-- binding. Stamp the disclosure completion floor from that same authoritative
-- coordinate so a binding-epoch change cannot create an unfillable sequence
-- gap and permanently prevent activation.
CREATE OR REPLACE FUNCTION "stamp_memory_disclosure_ingress_floor"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
     AND NEW."status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus" THEN
    SELECT COALESCE(MAX(message_record."ingressSequence"), 0)
      INTO NEW."deliveredAfterIngressSequence"
      FROM "Message" AS message_record
     WHERE message_record."conversationId" = NEW."conversationId"
       AND message_record."senderType" = 'AUDIENCE'::"MessageSenderType"
       AND message_record."ingressSequence" IS NOT NULL;
  ELSIF NEW."deliveredAfterIngressSequence"
           IS DISTINCT FROM OLD."deliveredAfterIngressSequence" THEN
    RAISE EXCEPTION
      'Disclosure ingress floor is server assigned and immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
