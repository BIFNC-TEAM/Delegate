-- Make the one-time disclosure challenge an explicit database authority at
-- every shared-memory boundary. Application checks remain defense in depth;
-- these guards prevent a legacy or partially-written GRANTED row from
-- activating memory, writing a provider projection, or entering the use ledger.

BEGIN;

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
     WHERE authority_policy."representativeId"
             = authority_representative_id
       AND authority_policy."longTermMemoryEnabled"
       AND authority_policy."contactMemoryEnabled"
       AND authority_policy."contactMemoryCrossChannelEnabled"
       AND authority_identity."status" = 'REGISTERED'::"AudienceIdentityStatus"
       AND authority_identity."mergedIntoId" IS NULL
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
       AND authority_challenge."consumedAt" <= authority_challenge."expiresAt"
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

CREATE OR REPLACE FUNCTION "governed_memory_shared_challenge_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."scope" = 'CONTACT_SHARED'::"MemoryScope"
     AND NEW."status" = 'ACTIVE'::"GovernedMemoryStatus"
     AND (
       NEW."audienceIdentityId" IS NULL
       OR NOT "contact_memory_sharing_has_challenge_authority"(
         NEW."representativeId",
         NEW."audienceIdentityId"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_shared_challenge_check',
      MESSAGE = 'active shared contact memory requires a current consumed disclosure challenge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GovernedMemory_shared_challenge_guard"
  ON "GovernedMemory";
CREATE TRIGGER "GovernedMemory_shared_challenge_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_shared_challenge_guard"();

CREATE OR REPLACE FUNCTION "memory_projection_shared_challenge_guard"()
RETURNS TRIGGER AS $$
DECLARE
  guarded_memory "GovernedMemory"%ROWTYPE;
BEGIN
  IF NEW."status" NOT IN (
    'QUEUED'::"MemoryProjectionStatus",
    'PROJECTING'::"MemoryProjectionStatus",
    'STAGED'::"MemoryProjectionStatus",
    'ACTIVE'::"MemoryProjectionStatus",
    'RETRYING'::"MemoryProjectionStatus"
  ) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO guarded_memory
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId"
     AND "representativeId" = NEW."representativeId";
  IF guarded_memory."scope" = 'CONTACT_SHARED'::"MemoryScope"
     AND (
       guarded_memory."audienceIdentityId" IS NULL
       OR NOT "contact_memory_sharing_has_challenge_authority"(
         guarded_memory."representativeId",
         guarded_memory."audienceIdentityId"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_shared_challenge_check',
      MESSAGE = 'shared contact memory projection requires a current consumed disclosure challenge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_shared_challenge_guard"
  ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_shared_challenge_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_shared_challenge_guard"();

CREATE OR REPLACE FUNCTION "memory_use_item_shared_challenge_guard"()
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
     OR guarded_memory."audienceIdentityId" IS NULL
     OR NOT "contact_memory_sharing_has_challenge_authority"(
       guarded_memory."representativeId",
       guarded_memory."audienceIdentityId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_shared_challenge_check',
      MESSAGE = 'shared contact memory use requires a current consumed disclosure challenge';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryUseItem_shared_challenge_guard"
  ON "MemoryUseItem";
CREATE TRIGGER "MemoryUseItem_shared_challenge_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_shared_challenge_guard"();

COMMIT;
