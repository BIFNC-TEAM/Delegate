-- Forward-only repair after 1300 was deployed: align the inherited private
-- disclosure calls with v2 and require immutable exact ingress provenance at
-- the shared Contact Memory use-ledger boundary.

BEGIN;

DO $disclosure_contract_repair$
DECLARE
  guard_definition TEXT;
  obsolete_literal TEXT := 'private-channel-memory-v1';
  current_literal TEXT := 'private-channel-memory-v2';
  obsolete_count INTEGER;
BEGIN
  SELECT pg_get_functiondef('"memory_use_item_scope_guard"()'::regprocedure)
    INTO guard_definition;
  obsolete_count := (
    length(guard_definition)
      - length(replace(guard_definition, obsolete_literal, ''))
  ) / length(obsolete_literal);
  IF guard_definition IS NULL OR obsolete_count <> 2 THEN
    RAISE EXCEPTION
      'Expected exactly two obsolete private-channel disclosure literals in memory_use_item_scope_guard, found %.',
      COALESCE(obsolete_count, -1);
  END IF;
  EXECUTE replace(guard_definition, obsolete_literal, current_literal);
END;
$disclosure_contract_repair$;

CREATE OR REPLACE FUNCTION "memory_use_item_shared_exact_source_guard"()
RETURNS TRIGGER AS $$
DECLARE
  guarded_memory "GovernedMemory"%ROWTYPE;
BEGIN
  IF NEW."sourceKind" <> 'CONTACT_MEMORY'::"MemoryUseSourceKind"
     OR NEW."memoryScope" <> 'CONTACT_SHARED'::"MemoryScope" THEN
    RETURN NEW;
  END IF;

  SELECT memory_record.* INTO guarded_memory
    FROM "GovernedMemoryVersion" version_record
    JOIN "GovernedMemory" memory_record
      ON memory_record."id" = version_record."memoryId"
     AND memory_record."representativeId"
           = version_record."representativeId"
   WHERE version_record."id" = NEW."memoryVersionId"
     AND version_record."representativeId" = NEW."representativeId";
  IF guarded_memory."id" IS NULL
     OR guarded_memory."scope" <> 'CONTACT_SHARED'::"MemoryScope"
     OR guarded_memory."audienceIdentityId" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_exact_source_check',
      MESSAGE = 'shared contact memory use lacks an exact shared-memory source';
  END IF;

  -- The use-run input message is the immutable ingress authority. A current
  -- verified IdentityLink (and for Matrix/Telegram its exact connection proof)
  -- must still identify the same canonical audience as the shared memory.
  PERFORM 1
    FROM "MemoryUseRun" guarded_run
    JOIN "Message" guarded_message
      ON guarded_message."id" = guarded_run."inputMessageId"
     AND guarded_message."conversationId" = guarded_run."conversationId"
    JOIN "IdentityLink" guarded_link
      ON guarded_link."id" = guarded_message."sourceIdentityLinkId"
    LEFT JOIN "IdentityLinkConnectionProof" guarded_proof
      ON guarded_proof."id"
           = guarded_message."sourceIdentityConnectionProofId"
     AND guarded_proof."identityLinkId" = guarded_link."id"
    LEFT JOIN "ConversationChannelBinding" guarded_binding
      ON guarded_binding."id" = guarded_message."channelBindingId"
     AND guarded_binding."conversationId" = guarded_run."conversationId"
   WHERE guarded_run."id" = NEW."useRunId"
     AND guarded_run."representativeId" = NEW."representativeId"
     AND guarded_link."audienceIdentityId"
           = guarded_memory."audienceIdentityId"
     AND guarded_link."verifiedAt" IS NOT NULL
     AND guarded_link."revokedAt" IS NULL
     AND guarded_link."assuranceLevel" IN (
       'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
       'STEP_UP_VERIFIED'::"IdentityAssuranceLevel"
     )
     AND (
       (
         guarded_run."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
         AND guarded_link."provider" = 'LOGTO'::"IdentityLinkProvider"
         AND guarded_message."sourceIdentityConnectionProofId" IS NULL
       ) OR (
         guarded_run."sourceChannel" IN (
           'MATRIX'::"RepresentativeChannelKind",
           'TELEGRAM'::"RepresentativeChannelKind"
         )
         AND guarded_link."provider" = CASE guarded_run."sourceChannel"
           WHEN 'MATRIX'::"RepresentativeChannelKind"
             THEN 'MATRIX'::"IdentityLinkProvider"
           ELSE 'TELEGRAM'::"IdentityLinkProvider"
         END
         AND guarded_message."senderId" = guarded_link."providerSubject"
         AND guarded_proof."id" IS NOT NULL
         AND guarded_proof."verifiedAt" IS NOT NULL
         AND guarded_proof."revokedAt" IS NULL
         AND guarded_proof."assuranceLevel" IN (
           'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
           'STEP_UP_VERIFIED'::"IdentityAssuranceLevel"
         )
         AND guarded_proof."issuer" = guarded_link."issuer"
         AND guarded_binding."kind" = guarded_run."sourceChannel"
         AND guarded_binding."connectionId" = guarded_proof."connectionId"
       )
     )
   FOR SHARE OF guarded_run, guarded_message, guarded_link;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_exact_source_check',
      MESSAGE = 'shared contact memory use lacks exact current input-message identity provenance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryUseItem_shared_exact_source_guard"
  ON "MemoryUseItem";
CREATE TRIGGER "MemoryUseItem_shared_exact_source_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_shared_exact_source_guard"();

COMMIT;
