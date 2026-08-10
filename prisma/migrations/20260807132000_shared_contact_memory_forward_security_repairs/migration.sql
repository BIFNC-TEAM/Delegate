-- Forward-only repair for the deployed shared Contact Memory authority chain.
-- Keep retention cleanup possible after consent withdrawal, acquire exact
-- source locks before shared/contact coordinates, unify source-event replay
-- claims across disclosure and confirmation, and tighten temporal evidence.

BEGIN;

CREATE TYPE "ContactMemorySharingSourceEventRole" AS ENUM (
  'DISCLOSURE',
  'CONFIRMATION'
);

CREATE TABLE "ContactMemorySharingSourceEventClaim" (
  "eventHash" TEXT NOT NULL,
  "role" "ContactMemorySharingSourceEventRole" NOT NULL,
  "representativeId" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "challengeId" TEXT NOT NULL,
  "consentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMemorySharingSourceEventClaim_pkey"
    PRIMARY KEY ("eventHash"),
  CONSTRAINT "ContactMemorySharingSourceEventClaim_hash_check" CHECK (
    "eventHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ContactMemorySharingSourceEventClaim_shape_check" CHECK (
    (
      "role" = 'DISCLOSURE'::"ContactMemorySharingSourceEventRole"
      AND "consentId" IS NULL
    ) OR (
      "role" = 'CONFIRMATION'::"ContactMemorySharingSourceEventRole"
      AND "consentId" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX
  "ContactMemorySharingSourceEventClaim_challenge_role_key"
  ON "ContactMemorySharingSourceEventClaim"("challengeId", "role");
CREATE UNIQUE INDEX
  "ContactMemorySharingSourceEventClaim_consentId_key"
  ON "ContactMemorySharingSourceEventClaim"("consentId");
CREATE INDEX
  "ContactMemorySharingSourceEventClaim_scope_created_idx"
  ON "ContactMemorySharingSourceEventClaim"(
    "representativeId",
    "audienceIdentityId",
    "sourceChannel",
    "createdAt"
  );

ALTER TABLE "ContactMemorySharingSourceEventClaim"
  ADD CONSTRAINT "ContactMemorySharingSourceEventClaim_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactMemorySharingSourceEventClaim_identity_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactMemorySharingSourceEventClaim_challenge_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "ContactMemorySharingChallenge"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactMemorySharingSourceEventClaim_consent_fkey"
  FOREIGN KEY ("consentId") REFERENCES "ContactMemorySharingConsent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The eventHash primary key deliberately makes a disclosure hash conflict
-- with a confirmation hash. Any historical cross-role collision aborts this
-- migration instead of silently choosing an authority record.
INSERT INTO "ContactMemorySharingSourceEventClaim" (
  "eventHash",
  "role",
  "representativeId",
  "audienceIdentityId",
  "sourceChannel",
  "challengeId",
  "consentId",
  "createdAt"
)
SELECT
  challenge."disclosureEventHash",
  'DISCLOSURE'::"ContactMemorySharingSourceEventRole",
  challenge."representativeId",
  challenge."audienceIdentityId",
  challenge."sourceChannel",
  challenge."id",
  NULL,
  challenge."createdAt"
FROM "ContactMemorySharingChallenge" challenge;

INSERT INTO "ContactMemorySharingSourceEventClaim" (
  "eventHash",
  "role",
  "representativeId",
  "audienceIdentityId",
  "sourceChannel",
  "challengeId",
  "consentId",
  "createdAt"
)
SELECT
  consent."confirmationEventHash",
  'CONFIRMATION'::"ContactMemorySharingSourceEventRole",
  consent."representativeId",
  consent."audienceIdentityId",
  consent."sourceChannel",
  consent."challengeId",
  consent."id",
  consent."createdAt"
FROM "ContactMemorySharingConsent" consent
WHERE consent."challengeId" IS NOT NULL
  AND consent."confirmationEventHash" IS NOT NULL;

CREATE OR REPLACE FUNCTION "contact_memory_sharing_source_event_claim_guard"()
RETURNS TRIGGER AS $$
DECLARE
  guarded_challenge "ContactMemorySharingChallenge"%ROWTYPE;
  guarded_consent "ContactMemorySharingConsent"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingSourceEventClaim_immutable_check',
      MESSAGE = 'contact memory sharing source-event claims are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'ContactMemorySharingSourceEventClaim_immutable_check',
        MESSAGE = 'contact memory sharing source-event claims cannot be deleted directly';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO guarded_challenge
    FROM "ContactMemorySharingChallenge"
   WHERE "id" = NEW."challengeId"
   FOR SHARE;
  IF NOT FOUND
     OR guarded_challenge."representativeId"
          IS DISTINCT FROM NEW."representativeId"
     OR guarded_challenge."audienceIdentityId"
          IS DISTINCT FROM NEW."audienceIdentityId"
     OR guarded_challenge."sourceChannel"
          IS DISTINCT FROM NEW."sourceChannel" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingSourceEventClaim_scope_check',
      MESSAGE = 'source-event claim does not match its disclosure challenge';
  END IF;

  IF NEW."role" = 'DISCLOSURE'::"ContactMemorySharingSourceEventRole" THEN
    IF NEW."eventHash" IS DISTINCT FROM guarded_challenge."disclosureEventHash"
       OR NEW."consentId" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'ContactMemorySharingSourceEventClaim_disclosure_check',
        MESSAGE = 'disclosure event claim does not match its challenge';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO guarded_consent
    FROM "ContactMemorySharingConsent"
   WHERE "id" = NEW."consentId"
   FOR SHARE;
  IF NOT FOUND
     OR guarded_consent."representativeId"
          IS DISTINCT FROM NEW."representativeId"
     OR guarded_consent."audienceIdentityId"
          IS DISTINCT FROM NEW."audienceIdentityId"
     OR guarded_consent."sourceChannel"
          IS DISTINCT FROM NEW."sourceChannel"
     OR guarded_consent."challengeId" IS DISTINCT FROM NEW."challengeId"
     OR guarded_consent."confirmationEventHash"
          IS DISTINCT FROM NEW."eventHash" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingSourceEventClaim_confirmation_check',
      MESSAGE = 'confirmation event claim does not match its consent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactMemorySharingSourceEventClaim_guard"
  BEFORE INSERT OR UPDATE OR DELETE
  ON "ContactMemorySharingSourceEventClaim"
  FOR EACH ROW EXECUTE FUNCTION
    "contact_memory_sharing_source_event_claim_guard"();

-- Challenge and consent evidence may never predate the rows/events they prove.
ALTER TABLE "ContactMemorySharingChallenge"
  DROP CONSTRAINT "ContactMemorySharingChallenge_lifecycle_check";
ALTER TABLE "ContactMemorySharingChallenge"
  ADD CONSTRAINT "ContactMemorySharingChallenge_lifecycle_check" CHECK (
    "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND (
      "consumedAt" IS NULL
      OR (
        "consumedAt" >= "createdAt"
        AND "consumedAt" <= "expiresAt"
      )
    )
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
  );

CREATE OR REPLACE FUNCTION "contact_memory_sharing_consent_challenge_guard"()
RETURNS TRIGGER AS $$
DECLARE
  challenge_record "ContactMemorySharingChallenge"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'GRANTED'::"ContactMemorySharingConsentStatus" THEN
    RETURN NEW;
  END IF;
  SELECT * INTO challenge_record
    FROM "ContactMemorySharingChallenge"
   WHERE "id" = NEW."challengeId"
   FOR SHARE;
  IF NOT FOUND
     OR challenge_record."representativeId"
          IS DISTINCT FROM NEW."representativeId"
     OR challenge_record."audienceIdentityId"
          IS DISTINCT FROM NEW."audienceIdentityId"
     OR challenge_record."sourceChannel" IS DISTINCT FROM NEW."sourceChannel"
     OR challenge_record."policyRevision" IS DISTINCT FROM NEW."policyRevision"
     OR challenge_record."disclosureContractVersion"
          IS DISTINCT FROM NEW."disclosureContractVersion"
     OR challenge_record."sourceEvidenceHash"
          IS DISTINCT FROM NEW."sourceEvidenceHash"
     OR challenge_record."consumedAt" IS NULL
     OR challenge_record."consumedAt" < challenge_record."createdAt"
     OR challenge_record."consumedAt" > challenge_record."expiresAt"
     OR challenge_record."revokedAt" IS NOT NULL
     OR NEW."grantedAt" < challenge_record."consumedAt"
     OR NEW."confirmationEventHash" IS NULL
     OR NEW."confirmationEventHash" = challenge_record."disclosureEventHash" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingConsent_consumed_challenge_check',
      MESSAGE = 'sharing consent requires a distinct, consumed, chronological exact-scope challenge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A pure retention update (citationId -> NULL plus citationPurgedAt) removes
-- public presentation authority; it does not create a new search/use right.
CREATE OR REPLACE FUNCTION "memory_use_item_authority_advances"(
  old_record "MemoryUseItem",
  new_record "MemoryUseItem"
) RETURNS BOOLEAN AS $$
  SELECT
    (old_record."searchRank" IS NULL AND new_record."searchRank" IS NOT NULL)
    OR (old_record."searchScore" IS NULL AND new_record."searchScore" IS NOT NULL)
    OR (old_record."searchedAt" IS NULL AND new_record."searchedAt" IS NOT NULL)
    OR (old_record."scopeCheckedAt" IS NULL AND new_record."scopeCheckedAt" IS NOT NULL)
    OR (old_record."scopePassedAt" IS NULL AND new_record."scopePassedAt" IS NOT NULL)
    OR (old_record."safetyCheckedAt" IS NULL AND new_record."safetyCheckedAt" IS NOT NULL)
    OR (old_record."safetyPassedAt" IS NULL AND new_record."safetyPassedAt" IS NOT NULL)
    OR (old_record."injectedAt" IS NULL AND new_record."injectedAt" IS NOT NULL)
    OR (old_record."citedAt" IS NULL AND new_record."citedAt" IS NOT NULL)
    OR (old_record."displayedAt" IS NULL AND new_record."displayedAt" IS NOT NULL)
    OR (old_record."citationId" IS NULL AND new_record."citationId" IS NOT NULL)
    OR (
      old_record."rejectionReasonCode" IS NULL
      AND new_record."rejectionReasonCode" IS NOT NULL
    );
$$ LANGUAGE sql IMMUTABLE;

-- Preserve the full append-only/citation-retention logic in the existing
-- truth-ledger function, but stop before live authority reads when the UPDATE
-- only removes a citation. Abort if the deployed function shape is unexpected.
DO $scope_cleanup_repair$
DECLARE
  guard_definition TEXT;
  authority_read_marker TEXT := E'  SELECT * INTO run_record\n    FROM "MemoryUseRun"';
  replacement_marker TEXT := E'  IF TG_OP = ''UPDATE''\n     AND NOT "memory_use_item_authority_advances"(OLD, NEW) THEN\n    RETURN NEW;\n  END IF;\n\n  SELECT * INTO run_record\n    FROM "MemoryUseRun"';
  marker_count INTEGER;
BEGIN
  SELECT pg_get_functiondef('"memory_use_item_scope_guard"()'::regprocedure)
    INTO guard_definition;
  marker_count := (
    length(guard_definition)
      - length(replace(guard_definition, authority_read_marker, ''))
  ) / length(authority_read_marker);
  IF guard_definition IS NULL OR marker_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one MemoryUseRun authority-read marker in memory_use_item_scope_guard, found %.',
      COALESCE(marker_count, -1);
  END IF;
  EXECUTE replace(
    guard_definition,
    authority_read_marker,
    replacement_marker
  );
END;
$scope_cleanup_repair$;

-- Event claims are now part of database authority, not merely an application
-- idempotency record. Both roles must point at the same challenge/consent pair.
CREATE OR REPLACE FUNCTION "contact_memory_sharing_has_challenge_authority"(
  authority_representative_id TEXT,
  authority_audience_identity_id TEXT
)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "RepresentativeMemoryPolicy" authority_policy
      JOIN "AudienceIdentity" authority_identity
        ON authority_identity."id" = authority_audience_identity_id
      JOIN "ContactMemorySharingConsent" authority_consent
        ON authority_consent."representativeId"
             = authority_policy."representativeId"
       AND authority_consent."audienceIdentityId"
             = authority_identity."id"
       AND authority_consent."policyRevision" = authority_policy."revision"
      JOIN "ContactMemorySharingChallenge" authority_challenge
        ON authority_challenge."id" = authority_consent."challengeId"
      JOIN "ContactMemorySharingSourceEventClaim" disclosure_claim
        ON disclosure_claim."eventHash"
             = authority_challenge."disclosureEventHash"
       AND disclosure_claim."role"
             = 'DISCLOSURE'::"ContactMemorySharingSourceEventRole"
       AND disclosure_claim."challengeId" = authority_challenge."id"
       AND disclosure_claim."consentId" IS NULL
      JOIN "ContactMemorySharingSourceEventClaim" confirmation_claim
        ON confirmation_claim."eventHash"
             = authority_consent."confirmationEventHash"
       AND confirmation_claim."role"
             = 'CONFIRMATION'::"ContactMemorySharingSourceEventRole"
       AND confirmation_claim."challengeId" = authority_challenge."id"
       AND confirmation_claim."consentId" = authority_consent."id"
     WHERE authority_policy."representativeId"
             = authority_representative_id
       AND authority_policy."longTermMemoryEnabled"
       AND authority_policy."contactMemoryEnabled"
       AND authority_policy."contactMemoryCrossChannelEnabled"
       AND authority_identity."status" = 'REGISTERED'::"AudienceIdentityStatus"
       AND authority_identity."mergedIntoId" IS NULL
       AND disclosure_claim."representativeId"
             = authority_consent."representativeId"
       AND disclosure_claim."audienceIdentityId"
             = authority_consent."audienceIdentityId"
       AND disclosure_claim."sourceChannel" = authority_consent."sourceChannel"
       AND confirmation_claim."representativeId"
             = authority_consent."representativeId"
       AND confirmation_claim."audienceIdentityId"
             = authority_consent."audienceIdentityId"
       AND confirmation_claim."sourceChannel" = authority_consent."sourceChannel"
       AND authority_consent."status"
             = 'GRANTED'::"ContactMemorySharingConsentStatus"
       AND authority_consent."grantedAt" IS NOT NULL
       AND authority_consent."revokedAt" IS NULL
       AND authority_consent."disclosureContractVersion"
             = 'cross-channel-contact-memory-v1'
       AND authority_consent."challengeId" IS NOT NULL
       AND authority_consent."sourceEvidenceHash" ~ '^[0-9a-f]{64}$'
       AND authority_consent."confirmationEventHash" ~ '^[0-9a-f]{64}$'
       AND authority_consent."proofHash" ~ '^[0-9a-f]{64}$'
       AND authority_challenge."representativeId"
             = authority_consent."representativeId"
       AND authority_challenge."audienceIdentityId"
             = authority_consent."audienceIdentityId"
       AND authority_challenge."sourceChannel"
             = authority_consent."sourceChannel"
       AND authority_challenge."policyRevision"
             = authority_consent."policyRevision"
       AND authority_challenge."disclosureContractVersion"
             = authority_consent."disclosureContractVersion"
       AND authority_challenge."sourceEvidenceHash"
             = authority_consent."sourceEvidenceHash"
       AND authority_challenge."consumedAt" IS NOT NULL
       AND authority_challenge."consumedAt" >= authority_challenge."createdAt"
       AND authority_challenge."consumedAt" <= authority_challenge."expiresAt"
       AND authority_consent."grantedAt" >= authority_challenge."consumedAt"
       AND authority_challenge."revokedAt" IS NULL
       AND authority_consent."confirmationEventHash"
             <> authority_challenge."disclosureEventHash"
       AND authority_consent."consentVersion" = (
         SELECT MAX(latest_authority_consent."consentVersion")
           FROM "ContactMemorySharingConsent" latest_authority_consent
          WHERE latest_authority_consent."representativeId"
                  = authority_consent."representativeId"
            AND latest_authority_consent."audienceIdentityId"
                  = authority_consent."audienceIdentityId"
            AND latest_authority_consent."policyRevision"
                  = authority_consent."policyRevision"
       )
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "memory_use_item_shared_challenge_guard"()
RETURNS TRIGGER AS $$
DECLARE
  guarded_memory "GovernedMemory"%ROWTYPE;
BEGIN
  IF NEW."sourceKind" <> 'CONTACT_MEMORY'::"MemoryUseSourceKind"
     OR NEW."memoryScope" <> 'CONTACT_SHARED'::"MemoryScope"
     OR (
       TG_OP = 'UPDATE'
       AND NOT "memory_use_item_authority_advances"(OLD, NEW)
     ) THEN
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
     OR guarded_memory."audienceIdentityId" IS NULL
     OR NOT "contact_memory_sharing_has_challenge_authority"(
       guarded_memory."representativeId",
       guarded_memory."audienceIdentityId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_challenge_check',
      MESSAGE = 'shared contact memory use requires current one-shot challenge authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_use_item_shared_exact_source_guard"()
RETURNS TRIGGER AS $$
DECLARE
  guarded_memory "GovernedMemory"%ROWTYPE;
  guarded_source_channel "RepresentativeChannelKind";
  shared_lock_key TEXT;
BEGIN
  IF NEW."sourceKind" <> 'CONTACT_MEMORY'::"MemoryUseSourceKind"
     OR NEW."memoryScope" <> 'CONTACT_SHARED'::"MemoryScope"
     OR (
       TG_OP = 'UPDATE'
       AND NOT "memory_use_item_authority_advances"(OLD, NEW)
     ) THEN
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

  SELECT "sourceChannel" INTO guarded_source_channel
    FROM "MemoryUseRun"
   WHERE "id" = NEW."useRunId"
     AND "representativeId" = NEW."representativeId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_exact_source_check',
      MESSAGE = 'shared contact memory use lacks its source run';
  END IF;

  IF guarded_source_channel = 'WEB'::"RepresentativeChannelKind" THEN
    PERFORM 1
      FROM "MemoryUseRun" exact_run
      JOIN "Message" exact_message
        ON exact_message."id" = exact_run."inputMessageId"
       AND exact_message."conversationId" = exact_run."conversationId"
      JOIN "IdentityLink" exact_link
        ON exact_link."id" = exact_message."sourceIdentityLinkId"
     WHERE exact_run."id" = NEW."useRunId"
       AND exact_run."representativeId" = NEW."representativeId"
       AND exact_run."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
       AND exact_message."senderType" = 'AUDIENCE'::"MessageSenderType"
       AND exact_message."sourceIdentityConnectionProofId" IS NULL
       AND exact_link."audienceIdentityId"
             = guarded_memory."audienceIdentityId"
       AND exact_link."provider" = 'LOGTO'::"IdentityLinkProvider"
       AND exact_link."verifiedAt" IS NOT NULL
       AND exact_link."revokedAt" IS NULL
       AND exact_link."assuranceLevel" IN (
         'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
         'STEP_UP_VERIFIED'::"IdentityAssuranceLevel"
       )
     FOR SHARE OF exact_run, exact_message, exact_link;
  ELSE
    PERFORM 1
      FROM "MemoryUseRun" exact_run
      JOIN "Message" exact_message
        ON exact_message."id" = exact_run."inputMessageId"
       AND exact_message."conversationId" = exact_run."conversationId"
      JOIN "IdentityLink" exact_link
        ON exact_link."id" = exact_message."sourceIdentityLinkId"
      JOIN "IdentityLinkConnectionProof" exact_proof
        ON exact_proof."id"
             = exact_message."sourceIdentityConnectionProofId"
       AND exact_proof."identityLinkId" = exact_link."id"
      JOIN "ConversationChannelBinding" exact_binding
        ON exact_binding."id" = exact_message."channelBindingId"
       AND exact_binding."conversationId" = exact_run."conversationId"
     WHERE exact_run."id" = NEW."useRunId"
       AND exact_run."representativeId" = NEW."representativeId"
       AND exact_run."sourceChannel" IN (
         'MATRIX'::"RepresentativeChannelKind",
         'TELEGRAM'::"RepresentativeChannelKind"
       )
       AND exact_message."senderType" = 'AUDIENCE'::"MessageSenderType"
       AND exact_link."audienceIdentityId"
             = guarded_memory."audienceIdentityId"
       AND exact_link."provider" = CASE exact_run."sourceChannel"
         WHEN 'MATRIX'::"RepresentativeChannelKind"
           THEN 'MATRIX'::"IdentityLinkProvider"
         ELSE 'TELEGRAM'::"IdentityLinkProvider"
       END
       AND exact_message."senderId" = exact_link."providerSubject"
       AND exact_link."verifiedAt" IS NOT NULL
       AND exact_link."revokedAt" IS NULL
       AND exact_link."assuranceLevel" IN (
         'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
         'STEP_UP_VERIFIED'::"IdentityAssuranceLevel"
       )
       AND exact_proof."issuer" = exact_link."issuer"
       AND exact_proof."verifiedAt" IS NOT NULL
       AND exact_proof."revokedAt" IS NULL
       AND exact_proof."assuranceLevel" IN (
         'PLATFORM_VERIFIED'::"IdentityAssuranceLevel",
         'STEP_UP_VERIFIED'::"IdentityAssuranceLevel"
       )
       AND exact_binding."kind" = exact_run."sourceChannel"
       AND exact_binding."connectionId" = exact_proof."connectionId"
     FOR SHARE OF
       exact_run,
       exact_message,
       exact_link,
       exact_proof,
       exact_binding;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_exact_source_check',
      MESSAGE = 'shared contact memory use lacks exact current input-message identity provenance';
  END IF;

  -- Match lockContactSharedMemoryCoordinate: proof/link first, then policy,
  -- shared advisory coordinate and canonical identity; the contact-channel
  -- forget guard runs after this trigger.
  PERFORM "representativeId"
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = NEW."representativeId"
   FOR SHARE;
  shared_lock_key := concat_ws(
    ':',
    'contact-shared-memory-v1',
    NEW."representativeId",
    guarded_memory."audienceIdentityId"
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(shared_lock_key, 0));
  PERFORM "id"
    FROM "AudienceIdentity"
   WHERE "id" = guarded_memory."audienceIdentityId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_exact_source_check',
      MESSAGE = 'shared contact memory canonical identity disappeared';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryUseItem_shared_exact_source_guard"
  ON "MemoryUseItem";
DROP TRIGGER IF EXISTS "00_0_MemoryUseItem_shared_exact_source_guard"
  ON "MemoryUseItem";
CREATE TRIGGER "00_0_MemoryUseItem_shared_exact_source_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_shared_exact_source_guard"();

-- The latest deployed projection re-enable function inherited one v1 private
-- disclosure literal. Replace that exact occurrence only; abort on drift.
DO $projection_reenable_contract_repair$
DECLARE
  guard_definition TEXT;
  obsolete_literal TEXT := 'private-channel-memory-v1';
  current_literal TEXT := 'private-channel-memory-v2';
  obsolete_count INTEGER;
BEGIN
  SELECT pg_get_functiondef(
    '"memory_projection_policy_reenable_allowed"("MemoryProjectionItem","MemoryProjectionItem")'::regprocedure
  ) INTO guard_definition;
  obsolete_count := (
    length(guard_definition)
      - length(replace(guard_definition, obsolete_literal, ''))
  ) / length(obsolete_literal);
  IF guard_definition IS NULL OR obsolete_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one obsolete private disclosure literal in memory_projection_policy_reenable_allowed, found %.',
      COALESCE(obsolete_count, -1);
  END IF;
  EXECUTE replace(guard_definition, obsolete_literal, current_literal);
END;
$projection_reenable_contract_repair$;

COMMIT;
