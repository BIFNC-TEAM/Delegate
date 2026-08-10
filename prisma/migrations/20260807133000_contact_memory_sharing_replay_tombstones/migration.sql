-- Keep provider-event replay fences after ordinary representative/audience
-- retention cleanup. SourceEventClaim remains the live authority join, while
-- this relation-free, content-free tombstone is the permanent one-shot fence.

BEGIN;

CREATE TABLE "ContactMemorySharingSourceEventTombstone" (
  "eventHash" TEXT NOT NULL,
  "role" "ContactMemorySharingSourceEventRole" NOT NULL,
  "firstClaimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMemorySharingSourceEventTombstone_pkey"
    PRIMARY KEY ("eventHash"),
  CONSTRAINT "ContactMemorySharingSourceEventTombstone_hash_check" CHECK (
    "eventHash" ~ '^[0-9a-f]{64}$'
  )
);

-- Quiesce the sharing write path in its application lock order before taking
-- the live-claim lock. Taking these strongest table locks up front avoids a
-- lock-upgrade cycle with a grant that already owns a challenge row and would
-- otherwise wait on SourceEventClaim while this migration waits to replace a
-- challenge or consent trigger.
LOCK TABLE "ContactMemorySharingChallenge"
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ContactMemorySharingConsent"
  IN ACCESS EXCLUSIVE MODE;

-- Close the online-migration gap between the snapshot backfill and installing
-- the new INSERT guard. All three locks are held through COMMIT, so a
-- concurrent live claim either lands before the backfill or waits and then
-- runs through the tombstone-writing guard.
LOCK TABLE "ContactMemorySharingSourceEventClaim"
  IN SHARE ROW EXCLUSIVE MODE;

-- SourceEventClaim already has one global eventHash primary key, so this
-- backfill is deterministic. Any unexpected collision aborts the migration.
INSERT INTO "ContactMemorySharingSourceEventTombstone" (
  "eventHash",
  "role",
  "firstClaimedAt"
)
SELECT
  claim."eventHash",
  claim."role",
  claim."createdAt"
FROM "ContactMemorySharingSourceEventClaim" claim;

CREATE OR REPLACE FUNCTION
  "contact_memory_sharing_source_event_tombstone_guard"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'ContactMemorySharingSourceEventTombstone_immutable_check',
    MESSAGE = 'contact memory sharing replay tombstones are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactMemorySharingSourceEventTombstone_guard"
  BEFORE UPDATE OR DELETE
  ON "ContactMemorySharingSourceEventTombstone"
  FOR EACH ROW EXECUTE FUNCTION
    "contact_memory_sharing_source_event_tombstone_guard"();

-- Insert the permanent replay fence in the same transaction as the live
-- authority claim. A duplicate eventHash fails before authority can be reused.
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

  INSERT INTO "ContactMemorySharingSourceEventTombstone" (
    "eventHash",
    "role",
    "firstClaimedAt"
  ) VALUES (
    NEW."eventHash",
    NEW."role",
    NEW."createdAt"
  );

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

-- Consent and challenge proofs are append-only. Normal parent retention
-- cleanup still uses nested FK cascades; those cascades may remove the live
-- rows, but never the relation-free replay tombstone above.
CREATE OR REPLACE FUNCTION "contact_memory_sharing_challenge_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'ContactMemorySharingChallenge_delete_check',
        MESSAGE = 'sharing challenges cannot be deleted directly';
    END IF;
    RETURN OLD;
  END IF;
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

DROP TRIGGER IF EXISTS "ContactMemorySharingChallenge_guard"
  ON "ContactMemorySharingChallenge";
CREATE TRIGGER "ContactMemorySharingChallenge_guard"
  BEFORE UPDATE OR DELETE ON "ContactMemorySharingChallenge"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_challenge_guard"();

CREATE OR REPLACE FUNCTION "contact_memory_sharing_consent_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'ContactMemorySharingConsent_delete_check',
        MESSAGE = 'sharing consent proofs cannot be deleted directly';
    END IF;
    RETURN OLD;
  END IF;
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

DROP TRIGGER IF EXISTS "ContactMemorySharingConsent_guard"
  ON "ContactMemorySharingConsent";
DROP TRIGGER IF EXISTS "ContactMemorySharingConsent_immutable_fence"
  ON "ContactMemorySharingConsent";
CREATE TRIGGER "ContactMemorySharingConsent_guard"
  BEFORE UPDATE OR DELETE ON "ContactMemorySharingConsent"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_consent_guard"();

COMMIT;
