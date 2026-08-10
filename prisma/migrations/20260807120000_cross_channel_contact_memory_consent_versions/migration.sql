-- Version cross-channel Contact Memory consent without trusting historical
-- unversioned rows. PostgreSQL remains authoritative; revocation immediately
-- fences Recall even when provider cleanup is still queued by the service.

BEGIN;

ALTER TABLE "ContactMemorySharingConsent"
  ADD COLUMN IF NOT EXISTS "consentVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "disclosureContractVersion" TEXT;

UPDATE "ContactMemorySharingConsent"
   SET "disclosureContractVersion" = 'legacy-unversioned'
 WHERE "disclosureContractVersion" IS NULL;

ALTER TABLE "ContactMemorySharingConsent"
  ALTER COLUMN "disclosureContractVersion" SET NOT NULL;

ALTER TABLE "ContactMemorySharingConsent"
  DROP CONSTRAINT IF EXISTS "ContactMemorySharingConsent_rep_identity_revision_key";

ALTER TABLE "ContactMemorySharingConsent"
  ADD CONSTRAINT "ContactMemorySharingConsent_rep_identity_revision_version_key"
  UNIQUE (
    "representativeId",
    "audienceIdentityId",
    "policyRevision",
    "consentVersion"
  );

ALTER TABLE "ContactMemorySharingConsent"
  ADD CONSTRAINT "ContactMemorySharingConsent_version_contract_check" CHECK (
    "consentVersion" >= 1
    AND "disclosureContractVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  );

CREATE UNIQUE INDEX
  "ContactMemorySharingConsent_current_grant_key"
  ON "ContactMemorySharingConsent"(
    "representativeId",
    "audienceIdentityId",
    "policyRevision"
  )
  WHERE "status" = 'GRANTED' AND "revokedAt" IS NULL;

CREATE OR REPLACE FUNCTION "contact_memory_sharing_consent_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId"
    OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
    OR NEW."policyRevision" IS DISTINCT FROM OLD."policyRevision"
    OR NEW."consentVersion" IS DISTINCT FROM OLD."consentVersion"
    OR NEW."disclosureContractVersion"
      IS DISTINCT FROM OLD."disclosureContractVersion"
    OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
    OR NEW."proofHash" IS DISTINCT FROM OLD."proofHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR OLD."status" = 'REVOKED'
    OR NEW."status" NOT IN ('GRANTED', 'REVOKED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingConsent_immutable_check',
      MESSAGE = 'sharing consent proof is immutable and each revocation is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "governed_shared_memory_consent_contract_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."scope" = 'CONTACT_SHARED'
     AND NEW."status" = 'ACTIVE'
     AND NOT EXISTS (
       SELECT 1
         FROM "RepresentativeMemoryPolicy" policy_record
         JOIN "ContactMemorySharingConsent" consent
           ON consent."representativeId" = policy_record."representativeId"
          AND consent."policyRevision" = policy_record."revision"
        WHERE policy_record."representativeId" = NEW."representativeId"
          AND consent."audienceIdentityId" = NEW."audienceIdentityId"
          AND consent."status" = 'GRANTED'
          AND consent."revokedAt" IS NULL
          AND consent."disclosureContractVersion"
            = 'cross-channel-contact-memory-v1'
          AND consent."consentVersion" = (
            SELECT MAX(latest_consent."consentVersion")
              FROM "ContactMemorySharingConsent" latest_consent
             WHERE latest_consent."representativeId" = NEW."representativeId"
               AND latest_consent."audienceIdentityId" = NEW."audienceIdentityId"
               AND latest_consent."policyRevision" = policy_record."revision"
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_shared_consent_contract_check',
      MESSAGE = 'shared contact memory requires the latest consent contract';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GovernedSharedMemoryConsentContract_guard"
  ON "GovernedMemory";
CREATE TRIGGER "GovernedSharedMemoryConsentContract_guard"
  BEFORE INSERT OR UPDATE OF "status", "currentVersionId", "recallDisabledAt"
  ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_shared_memory_consent_contract_guard"();

CREATE OR REPLACE FUNCTION "contact_memory_sharing_revocation_fence"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'GRANTED'
     AND OLD."revokedAt" IS NULL
     AND NEW."status" = 'REVOKED'
     AND NEW."revokedAt" IS NOT NULL THEN
    UPDATE "GovernedMemory"
       SET "status" = 'SUPPRESSED',
           "recallDisabledAt" = COALESCE("recallDisabledAt", NEW."revokedAt"),
           "suppressedAt" = COALESCE("suppressedAt", NEW."revokedAt"),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "representativeId" = NEW."representativeId"
       AND "audienceIdentityId" = NEW."audienceIdentityId"
       AND "scope" = 'CONTACT_SHARED'
       AND "status" = 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ContactMemorySharingConsent_revocation_fence"
  ON "ContactMemorySharingConsent";
CREATE TRIGGER "ContactMemorySharingConsent_revocation_fence"
  AFTER UPDATE OF "status", "revokedAt"
  ON "ContactMemorySharingConsent"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_revocation_fence"();

COMMIT;
