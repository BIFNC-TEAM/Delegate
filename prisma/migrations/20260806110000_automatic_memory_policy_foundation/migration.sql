-- Automatic memory policy foundation. Existing human review rows remain
-- valid and immutable; new decisions use a separate append-only trust ledger.

-- PostgreSQL requires a newly-added enum value to be committed before later
-- statements may use it in constraints or indexes. Keep this boundary explicit
-- because Prisma executes a migration file as one script.
BEGIN;
ALTER TYPE "MemoryScope" ADD VALUE IF NOT EXISTS 'CONTACT_SHARED';
COMMIT;

DO $$ BEGIN
  CREATE TYPE "MemoryPolicyDecisionOutcome" AS ENUM (
    'EVIDENCE_RECORDED',
    'ACTIVATED',
    'UPDATED',
    'UNCHANGED',
    'BLOCKED',
    'QUARANTINED',
    'SKIPPED',
    'INVALIDATED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ContactMemorySharingConsentStatus" AS ENUM (
    'GRANTED',
    'REVOKED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

BEGIN;

ALTER TABLE "RepresentativeMemoryPolicy"
  ADD COLUMN IF NOT EXISTS "shortTermMemoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "contactMemoryCrossChannelEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MemoryCandidate"
  ADD COLUMN IF NOT EXISTS "audienceIdentityId" TEXT,
  ADD COLUMN IF NOT EXISTS "semanticKey" TEXT;

ALTER TABLE "GovernedMemory"
  ADD COLUMN IF NOT EXISTS "audienceIdentityId" TEXT,
  ADD COLUMN IF NOT EXISTS "semanticKey" TEXT;

CREATE TABLE IF NOT EXISTS "MemoryPolicyDecision" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "memoryId" TEXT,
  "resultVersionId" TEXT,
  "outcome" "MemoryPolicyDecisionOutcome" NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "extractorVersion" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "outputHash" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "decisionHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryPolicyDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryPolicyDecision_candidateId_key" UNIQUE ("candidateId"),
  CONSTRAINT "MemoryPolicyDecision_decisionHash_key" UNIQUE ("decisionHash"),
  CONSTRAINT "MemoryPolicyDecision_revision_check" CHECK ("policyRevision" >= 0),
  CONSTRAINT "MemoryPolicyDecision_confidence_check" CHECK (
    "confidence" >= 0 AND "confidence" <= 1
  ),
  CONSTRAINT "MemoryPolicyDecision_hash_check" CHECK (
    "sourceHash" ~ '^[0-9a-f]{64}$'
    AND ("outputHash" IS NULL OR "outputHash" ~ '^[0-9a-f]{64}$')
    AND "decisionHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MemoryPolicyDecision_token_check" CHECK (
    "policyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "extractorVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT "MemoryPolicyDecision_target_check" CHECK (
    (
      "outcome" IN ('ACTIVATED', 'UPDATED', 'UNCHANGED')
      AND "memoryId" IS NOT NULL
      AND "resultVersionId" IS NOT NULL
      AND "outputHash" IS NOT NULL
    ) OR (
      "outcome" IN ('EVIDENCE_RECORDED', 'BLOCKED', 'QUARANTINED', 'SKIPPED')
      AND "memoryId" IS NULL
      AND "resultVersionId" IS NULL
    ) OR "outcome" = 'INVALIDATED'
  )
);

CREATE TABLE IF NOT EXISTS "ContactMemorySharingConsent" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "audienceIdentityId" TEXT NOT NULL,
  "status" "ContactMemorySharingConsentStatus" NOT NULL DEFAULT 'GRANTED',
  "grantedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "policyRevision" INTEGER NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "proofHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMemorySharingConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactMemorySharingConsent_rep_identity_revision_key"
    UNIQUE ("representativeId", "audienceIdentityId", "policyRevision"),
  CONSTRAINT "ContactMemorySharingConsent_revision_check" CHECK (
    "policyRevision" >= 0
  ),
  CONSTRAINT "ContactMemorySharingConsent_proof_hash_check" CHECK (
    "proofHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ContactMemorySharingConsent_status_check" CHECK (
    (
      "status" = 'GRANTED'
      AND "revokedAt" IS NULL
    ) OR (
      "status" = 'REVOKED'
      AND "revokedAt" IS NOT NULL
      AND "revokedAt" >= "grantedAt"
    )
  )
);

DO $$ BEGIN
  ALTER TABLE "MemoryCandidate"
    ADD CONSTRAINT "MemoryCandidate_audience_identity_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "GovernedMemory"
    ADD CONSTRAINT "GovernedMemory_audience_identity_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MemoryPolicyDecision"
    ADD CONSTRAINT "MemoryPolicyDecision_rep_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MemoryPolicyDecision"
    ADD CONSTRAINT "MemoryPolicyDecision_candidate_scope_fkey"
    FOREIGN KEY ("candidateId", "representativeId")
    REFERENCES "MemoryCandidate"("id", "representativeId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MemoryPolicyDecision"
    ADD CONSTRAINT "MemoryPolicyDecision_memory_scope_fkey"
    FOREIGN KEY ("memoryId", "representativeId")
    REFERENCES "GovernedMemory"("id", "representativeId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MemoryPolicyDecision"
    ADD CONSTRAINT "MemoryPolicyDecision_result_scope_fkey"
    FOREIGN KEY ("resultVersionId", "memoryId", "representativeId")
    REFERENCES "GovernedMemoryVersion"("id", "memoryId", "representativeId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ContactMemorySharingConsent"
    ADD CONSTRAINT "ContactMemorySharingConsent_rep_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ContactMemorySharingConsent"
    ADD CONSTRAINT "ContactMemorySharingConsent_identity_fkey"
    FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "MemoryCandidate_identity_status_idx"
  ON "MemoryCandidate"(
    "representativeId", "audienceIdentityId", "status", "createdAt"
  );
CREATE INDEX IF NOT EXISTS "MemoryCandidate_rep_semantic_created_idx"
  ON "MemoryCandidate"("representativeId", "semanticKey", "createdAt");
CREATE INDEX IF NOT EXISTS "GovernedMemory_identity_scope_status_idx"
  ON "GovernedMemory"(
    "representativeId", "audienceIdentityId", "status", "updatedAt"
  );
CREATE INDEX IF NOT EXISTS "GovernedMemory_rep_semantic_updated_idx"
  ON "GovernedMemory"("representativeId", "semanticKey", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "GovernedMemory_contact_semantic_key"
  ON "GovernedMemory"(
    "representativeId", "contactId", "sourceChannel", "category", "semanticKey"
  )
  WHERE "scope" = 'CONTACT_CHANNEL' AND "semanticKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "GovernedMemory_shared_semantic_key"
  ON "GovernedMemory"(
    "representativeId", "audienceIdentityId", "category", "semanticKey"
  )
  WHERE "scope" = 'CONTACT_SHARED' AND "semanticKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "GovernedMemory_rep_semantic_key"
  ON "GovernedMemory"("representativeId", "category", "semanticKey")
  WHERE "scope" = 'REPRESENTATIVE' AND "semanticKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "MemoryPolicyDecision_rep_created_idx"
  ON "MemoryPolicyDecision"("representativeId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryPolicyDecision_candidate_rep_key"
  ON "MemoryPolicyDecision"("candidateId", "representativeId");
CREATE INDEX IF NOT EXISTS "MemoryPolicyDecision_memory_created_idx"
  ON "MemoryPolicyDecision"("memoryId", "createdAt");
CREATE INDEX IF NOT EXISTS "MemoryPolicyDecision_resultVersion_idx"
  ON "MemoryPolicyDecision"("resultVersionId");
CREATE INDEX IF NOT EXISTS "ContactMemorySharingConsent_identity_status_idx"
  ON "ContactMemorySharingConsent"(
    "audienceIdentityId", "status", "updatedAt"
  );
CREATE INDEX IF NOT EXISTS "ContactMemorySharingConsent_rep_identity_status_idx"
  ON "ContactMemorySharingConsent"(
    "representativeId", "audienceIdentityId", "status", "updatedAt"
  );

ALTER TABLE "MemoryCandidate"
  DROP CONSTRAINT IF EXISTS "MemoryCandidate_scope_check";
ALTER TABLE "MemoryCandidate"
  ADD CONSTRAINT "MemoryCandidate_scope_check" CHECK (
    (
      "scope" = 'CONTACT_CHANNEL'
      AND "contactId" IS NOT NULL
      AND "audienceIdentityId" IS NULL
      AND "scopeChannel" IS NOT NULL
      AND "category" IN (
        'CONTACT_PREFERENCE', 'CONTACT_GOAL',
        'CONTACT_CONSTRAINT', 'CONTACT_CONTEXT'
      )
    ) OR (
      "scope" = 'CONTACT_SHARED'
      AND "contactId" IS NULL
      AND "audienceIdentityId" IS NOT NULL
      AND "scopeChannel" IS NULL
      AND "category" IN (
        'CONTACT_PREFERENCE', 'CONTACT_GOAL',
        'CONTACT_CONSTRAINT', 'CONTACT_CONTEXT'
      )
    ) OR (
      "scope" = 'REPRESENTATIVE'
      AND "contactId" IS NULL
      AND "audienceIdentityId" IS NULL
      AND "scopeChannel" IS NULL
      AND "category" IN (
        'REPRESENTATIVE_RESPONSE_PATTERN',
        'REPRESENTATIVE_SERVICE_PATTERN',
        'REPRESENTATIVE_SAFETY_PATTERN',
        'REPRESENTATIVE_ROUTING_PATTERN'
      )
    )
  );

ALTER TABLE "GovernedMemory"
  DROP CONSTRAINT IF EXISTS "GovernedMemory_scope_check";
ALTER TABLE "GovernedMemory"
  ADD CONSTRAINT "GovernedMemory_scope_check" CHECK (
    (
      "scope" = 'CONTACT_CHANNEL'
      AND "contactId" IS NOT NULL
      AND "audienceIdentityId" IS NULL
      AND "sourceChannel" IS NOT NULL
      AND "category" IN (
        'CONTACT_PREFERENCE', 'CONTACT_GOAL',
        'CONTACT_CONSTRAINT', 'CONTACT_CONTEXT'
      )
    ) OR (
      "scope" = 'CONTACT_SHARED'
      AND "contactId" IS NULL
      AND "audienceIdentityId" IS NOT NULL
      AND "sourceChannel" IS NULL
      AND "category" IN (
        'CONTACT_PREFERENCE', 'CONTACT_GOAL',
        'CONTACT_CONSTRAINT', 'CONTACT_CONTEXT'
      )
    ) OR (
      "scope" = 'REPRESENTATIVE'
      AND "contactId" IS NULL
      AND "audienceIdentityId" IS NULL
      AND "sourceChannel" IS NULL
      AND "category" IN (
        'REPRESENTATIVE_RESPONSE_PATTERN',
        'REPRESENTATIVE_SERVICE_PATTERN',
        'REPRESENTATIVE_SAFETY_PATTERN',
        'REPRESENTATIVE_ROUTING_PATTERN'
      )
    )
  );

CREATE OR REPLACE FUNCTION "memory_policy_decision_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_record "MemoryCandidate"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
BEGIN
  SELECT * INTO candidate_record
    FROM "MemoryCandidate"
   WHERE "id" = NEW."candidateId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'MemoryPolicyDecision_candidate_scope_fkey',
      MESSAGE = 'automatic policy decision candidate does not exist';
  END IF;

  IF NEW."outcome" IN ('ACTIVATED', 'UPDATED', 'UNCHANGED', 'SKIPPED')
     AND candidate_record."status" <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_candidate_status_check',
      MESSAGE = 'automatic safe decision requires a pending candidate';
  END IF;
  IF NEW."outcome" = 'EVIDENCE_RECORDED'
     AND candidate_record."status" <> 'EXTRACTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_candidate_status_check',
      MESSAGE = 'representative evidence decision requires an extracted candidate';
  END IF;
  IF NEW."outcome" = 'BLOCKED'
     AND candidate_record."status" NOT IN ('PENDING_REVIEW', 'BLOCKED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_candidate_status_check',
      MESSAGE = 'blocked policy decision requires a blocked or pending candidate';
  END IF;
  IF NEW."outcome" = 'QUARANTINED'
     AND candidate_record."status" <> 'QUARANTINED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_candidate_status_check',
      MESSAGE = 'quarantine policy decision requires a quarantined candidate';
  END IF;

  IF NEW."outcome" IN ('EVIDENCE_RECORDED', 'ACTIVATED', 'UPDATED', 'UNCHANGED', 'SKIPPED')
     AND (
       candidate_record."contentPurgedAt" IS NOT NULL
       OR candidate_record."safeText" IS NULL
       OR candidate_record."summary" IS NULL
       OR candidate_record."contentHash" IS NULL
       OR candidate_record."contentHash" IS DISTINCT FROM NEW."outputHash"
       OR candidate_record."safetyClass" <> 'LOW_RISK'
       OR candidate_record."semanticKey" IS NULL
       OR (
         candidate_record."scope" = 'REPRESENTATIVE'
         AND candidate_record."deidentifiedAt" IS NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_safe_payload_check',
      MESSAGE = 'automatic activation accepts only complete low-risk structured output';
  END IF;

  IF NEW."resultVersionId" IS NOT NULL THEN
    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."resultVersionId"
       AND "memoryId" = NEW."memoryId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;
    IF NOT FOUND OR version_record."contentHash" IS DISTINCT FROM NEW."outputHash" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryPolicyDecision_result_integrity_check',
        MESSAGE = 'automatic policy result version does not match the output hash';
    END IF;
  END IF;
  IF NEW."outcome" IN ('ACTIVATED', 'UPDATED')
     AND version_record."sourceCandidateId" IS DISTINCT FROM NEW."candidateId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_result_candidate_check',
      MESSAGE = 'activated or updated version must be owned by its candidate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryPolicyDecision_guard" ON "MemoryPolicyDecision";
CREATE TRIGGER "MemoryPolicyDecision_guard"
  BEFORE INSERT ON "MemoryPolicyDecision"
  FOR EACH ROW EXECUTE FUNCTION "memory_policy_decision_guard"();

CREATE OR REPLACE FUNCTION "memory_policy_decision_append_only_guard"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'MemoryPolicyDecision_append_only_check',
    MESSAGE = 'automatic memory policy decisions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryPolicyDecision_append_only_guard"
  ON "MemoryPolicyDecision";
CREATE TRIGGER "MemoryPolicyDecision_append_only_guard"
  BEFORE UPDATE OR DELETE ON "MemoryPolicyDecision"
  FOR EACH ROW EXECUTE FUNCTION "memory_policy_decision_append_only_guard"();

CREATE OR REPLACE FUNCTION "contact_memory_sharing_consent_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId"
    OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
    OR NEW."policyRevision" IS DISTINCT FROM OLD."policyRevision"
    OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
    OR NEW."proofHash" IS DISTINCT FROM OLD."proofHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR OLD."status" = 'REVOKED'
    OR NEW."status" NOT IN ('GRANTED', 'REVOKED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingConsent_immutable_check',
      MESSAGE = 'sharing consent proof is immutable after grant and revocation is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ContactMemorySharingConsent_guard"
  ON "ContactMemorySharingConsent";
CREATE TRIGGER "ContactMemorySharingConsent_guard"
  BEFORE UPDATE ON "ContactMemorySharingConsent"
  FOR EACH ROW EXECUTE FUNCTION "contact_memory_sharing_consent_guard"();

COMMIT;

BEGIN;

-- Preserve every T1 immutability rule while accepting either the historical
-- human decision or the new automatic policy decision for terminal states.
CREATE OR REPLACE FUNCTION "memory_candidate_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_locked BOOLEAN;
  controlled_purge BOOLEAN;
BEGIN
  PERFORM "memory_assert_channel_match"(
    NEW."sourceConversationId",
    NEW."originChannel",
    'MemoryCandidate_origin_channel_check'
  );

  IF TG_OP = 'UPDATE' THEN
    IF OLD."contentPurgedAt" IS NOT NULL
       AND (
         NEW."contentPurgedAt" IS DISTINCT FROM OLD."contentPurgedAt"
         OR NEW."safeText" IS NOT NULL
         OR NEW."summary" IS NOT NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_purge_irreversible_check',
        MESSAGE = 'purged candidate content cannot be restored or rewritten';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
         (OLD."status" = 'EXTRACTED' AND NEW."status" IN ('QUARANTINED', 'BLOCKED', 'PENDING_REVIEW'))
         OR (OLD."status" = 'PENDING_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED', 'BLOCKED', 'EXPIRED'))
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_state_transition_check',
        MESSAGE = 'invalid memory candidate state transition';
    END IF;

    IF OLD."status" = 'PENDING_REVIEW'
       AND NEW."status" IN ('APPROVED', 'REJECTED', 'BLOCKED')
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryReviewDecision"
          WHERE "candidateId" = OLD."id"
            AND "representativeId" = OLD."representativeId"
            AND "outcome"::TEXT = NEW."status"::TEXT
       )
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryPolicyDecision"
          WHERE "candidateId" = OLD."id"
            AND "representativeId" = OLD."representativeId"
            AND (
              (
                NEW."status" = 'APPROVED'
                AND "outcome" IN ('ACTIVATED', 'UPDATED', 'UNCHANGED')
              ) OR (
                NEW."status" = 'REJECTED'
                AND "outcome" = 'SKIPPED'
              ) OR (
                NEW."status" = 'BLOCKED'
                AND "outcome" = 'BLOCKED'
              )
            )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_terminal_decision_check',
        MESSAGE = 'candidate cannot enter a terminal state without an append-only decision';
    END IF;

    IF OLD."status" = 'PENDING_REVIEW'
       AND NEW."status" = 'APPROVED'
       AND (
         NEW."reviewedAt" IS NULL
         OR NEW."contentPurgedAt" IS NOT NULL
         OR NEW."safeText" IS NULL
         OR NEW."summary" IS NULL
         OR NEW."contentHash" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_approval_integrity_check',
        MESSAGE = 'accepted candidate must retain its complete sanitized payload';
    END IF;

    candidate_locked :=
      OLD."status" IN ('BLOCKED', 'APPROVED', 'REJECTED', 'EXPIRED')
      OR EXISTS (
        SELECT 1 FROM "GovernedMemoryVersion"
         WHERE "sourceCandidateId" = OLD."id"
      )
      OR EXISTS (
        SELECT 1 FROM "MemoryReviewDecision"
         WHERE "candidateId" = OLD."id"
           AND "outcome" IN ('APPROVED', 'REJECTED', 'BLOCKED')
      )
      OR EXISTS (
        SELECT 1 FROM "MemoryPolicyDecision"
         WHERE "candidateId" = OLD."id"
      );

    controlled_purge :=
      OLD."contentPurgedAt" IS NULL
      AND NEW."contentPurgedAt" IS NOT NULL
      AND NEW."safeText" IS NULL
      AND NEW."summary" IS NULL
      AND NEW."contentHash" IS NOT DISTINCT FROM OLD."contentHash";

    IF controlled_purge
       AND EXISTS (
         SELECT 1
           FROM "GovernedMemoryVersion" version_record
           JOIN "GovernedMemory" memory_record
             ON memory_record."id" = version_record."memoryId"
          WHERE version_record."sourceCandidateId" = OLD."id"
            AND memory_record."status" NOT IN ('DELETE_PENDING', 'DELETED')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_controlled_purge_check',
        MESSAGE = 'versioned candidate content can be purged only after recall is blocked for deletion';
    END IF;

    IF candidate_locked AND (
      NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."extractionRunId" IS DISTINCT FROM OLD."extractionRunId"
      OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
      OR NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId"
      OR NEW."scope" IS DISTINCT FROM OLD."scope"
      OR NEW."scopeChannel" IS DISTINCT FROM OLD."scopeChannel"
      OR NEW."originChannel" IS DISTINCT FROM OLD."originChannel"
      OR NEW."category" IS DISTINCT FROM OLD."category"
      OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
      OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
      OR NEW."semanticKey" IS DISTINCT FROM OLD."semanticKey"
      OR NEW."sourceContactId" IS DISTINCT FROM OLD."sourceContactId"
      OR NEW."sourceConversationId" IS DISTINCT FROM OLD."sourceConversationId"
      OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
      OR NEW."safetyClass" IS DISTINCT FROM OLD."safetyClass"
      OR NEW."safetyReasonCode" IS DISTINCT FROM OLD."safetyReasonCode"
      OR NEW."extractionReasonCode" IS DISTINCT FROM OLD."extractionReasonCode"
      OR NEW."deidentifiedAt" IS DISTINCT FROM OLD."deidentifiedAt"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR (
        NOT controlled_purge
        AND (
          NEW."safeText" IS DISTINCT FROM OLD."safeText"
          OR NEW."summary" IS DISTINCT FROM OLD."summary"
          OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
          OR NEW."contentPurgedAt" IS DISTINCT FROM OLD."contentPurgedAt"
        )
      )
      OR (
        OLD."reviewedAt" IS NOT NULL
        AND NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_locked_coordinates_check',
        MESSAGE = 'decided or versioned candidate provenance and content are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ACTIVE may now be authorized by an automatic policy decision. Legacy human
-- approvals remain a byte-for-byte compatible alternative.
CREATE OR REPLACE FUNCTION "governed_memory_active_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  candidate_record "MemoryCandidate"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM "MemoryCandidate"
   WHERE "correctionMemoryId" = NEW."id"
     AND "representativeId" = NEW."representativeId"
     AND "status" = 'PENDING_REVIEW'
   FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_pending_correction_check',
      MESSAGE = 'memory cannot become active while a legacy correction is pending';
  END IF;

  SELECT * INTO version_record
    FROM "GovernedMemoryVersion"
   WHERE "id" = NEW."currentVersionId"
     AND "memoryId" = NEW."id"
     AND "representativeId" = NEW."representativeId"
     AND "scope" = NEW."scope"
   FOR SHARE;
  SELECT * INTO candidate_record
    FROM "MemoryCandidate"
   WHERE "id" = version_record."sourceCandidateId"
     AND "representativeId" = NEW."representativeId"
     AND "scope" = NEW."scope"
   FOR SHARE;
  IF version_record."id" IS NULL
     OR version_record."purgedAt" IS NOT NULL
     OR candidate_record."id" IS NULL
     OR candidate_record."status" <> 'APPROVED'
     OR candidate_record."contentPurgedAt" IS NOT NULL
     OR candidate_record."safeText" IS NULL
     OR candidate_record."summary" IS NULL
     OR candidate_record."contentHash" IS NULL
     OR candidate_record."safeText" IS DISTINCT FROM version_record."safeText"
     OR candidate_record."summary" IS DISTINCT FROM version_record."summary"
     OR candidate_record."contentHash" IS DISTINCT FROM version_record."contentHash"
     OR candidate_record."category" IS DISTINCT FROM NEW."category"
     OR candidate_record."safetyClass" NOT IN ('LOW_RISK', 'REVIEW_REQUIRED')
     OR (candidate_record."expiresAt" IS NOT NULL AND candidate_record."expiresAt" <= CURRENT_TIMESTAMP)
     OR (NEW."expiresAt" IS NOT NULL AND NEW."expiresAt" <= CURRENT_TIMESTAMP)
     OR (
       NEW."scope" = 'REPRESENTATIVE'
       AND (
         candidate_record."deidentifiedAt" IS NULL
         OR version_record."deidentifiedAt" IS NULL
         OR version_record."deidentificationMethod" IS NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_version_check',
      MESSAGE = 'active memory requires an unexpired accepted sanitized current candidate';
  END IF;

  IF NEW."scope" = 'CONTACT_CHANNEL' AND (
    candidate_record."contactId" IS DISTINCT FROM NEW."contactId"
    OR candidate_record."scopeChannel" IS DISTINCT FROM NEW."sourceChannel"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_scope_check',
      MESSAGE = 'active contact memory coordinates differ from its candidate';
  END IF;
  IF NEW."scope" = 'CONTACT_SHARED' AND (
    candidate_record."audienceIdentityId" IS DISTINCT FROM NEW."audienceIdentityId"
    OR NEW."contactId" IS NOT NULL
    OR NEW."sourceChannel" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_scope_check',
      MESSAGE = 'shared contact memory requires one verified audience identity';
  END IF;

  PERFORM "memory_assert_audience_text_source"(
    candidate_record."sourceMessageId",
    candidate_record."sourceConversationId",
    'GovernedMemory_active_source_check'
  );
  PERFORM 1
    FROM "Conversation"
   WHERE "id" = candidate_record."sourceConversationId"
     AND "representativeId" = candidate_record."representativeId"
     AND "contactId" = candidate_record."sourceContactId"
     AND upper(btrim("sourceChannel")) = candidate_record."originChannel"::TEXT
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_source_coordinates_check',
      MESSAGE = 'active memory source conversation coordinates changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "MemoryReviewDecision"
     WHERE "resultVersionId" = NEW."currentVersionId"
       AND "candidateId" = candidate_record."id"
       AND "memoryId" = NEW."id"
       AND "representativeId" = NEW."representativeId"
       AND "outcome" = 'APPROVED'
  ) AND NOT EXISTS (
    SELECT 1 FROM "MemoryPolicyDecision"
     WHERE "resultVersionId" = NEW."currentVersionId"
       AND "candidateId" = candidate_record."id"
       AND "memoryId" = NEW."id"
       AND "representativeId" = NEW."representativeId"
       AND "outcome" IN ('ACTIVATED', 'UPDATED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_approved_version_check',
      MESSAGE = 'active memory requires a human or automatic acceptance decision';
  END IF;

  IF candidate_record."sourceKind" = 'OWNER_VERIFIED_CORRECTION' THEN
    IF candidate_record."correctionMemoryId" IS DISTINCT FROM NEW."id"
       OR candidate_record."correctionBaseVersionId" IS DISTINCT FROM version_record."supersedesVersionId"
       OR version_record."versionNumber" <= 1
       OR NOT EXISTS (
         SELECT 1 FROM "MemoryReviewDecision"
          WHERE "candidateId" = candidate_record."id"
            AND "memoryId" = NEW."id"
            AND "representativeId" = NEW."representativeId"
            AND "outcome" = 'CORRECTION_REQUESTED'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemory_active_correction_check',
        MESSAGE = 'legacy corrected memory requires its governed correction chain';
    END IF;
  ELSIF version_record."versionNumber" > 1 AND NOT EXISTS (
    SELECT 1 FROM "MemoryPolicyDecision"
     WHERE "resultVersionId" = version_record."id"
       AND "candidateId" = candidate_record."id"
       AND "memoryId" = NEW."id"
       AND "representativeId" = NEW."representativeId"
       AND "outcome" = 'UPDATED'
       AND version_record."supersedesVersionId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_correction_check',
      MESSAGE = 'subsequent active memory versions require a governed update chain';
  END IF;

  SELECT * INTO policy_record
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND OR NOT policy_record."longTermMemoryEnabled" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_policy_check',
      MESSAGE = 'long-term memory policy is disabled';
  END IF;
  IF NEW."scope" = 'CONTACT_CHANNEL' AND (
    NOT policy_record."contactMemoryEnabled"
    OR CASE NEW."sourceChannel"
      WHEN 'WEB' THEN NOT policy_record."webRecallEnabled"
      WHEN 'MATRIX' THEN NOT policy_record."matrixRecallEnabled"
      WHEN 'TELEGRAM' THEN NOT policy_record."telegramRecallEnabled"
      ELSE TRUE
    END
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_policy_check',
      MESSAGE = 'contact memory policy or channel recall is disabled';
  END IF;
  IF NEW."scope" = 'REPRESENTATIVE'
     AND NOT policy_record."representativeExperienceEnabled" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_policy_check',
      MESSAGE = 'representative experience policy is disabled';
  END IF;
  IF NEW."scope" = 'CONTACT_SHARED' AND (
    NOT policy_record."contactMemoryEnabled"
    OR NOT policy_record."contactMemoryCrossChannelEnabled"
    OR NOT EXISTS (
      SELECT 1
        FROM "AudienceIdentity" identity_record
        JOIN "ContactMemorySharingConsent" consent
          ON consent."audienceIdentityId" = identity_record."id"
         AND consent."representativeId" = NEW."representativeId"
       WHERE identity_record."id" = NEW."audienceIdentityId"
         AND identity_record."status" = 'REGISTERED'
         AND identity_record."mergedIntoId" IS NULL
         AND consent."status" = 'GRANTED'
         AND consent."revokedAt" IS NULL
         AND consent."policyRevision" = policy_record."revision"
         AND EXISTS (
           SELECT 1 FROM "IdentityLink" identity_link
            WHERE identity_link."audienceIdentityId" = identity_record."id"
              AND identity_link."verifiedAt" IS NOT NULL
              AND identity_link."revokedAt" IS NULL
              AND identity_link."assuranceLevel" IN (
                'PLATFORM_VERIFIED', 'STEP_UP_VERIFIED'
              )
         )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_shared_consent_check',
      MESSAGE = 'shared contact memory requires current explicit verified consent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "governed_memory_coordinates_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "GovernedMemoryVersion" WHERE "memoryId" = OLD."id"
  ) AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
    OR NEW."audienceIdentityId" IS DISTINCT FROM OLD."audienceIdentityId"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."semanticKey" IS DISTINCT FROM OLD."semanticKey"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_locked_coordinates_check',
      MESSAGE = 'versioned memory scope and semantic coordinates are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
