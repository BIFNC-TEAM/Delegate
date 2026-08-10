-- Replace replayable text confirmation with a short-lived, one-time,
-- source-bound capability. Only the token hash is persisted; a granted consent
-- is cryptographically bound to the consumed challenge, exact verified source
-- evidence, and the distinct confirmation event.

BEGIN;

CREATE TABLE "ContactMemorySharingChallenge" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "disclosureContractVersion" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "sourceEvidenceHash" TEXT NOT NULL,
  "disclosureEventHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContactMemorySharingChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactMemorySharingChallenge_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "ContactMemorySharingChallenge_hash_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$'
    AND "sourceEvidenceHash" ~ '^[0-9a-f]{64}$'
    AND "disclosureEventHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ContactMemorySharingChallenge_contract_check" CHECK (
    "policyRevision" >= 0
    AND "disclosureContractVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT "ContactMemorySharingChallenge_lifecycle_check" CHECK (
    "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND ("consumedAt" IS NULL OR "consumedAt" <= "expiresAt")
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
  )
);

CREATE INDEX "ContactMemorySharingChallenge_scope_created_idx"
  ON "ContactMemorySharingChallenge"(
    "representativeId",
    "audienceIdentityId",
    "sourceChannel",
    "createdAt"
  );
CREATE INDEX "ContactMemorySharingChallenge_lifecycle_idx"
  ON "ContactMemorySharingChallenge"(
    "expiresAt",
    "consumedAt",
    "revokedAt"
  );

ALTER TABLE "ContactMemorySharingChallenge"
  ADD CONSTRAINT "ContactMemorySharingChallenge_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactMemorySharingChallenge_identity_fkey"
  FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactMemorySharingConsent"
  ADD COLUMN "challengeId" TEXT,
  ADD COLUMN "sourceEvidenceHash" TEXT,
  ADD COLUMN "confirmationEventHash" TEXT;

CREATE UNIQUE INDEX "ContactMemorySharingConsent_challengeId_key"
  ON "ContactMemorySharingConsent"("challengeId");
ALTER TABLE "ContactMemorySharingConsent"
  ADD CONSTRAINT "ContactMemorySharingConsent_challenge_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "ContactMemorySharingChallenge"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOT VALID intentionally grandfathers already-active explicit grants. It is
-- still enforced for every new insert/update, so all authority created after
-- this migration must consume and bind a one-time challenge.
ALTER TABLE "ContactMemorySharingConsent"
  ADD CONSTRAINT "ContactMemorySharingConsent_challenge_shape_check" CHECK (
    "status" <> 'GRANTED'
    OR (
      "challengeId" IS NOT NULL
      AND "sourceEvidenceHash" ~ '^[0-9a-f]{64}$'
      AND "confirmationEventHash" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "contact_memory_sharing_challenge_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId"
    OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
    OR NEW."policyRevision" IS DISTINCT FROM OLD."policyRevision"
    OR NEW."disclosureContractVersion"
         IS DISTINCT FROM OLD."disclosureContractVersion"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."sourceEvidenceHash" IS DISTINCT FROM OLD."sourceEvidenceHash"
    OR NEW."disclosureEventHash" IS DISTINCT FROM OLD."disclosureEventHash"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR OLD."consumedAt" IS NOT NULL
    OR OLD."revokedAt" IS NOT NULL
    OR (
      NEW."consumedAt" IS NOT NULL
      AND NEW."revokedAt" IS NOT NULL
    )
    OR (
      NEW."consumedAt" IS NULL
      AND NEW."revokedAt" IS NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingChallenge_immutable_terminal_check',
      MESSAGE = 'sharing challenge coordinates are immutable and consumption or revocation is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactMemorySharingChallenge_guard"
  BEFORE UPDATE ON "ContactMemorySharingChallenge"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_challenge_guard"();

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
     OR challenge_record."representativeId" IS DISTINCT FROM NEW."representativeId"
     OR challenge_record."audienceIdentityId" IS DISTINCT FROM NEW."audienceIdentityId"
     OR challenge_record."sourceChannel" IS DISTINCT FROM NEW."sourceChannel"
     OR challenge_record."policyRevision" IS DISTINCT FROM NEW."policyRevision"
     OR challenge_record."disclosureContractVersion"
          IS DISTINCT FROM NEW."disclosureContractVersion"
     OR challenge_record."sourceEvidenceHash"
          IS DISTINCT FROM NEW."sourceEvidenceHash"
     OR challenge_record."consumedAt" IS NULL
     OR challenge_record."consumedAt" > challenge_record."expiresAt"
     OR challenge_record."revokedAt" IS NOT NULL
     OR NEW."confirmationEventHash" IS NULL
     OR NEW."confirmationEventHash" = challenge_record."disclosureEventHash" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingConsent_consumed_challenge_check',
      MESSAGE = 'sharing consent requires a distinct, consumed, exact-scope challenge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactMemorySharingConsent_challenge_guard"
  BEFORE INSERT OR UPDATE ON "ContactMemorySharingConsent"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_consent_challenge_guard"();

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
    OR NEW."challengeId" IS DISTINCT FROM OLD."challengeId"
    OR NEW."sourceEvidenceHash" IS DISTINCT FROM OLD."sourceEvidenceHash"
    OR NEW."confirmationEventHash" IS DISTINCT FROM OLD."confirmationEventHash"
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

COMMIT;
