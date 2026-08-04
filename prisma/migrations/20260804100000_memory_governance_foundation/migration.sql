-- Memory System T4: correction coordinates, final approval/activation fences,
-- durable deletion cleanup state, and governance audit event types.
-- PostgreSQL remains the business authority; this migration only tightens
-- existing T1/T3 boundaries and is safe to rehearse more than once.

BEGIN;

DO $$
BEGIN
  CREATE TYPE "MemoryCleanupStatus" AS ENUM (
    'QUEUED',
    'RUNNING',
    'RETRYING',
    'FAILED',
    'SUCCEEDED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_CANDIDATE_APPROVED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_CANDIDATE_REJECTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_CANDIDATE_BLOCKED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_CORRECTION_REQUESTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_STATUS_CHANGED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_DELETION_REQUESTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MEMORY_CLEANUP_RETRY_REQUESTED';

ALTER TABLE "MemoryCandidate"
  ADD COLUMN IF NOT EXISTS "correctionMemoryId" TEXT,
  ADD COLUMN IF NOT EXISTS "correctionBaseVersionId" TEXT;

ALTER TABLE "MemoryDeletionProof"
  ADD COLUMN IF NOT EXISTS "cleanupStatus" "MemoryCleanupStatus" NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'GovernedMemoryVersion_id_memory_rep_scope_key'
       AND conrelid = '"GovernedMemoryVersion"'::regclass
  ) THEN
    ALTER TABLE "GovernedMemoryVersion"
      ADD CONSTRAINT "GovernedMemoryVersion_id_memory_rep_scope_key"
      UNIQUE ("id", "memoryId", "representativeId", "scope");
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryCandidate_correction_coordinates_check'
       AND conrelid = '"MemoryCandidate"'::regclass
  ) THEN
    ALTER TABLE "MemoryCandidate"
      ADD CONSTRAINT "MemoryCandidate_correction_coordinates_check" CHECK (
        (
          "sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
          AND "correctionMemoryId" IS NOT NULL
          AND "correctionBaseVersionId" IS NOT NULL
          AND "extractionRunId" IS NULL
        ) OR (
          "sourceKind" <> 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
          AND "correctionMemoryId" IS NULL
          AND "correctionBaseVersionId" IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryCandidate_correction_memory_scope_fkey'
       AND conrelid = '"MemoryCandidate"'::regclass
  ) THEN
    ALTER TABLE "MemoryCandidate"
      ADD CONSTRAINT "MemoryCandidate_correction_memory_scope_fkey"
      FOREIGN KEY ("correctionMemoryId", "representativeId", "scope")
      REFERENCES "GovernedMemory"("id", "representativeId", "scope")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryCandidate_correction_base_scope_fkey'
       AND conrelid = '"MemoryCandidate"'::regclass
  ) THEN
    ALTER TABLE "MemoryCandidate"
      ADD CONSTRAINT "MemoryCandidate_correction_base_scope_fkey"
      FOREIGN KEY (
        "correctionBaseVersionId", "correctionMemoryId",
        "representativeId", "scope"
      ) REFERENCES "GovernedMemoryVersion"(
        "id", "memoryId", "representativeId", "scope"
      ) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryReviewDecision_correction_request_check'
       AND conrelid = '"MemoryReviewDecision"'::regclass
  ) THEN
    ALTER TABLE "MemoryReviewDecision"
      ADD CONSTRAINT "MemoryReviewDecision_correction_request_check" CHECK (
        "outcome" <> 'CORRECTION_REQUESTED'::"MemoryReviewOutcome"
        OR (
          "candidateId" IS NOT NULL
          AND "memoryId" IS NOT NULL
          AND "resultVersionId" IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryDeletionProof_cleanup_coordinates_check'
       AND conrelid = '"MemoryDeletionProof"'::regclass
  ) THEN
    ALTER TABLE "MemoryDeletionProof"
      ADD CONSTRAINT "MemoryDeletionProof_cleanup_coordinates_check" CHECK (
        "attemptCount" >= 0
        AND (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
        AND (
          ("cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus" AND "leaseToken" IS NOT NULL)
          OR ("cleanupStatus" <> 'RUNNING'::"MemoryCleanupStatus" AND "leaseToken" IS NULL)
        )
        AND (
          "lastErrorCode" IS NULL
          OR btrim("lastErrorCode") <> ''
        )
        AND (
          "cleanupStatus" NOT IN (
            'RETRYING'::"MemoryCleanupStatus",
            'FAILED'::"MemoryCleanupStatus"
          )
          OR "lastErrorCode" IS NOT NULL
        )
        AND (
          "cleanupStatus" <> 'SUCCEEDED'::"MemoryCleanupStatus"
          OR (
            "localPurgeCompletedAt" IS NOT NULL
            AND "remotePurgeCompletedAt" IS NOT NULL
            AND "proofHash" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "lastErrorCode" IS NULL
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryDeletionProof_command_code_check'
       AND conrelid = '"MemoryDeletionProof"'::regclass
  ) THEN
    ALTER TABLE "MemoryDeletionProof"
      ADD CONSTRAINT "MemoryDeletionProof_command_code_check" CHECK (
        char_length("requestId") BETWEEN 1 AND 191
        AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'
        AND char_length("reasonCode") BETWEEN 1 AND 128
        AND "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryReviewDecision_reason_code_check'
       AND conrelid = '"MemoryReviewDecision"'::regclass
  ) THEN
    ALTER TABLE "MemoryReviewDecision"
      ADD CONSTRAINT "MemoryReviewDecision_reason_code_check" CHECK (
        char_length("reasonCode") BETWEEN 1 AND 128
        AND "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCandidate_one_pending_correction_key"
  ON "MemoryCandidate"("correctionMemoryId")
  WHERE "correctionMemoryId" IS NOT NULL
    AND "status" = 'PENDING_REVIEW'::"MemoryCandidateStatus";

CREATE INDEX IF NOT EXISTS "MemoryCandidate_correction_pending_idx"
  ON "MemoryCandidate"("correctionMemoryId", "status", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "MemoryReviewDecision_one_correction_request_key"
  ON "MemoryReviewDecision"("candidateId")
  WHERE "candidateId" IS NOT NULL
    AND "outcome" = 'CORRECTION_REQUESTED'::"MemoryReviewOutcome";

CREATE INDEX IF NOT EXISTS "MemoryDeletionProof_cleanup_due_idx"
  ON "MemoryDeletionProof"("cleanupStatus", "availableAt", "leaseExpiresAt");

-- Correction coordinates are established at candidate creation and never
-- rewritten. This extends, rather than replaces, the T1 candidate coordinate
-- lock and leaves the T3 source-message guard installed independently.
CREATE OR REPLACE FUNCTION "memory_candidate_correction_guard"() RETURNS TRIGGER AS $$
DECLARE
  memory_record "GovernedMemory"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW."correctionMemoryId" IS DISTINCT FROM OLD."correctionMemoryId"
       OR NEW."correctionBaseVersionId" IS DISTINCT FROM OLD."correctionBaseVersionId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryCandidate_locked_coordinates_check',
      MESSAGE = 'memory correction coordinates are immutable';
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW."sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
     AND NEW."status" <> 'PENDING_REVIEW'::"MemoryCandidateStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryCandidate_correction_initial_state_check',
      MESSAGE = 'new correction candidate must start pending review';
  END IF;

  IF NEW."sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
     AND NEW."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus" THEN
    -- Correction, restore, and deletion all serialize on the parent memory.
    -- The service suppresses before inserting, so a direct insert can never
    -- leave ACTIVE and a pending correction true at the same time.
    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = NEW."correctionMemoryId"
       AND "representativeId" = NEW."representativeId"
       AND "scope" = NEW."scope"
     FOR SHARE;

    IF NOT FOUND
       OR memory_record."status" <> 'SUPPRESSED'::"GovernedMemoryStatus"
       OR memory_record."currentVersionId" IS DISTINCT FROM NEW."correctionBaseVersionId"
       OR memory_record."deleteRequestedAt" IS NOT NULL
       OR EXISTS (
         SELECT 1
           FROM "MemoryDeletionProof"
          WHERE "memoryId" = NEW."correctionMemoryId"
            AND "representativeId" = NEW."representativeId"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_correction_parent_state_check',
        MESSAGE = 'pending correction requires its current suppressed non-deleting memory';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryCandidate_correction_guard" ON "MemoryCandidate";
CREATE TRIGGER "MemoryCandidate_correction_guard"
  BEFORE INSERT OR UPDATE ON "MemoryCandidate"
  FOR EACH ROW EXECUTE FUNCTION "memory_candidate_correction_guard"();

-- EventAudit is shared with non-memory workflows, so constrain only T4
-- governance events. Command identifiers stay opaque and cannot become a
-- second storage path for notes or message text.
CREATE OR REPLACE FUNCTION "memory_governance_audit_command_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."type"::TEXT IN (
    'MEMORY_CANDIDATE_APPROVED',
    'MEMORY_CANDIDATE_REJECTED',
    'MEMORY_CANDIDATE_BLOCKED',
    'MEMORY_CORRECTION_REQUESTED',
    'MEMORY_STATUS_CHANGED',
    'MEMORY_DELETION_REQUESTED',
    'MEMORY_CLEANUP_RETRY_REQUESTED'
  ) AND (
    NEW."idempotencyKey" IS NULL
    OR NEW."idempotencyKey" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'
    OR NEW."payload"->>'requestId' IS NULL
    OR NEW."payload"->>'requestId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'
    OR NEW."payload"->>'reasonCode' IS NULL
    OR NEW."payload"->>'reasonCode' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'EventAudit_memory_command_code_check',
      MESSAGE = 'memory governance audit identifiers must be opaque ASCII command tokens';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "EventAudit_memory_command_guard" ON "EventAudit";
CREATE TRIGGER "EventAudit_memory_command_guard"
  BEFORE INSERT OR UPDATE ON "EventAudit"
  FOR EACH ROW EXECUTE FUNCTION "memory_governance_audit_command_guard"();

-- Approval is the last local trust boundary before a version can become
-- active. Re-lock and revalidate both the candidate and its source rather than
-- trusting facts observed when extraction first ran.
CREATE OR REPLACE FUNCTION "memory_review_result_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_record "MemoryCandidate"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
BEGIN
  IF NEW."outcome" IN (
    'APPROVED'::"MemoryReviewOutcome",
    'REJECTED'::"MemoryReviewOutcome",
    'BLOCKED'::"MemoryReviewOutcome",
    'CORRECTION_REQUESTED'::"MemoryReviewOutcome"
  ) THEN
    SELECT * INTO candidate_record
      FROM "MemoryCandidate"
     WHERE "id" = NEW."candidateId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;

    IF NOT FOUND
       OR candidate_record."status" <> 'PENDING_REVIEW'::"MemoryCandidateStatus" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_status_check',
        MESSAGE = 'review can be recorded only for a pending candidate';
    END IF;
  END IF;

  IF NEW."outcome" = 'CORRECTION_REQUESTED'::"MemoryReviewOutcome" THEN
    IF candidate_record."sourceKind" <> 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
       OR candidate_record."correctionMemoryId" IS DISTINCT FROM NEW."memoryId"
       OR candidate_record."correctionBaseVersionId" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_correction_coordinates_check',
        MESSAGE = 'correction request must identify its pending correction candidate and memory';
    END IF;

    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = NEW."memoryId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;

    IF NOT FOUND
       OR memory_record."currentVersionId" IS DISTINCT FROM candidate_record."correctionBaseVersionId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_correction_base_current_check',
        MESSAGE = 'correction request base is no longer the governed memory current version';
    END IF;
  END IF;

  IF NEW."outcome" = 'APPROVED'::"MemoryReviewOutcome" THEN
    PERFORM "memory_assert_audience_text_source"(
      candidate_record."sourceMessageId",
      candidate_record."sourceConversationId",
      'MemoryReviewDecision_audience_text_source_check'
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
        CONSTRAINT = 'MemoryReviewDecision_source_coordinates_check',
        MESSAGE = 'approved candidate source conversation coordinates changed';
    END IF;

    IF candidate_record."expiresAt" IS NOT NULL
       AND candidate_record."expiresAt" <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_expired_check',
        MESSAGE = 'expired memory candidate cannot be approved';
    END IF;

    IF candidate_record."contentPurgedAt" IS NOT NULL
       OR candidate_record."safeText" IS NULL
       OR candidate_record."summary" IS NULL
       OR candidate_record."contentHash" IS NULL
       OR candidate_record."safetyClass" NOT IN (
         'LOW_RISK'::"MemorySafetyClass",
         'REVIEW_REQUIRED'::"MemorySafetyClass"
       )
       OR (
         candidate_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
         AND candidate_record."deidentifiedAt" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_reviewable_check',
        MESSAGE = 'approved candidate must remain sanitized, reviewable, and deidentified when required';
    END IF;

    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."resultVersionId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryReviewDecision_result_scope_fkey',
        MESSAGE = 'approved memory version does not exist';
    END IF;

    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = NEW."memoryId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryReviewDecision_memory_scope_fkey',
        MESSAGE = 'approved governed memory does not exist';
    END IF;

    IF version_record."sourceCandidateId" IS DISTINCT FROM NEW."candidateId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_result_check',
        MESSAGE = 'approved candidate does not own the resulting memory version';
    END IF;

    IF candidate_record."contentHash" !~ '^[0-9a-f]{64}$'
       OR version_record."purgedAt" IS NOT NULL
       OR candidate_record."safeText" IS DISTINCT FROM version_record."safeText"
       OR candidate_record."summary" IS DISTINCT FROM version_record."summary"
       OR candidate_record."contentHash" IS DISTINCT FROM version_record."contentHash"
       OR candidate_record."category" IS DISTINCT FROM memory_record."category"
       OR candidate_record."scope" IS DISTINCT FROM version_record."scope"
       OR candidate_record."scope" IS DISTINCT FROM memory_record."scope"
       OR candidate_record."representativeId" IS DISTINCT FROM version_record."representativeId"
       OR candidate_record."representativeId" IS DISTINCT FROM memory_record."representativeId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_content_integrity_check',
        MESSAGE = 'approved candidate, version, and memory content coordinates differ';
    END IF;

    IF candidate_record."sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind" THEN
      IF candidate_record."correctionMemoryId" IS DISTINCT FROM memory_record."id"
         OR candidate_record."correctionBaseVersionId" IS DISTINCT FROM memory_record."currentVersionId"
         OR version_record."supersedesVersionId" IS DISTINCT FROM candidate_record."correctionBaseVersionId"
         OR version_record."versionNumber" <= 1
         OR NOT EXISTS (
           SELECT 1
             FROM "MemoryReviewDecision"
            WHERE "candidateId" = candidate_record."id"
              AND "memoryId" = memory_record."id"
              AND "representativeId" = memory_record."representativeId"
              AND "outcome" = 'CORRECTION_REQUESTED'::"MemoryReviewOutcome"
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryReviewDecision_correction_base_current_check',
          MESSAGE = 'correction approval requires its requested base to remain current';
      END IF;
    ELSIF version_record."versionNumber" > 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_correction_coordinates_check',
        MESSAGE = 'subsequent memory versions require governed correction coordinates';
    END IF;

    IF version_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
       AND (
         NEW."reviewerActorId" = version_record."createdByActorId"
         OR version_record."deidentifiedAt" IS NULL
         OR version_record."deidentificationMethod" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_independent_review_check',
        MESSAGE = 'representative experience requires deidentification and an independent reviewer';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ACTIVE is an allowlisted state, not a historical approval bit. Every
-- activation and restore rechecks source, expiry, policy, and approved-current
-- version coordinates under shared locks.
CREATE OR REPLACE FUNCTION "governed_memory_active_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  candidate_record "MemoryCandidate"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'ACTIVE'::"GovernedMemoryStatus" THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM "MemoryCandidate"
   WHERE "correctionMemoryId" = NEW."id"
     AND "representativeId" = NEW."representativeId"
     AND "status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
   FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_pending_correction_check',
      MESSAGE = 'memory cannot become active while a correction is pending review';
  END IF;

  SELECT * INTO version_record
    FROM "GovernedMemoryVersion"
   WHERE "id" = NEW."currentVersionId"
     AND "memoryId" = NEW."id"
     AND "representativeId" = NEW."representativeId"
     AND "scope" = NEW."scope"
   FOR SHARE;
  IF NOT FOUND OR version_record."purgedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_version_check',
      MESSAGE = 'active memory requires its current unpurged version';
  END IF;

  SELECT * INTO candidate_record
    FROM "MemoryCandidate"
   WHERE "id" = version_record."sourceCandidateId"
     AND "representativeId" = NEW."representativeId"
     AND "scope" = NEW."scope"
   FOR SHARE;
  IF NOT FOUND
     OR candidate_record."status" <> 'APPROVED'::"MemoryCandidateStatus"
     OR candidate_record."contentPurgedAt" IS NOT NULL
     OR candidate_record."safeText" IS NULL
     OR candidate_record."summary" IS NULL
     OR candidate_record."contentHash" IS NULL
     OR candidate_record."safeText" IS DISTINCT FROM version_record."safeText"
     OR candidate_record."summary" IS DISTINCT FROM version_record."summary"
     OR candidate_record."contentHash" IS DISTINCT FROM version_record."contentHash"
     OR candidate_record."category" IS DISTINCT FROM NEW."category"
     OR candidate_record."safetyClass" NOT IN (
       'LOW_RISK'::"MemorySafetyClass",
       'REVIEW_REQUIRED'::"MemorySafetyClass"
     )
     OR (
       candidate_record."expiresAt" IS NOT NULL
       AND candidate_record."expiresAt" <= CURRENT_TIMESTAMP
     )
     OR (NEW."expiresAt" IS NOT NULL AND NEW."expiresAt" <= CURRENT_TIMESTAMP)
     OR (
       NEW."scope" = 'REPRESENTATIVE'::"MemoryScope"
       AND (
         candidate_record."deidentifiedAt" IS NULL
         OR version_record."deidentifiedAt" IS NULL
         OR version_record."deidentificationMethod" IS NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_version_check',
      MESSAGE = 'active memory requires an unexpired approved sanitized current candidate';
  END IF;

  IF NEW."scope" = 'CONTACT_CHANNEL'::"MemoryScope" AND (
    candidate_record."contactId" IS DISTINCT FROM NEW."contactId"
    OR candidate_record."scopeChannel" IS DISTINCT FROM NEW."sourceChannel"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_scope_check',
      MESSAGE = 'active contact memory coordinates differ from its approved candidate';
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
    SELECT 1
      FROM "MemoryReviewDecision"
     WHERE "resultVersionId" = NEW."currentVersionId"
       AND "candidateId" = candidate_record."id"
       AND "memoryId" = NEW."id"
       AND "representativeId" = NEW."representativeId"
       AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_approved_version_check',
      MESSAGE = 'active memory requires an approved current version';
  END IF;

  IF candidate_record."sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind" THEN
    IF candidate_record."correctionMemoryId" IS DISTINCT FROM NEW."id"
       OR candidate_record."correctionBaseVersionId" IS DISTINCT FROM version_record."supersedesVersionId"
       OR version_record."versionNumber" <= 1
       OR NOT EXISTS (
         SELECT 1
           FROM "MemoryReviewDecision"
          WHERE "candidateId" = candidate_record."id"
            AND "memoryId" = NEW."id"
            AND "representativeId" = NEW."representativeId"
            AND "outcome" = 'CORRECTION_REQUESTED'::"MemoryReviewOutcome"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemory_active_correction_check',
        MESSAGE = 'active corrected memory requires its governed correction chain';
    END IF;
  ELSIF version_record."versionNumber" > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_correction_check',
      MESSAGE = 'subsequent active memory versions require governed correction coordinates';
  END IF;

  SELECT * INTO policy_record
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND
     OR NOT policy_record."longTermMemoryEnabled"
     OR (
       NEW."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
       AND (
         NOT policy_record."contactMemoryEnabled"
         OR CASE NEW."sourceChannel"
           WHEN 'WEB'::"RepresentativeChannelKind" THEN NOT policy_record."webRecallEnabled"
           WHEN 'MATRIX'::"RepresentativeChannelKind" THEN NOT policy_record."matrixRecallEnabled"
           WHEN 'TELEGRAM'::"RepresentativeChannelKind" THEN NOT policy_record."telegramRecallEnabled"
         END
       )
     )
     OR (
       NEW."scope" = 'REPRESENTATIVE'::"MemoryScope"
       AND NOT policy_record."representativeExperienceEnabled"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_active_policy_check',
      MESSAGE = 'memory policy does not allow this governed memory scope';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Pending corrections are not versions yet, so the T1 proof guard's
-- version/source-candidate join cannot see them. Lock the parent and fence
-- those candidates explicitly before any proof can be created or completed.
CREATE OR REPLACE FUNCTION "memory_deletion_proof_correction_guard"() RETURNS TRIGGER AS $$
DECLARE
  local_purge_transition BOOLEAN;
  completed_transition BOOLEAN;
BEGIN
  local_purge_transition := NEW."localPurgeCompletedAt" IS NOT NULL AND TG_OP = 'INSERT';
  completed_transition := NEW."completedAt" IS NOT NULL AND TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    local_purge_transition :=
      NEW."localPurgeCompletedAt" IS NOT NULL
      AND OLD."localPurgeCompletedAt" IS NULL;
    completed_transition :=
      NEW."completedAt" IS NOT NULL
      AND OLD."completedAt" IS NULL;
  END IF;

  PERFORM 1
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_memory_blocked_check',
      MESSAGE = 'deletion proof requires its governed memory';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "MemoryCandidate"
     WHERE "correctionMemoryId" = NEW."memoryId"
       AND "representativeId" = NEW."representativeId"
       AND "status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_pending_correction_check',
      MESSAGE = 'deletion proof cannot advance while a correction is pending';
  END IF;

  IF (local_purge_transition OR completed_transition) AND EXISTS (
    SELECT 1
      FROM "MemoryCandidate"
     WHERE "correctionMemoryId" = NEW."memoryId"
       AND "representativeId" = NEW."representativeId"
       AND (
         "contentPurgedAt" IS NULL
         OR "safeText" IS NOT NULL
         OR "summary" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_correction_content_purged_check',
      MESSAGE = 'local purge cannot complete while correction candidate content remains';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryDeletionProof_correction_guard" ON "MemoryDeletionProof";
CREATE TRIGGER "MemoryDeletionProof_correction_guard"
  BEFORE INSERT OR UPDATE ON "MemoryDeletionProof"
  FOR EACH ROW EXECUTE FUNCTION "memory_deletion_proof_correction_guard"();

-- Cleanup metadata is a durable lease-backed command. The existing T1 proof
-- guard still validates content and remote purge evidence; this guard only
-- adds orchestration state and never weakens proof irreversibility.
CREATE OR REPLACE FUNCTION "memory_deletion_cleanup_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."cleanupStatus" <> 'QUEUED'::"MemoryCleanupStatus"
       OR NEW."attemptCount" <> 0
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."lastErrorCode" IS NOT NULL
       OR NEW."localPurgeCompletedAt" IS NOT NULL
       OR NEW."remotePurgeCompletedAt" IS NOT NULL
       OR NEW."proofHash" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_cleanup_initial_state_check',
        MESSAGE = 'new memory cleanup must start queued without purge completion evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."cleanupStatus" = 'SUCCEEDED'::"MemoryCleanupStatus"
     AND (to_jsonb(NEW) - 'updatedAt') <> (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_terminal_check',
      MESSAGE = 'succeeded memory cleanup is terminal';
  END IF;

  IF NEW."cleanupStatus" IS DISTINCT FROM OLD."cleanupStatus" AND NOT (
    (OLD."cleanupStatus" = 'QUEUED' AND NEW."cleanupStatus" = 'RUNNING')
    OR (OLD."cleanupStatus" = 'RUNNING' AND NEW."cleanupStatus" IN ('RETRYING', 'FAILED', 'SUCCEEDED'))
    OR (OLD."cleanupStatus" = 'RETRYING' AND NEW."cleanupStatus" IN ('RUNNING', 'FAILED'))
    OR (OLD."cleanupStatus" = 'FAILED' AND NEW."cleanupStatus" = 'QUEUED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_transition_check',
      MESSAGE = 'invalid memory deletion cleanup state transition';
  END IF;

  IF NEW."cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
     AND OLD."cleanupStatus" <> 'RUNNING'::"MemoryCleanupStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount" + 1
       OR NEW."leaseToken" IS NULL
       OR NEW."leaseExpiresAt" IS NULL
       OR NEW."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."lastErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_cleanup_claim_check',
        MESSAGE = 'cleanup claim requires one new attempt and a live lease';
    END IF;
  ELSIF NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_attempt_check',
      MESSAGE = 'cleanup attempt count changes only when work is claimed';
  END IF;

  IF OLD."cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
     AND NEW."cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
     AND (
       NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
       OR NEW."leaseExpiresAt" < OLD."leaseExpiresAt"
       OR NEW."lastErrorCode" IS DISTINCT FROM OLD."lastErrorCode"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_lease_check',
      MESSAGE = 'running cleanup may only extend its current lease';
  END IF;

  IF (
       NEW."localPurgeCompletedAt" IS DISTINCT FROM OLD."localPurgeCompletedAt"
       OR NEW."remotePurgeCompletedAt" IS DISTINCT FROM OLD."remotePurgeCompletedAt"
       OR NEW."providerReceiptHash" IS DISTINCT FROM OLD."providerReceiptHash"
       OR NEW."proofHash" IS DISTINCT FROM OLD."proofHash"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
     )
     AND OLD."cleanupStatus" <> 'RUNNING'::"MemoryCleanupStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_worker_state_check',
      MESSAGE = 'purge evidence can advance only from a claimed cleanup';
  END IF;

  IF OLD."completedAt" IS NULL
     AND NEW."completedAt" IS NOT NULL
     AND NEW."cleanupStatus" <> 'SUCCEEDED'::"MemoryCleanupStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_completion_state_check',
      MESSAGE = 'completed deletion proof must finish the cleanup state machine';
  END IF;

  IF NEW."cleanupStatus" IN (
       'RETRYING'::"MemoryCleanupStatus",
       'FAILED'::"MemoryCleanupStatus"
     ) AND (
       NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."lastErrorCode" IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_failure_check',
      MESSAGE = 'failed cleanup attempt must release its lease and retain a stable error code';
  END IF;

  IF NEW."cleanupStatus" = 'QUEUED'::"MemoryCleanupStatus"
     AND (NEW."leaseToken" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_queue_check',
      MESSAGE = 'queued cleanup cannot retain a worker lease';
  END IF;

  IF NEW."cleanupStatus" = 'SUCCEEDED'::"MemoryCleanupStatus" AND (
    OLD."cleanupStatus" <> 'RUNNING'::"MemoryCleanupStatus"
    OR NEW."leaseToken" IS NOT NULL
    OR NEW."leaseExpiresAt" IS NOT NULL
    OR NEW."lastErrorCode" IS NOT NULL
    OR NEW."localPurgeCompletedAt" IS NULL
    OR NEW."remotePurgeCompletedAt" IS NULL
    OR NEW."proofHash" IS NULL
    OR NEW."completedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_cleanup_success_check',
      MESSAGE = 'successful cleanup requires a complete proof and a released lease';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryDeletionProof_cleanup_guard" ON "MemoryDeletionProof";
CREATE TRIGGER "MemoryDeletionProof_cleanup_guard"
  BEFORE INSERT OR UPDATE ON "MemoryDeletionProof"
  FOR EACH ROW EXECUTE FUNCTION "memory_deletion_cleanup_guard"();

CREATE OR REPLACE FUNCTION "governed_memory_cleanup_completion_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
     AND NEW."status" = 'DELETED'::"GovernedMemoryStatus"
     AND NOT EXISTS (
       SELECT 1
         FROM "MemoryDeletionProof"
        WHERE "memoryId" = NEW."id"
          AND "representativeId" = NEW."representativeId"
          AND "cleanupStatus" = 'SUCCEEDED'::"MemoryCleanupStatus"
          AND "completedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_deleted_cleanup_check',
      MESSAGE = 'governed memory cannot be deleted before cleanup succeeds';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GovernedMemory_cleanup_completion_guard" ON "GovernedMemory";
CREATE TRIGGER "GovernedMemory_cleanup_completion_guard"
  BEFORE UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_cleanup_completion_guard"();

COMMIT;
