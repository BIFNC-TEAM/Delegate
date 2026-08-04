-- Memory System T3: PostgreSQL is the final trust boundary for extraction
-- provenance. Only an untouched audience text message may seed a run or a
-- candidate. Message edits/redactions synchronously invalidate unfinished
-- work without weakening the T1 lifecycle guard.

BEGIN;

-- Serialize the one-time cleanup with message, extraction, and candidate
-- writers. Runtime enforcement remains row-level after this transaction.
LOCK TABLE "Message", "MemoryExtractionRun", "MemoryCandidate",
  "GovernedMemoryVersion", "GovernedMemory"
  IN SHARE ROW EXCLUSIVE MODE;

-- Make a repeated rehearsal behave like the first run: cleanup occurs before
-- the new source triggers are re-installed at the end of the transaction.
DROP TRIGGER IF EXISTS "MemoryExtractionRun_source_guard" ON "MemoryExtractionRun";
DROP TRIGGER IF EXISTS "MemoryCandidate_source_guard" ON "MemoryCandidate";
DROP TRIGGER IF EXISTS "Message_memory_mark_edit" ON "Message";
DROP TRIGGER IF EXISTS "Message_memory_source_invalidation" ON "Message";

CREATE OR REPLACE FUNCTION "memory_source_invalidation_reason"(
  source_message_id TEXT,
  source_conversation_id TEXT
) RETURNS TEXT AS $$
DECLARE
  source_record "Message"%ROWTYPE;
BEGIN
  SELECT * INTO source_record
    FROM "Message"
   WHERE "id" = source_message_id
     AND "conversationId" = source_conversation_id;

  IF NOT FOUND THEN
    RETURN 'source_message_ineligible';
  END IF;

  IF source_record."redactedAt" IS NOT NULL
     OR source_record."deliveryStatus" = 'REDACTED'::"MessageDeliveryStatus" THEN
    RETURN 'source_message_redacted';
  END IF;

  IF source_record."editedAt" IS NOT NULL
     OR source_record."deliveryStatus" = 'EDITED'::"MessageDeliveryStatus" THEN
    RETURN 'source_message_edited';
  END IF;

  IF source_record."senderType" <> 'AUDIENCE'::"MessageSenderType"
     OR source_record."contentType" <> 'TEXT'::"MessageContentType"
     OR source_record."text" IS NULL
     OR btrim(source_record."text") = '' THEN
    RETURN 'source_message_ineligible';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "memory_assert_audience_text_source"(
  source_message_id TEXT,
  source_conversation_id TEXT,
  constraint_name TEXT
) RETURNS VOID AS $$
DECLARE
  invalidation_reason TEXT;
BEGIN
  -- The row lock closes insert-versus-edit races: the later transaction must
  -- observe the committed source state before it may create memory work.
  PERFORM 1
    FROM "Message"
   WHERE "id" = source_message_id
     AND "conversationId" = source_conversation_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = constraint_name,
      MESSAGE = 'memory source message does not exist in the source conversation';
  END IF;

  invalidation_reason := "memory_source_invalidation_reason"(
    source_message_id,
    source_conversation_id
  );
  IF invalidation_reason IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = constraint_name,
      MESSAGE = 'memory source must be an untouched, unredacted audience text message',
      DETAIL = invalidation_reason;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_extraction_source_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."sourceMessageId" IS NOT NULL THEN
    PERFORM "memory_assert_audience_text_source"(
      NEW."sourceMessageId",
      NEW."sourceConversationId",
      'MemoryExtractionRun_audience_text_source_check'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_candidate_source_guard"() RETURNS TRIGGER AS $$
DECLARE
  extraction_record "MemoryExtractionRun"%ROWTYPE;
  controlled_purge BOOLEAN := FALSE;
  monotonic_invalidation BOOLEAN := FALSE;
  versioned_expiration BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    controlled_purge :=
      OLD."contentPurgedAt" IS NULL
      AND NEW."contentPurgedAt" IS NOT NULL
      AND NEW."safeText" IS NULL
      AND NEW."summary" IS NULL
      AND NEW."contentHash" IS NOT DISTINCT FROM OLD."contentHash"
      AND (
        to_jsonb(NEW) - ARRAY['safeText', 'summary', 'contentPurgedAt', 'updatedAt']
      ) = (
        to_jsonb(OLD) - ARRAY['safeText', 'summary', 'contentPurgedAt', 'updatedAt']
      );

    monotonic_invalidation :=
      NEW."contentPurgedAt" IS NOT NULL
      AND NEW."safeText" IS NULL
      AND NEW."summary" IS NULL
      AND NEW."contentHash" IS NOT DISTINCT FROM OLD."contentHash"
      AND (
        (OLD."status" = 'EXTRACTED' AND NEW."status" = 'BLOCKED')
        OR (OLD."status" = 'PENDING_REVIEW' AND NEW."status" = 'EXPIRED')
        OR NEW."status" = OLD."status"
      )
      AND (
        to_jsonb(NEW) - ARRAY[
          'status', 'safeText', 'summary', 'contentPurgedAt',
          'safetyClass', 'safetyReasonCode', 'updatedAt'
        ]
      ) = (
        to_jsonb(OLD) - ARRAY[
          'status', 'safeText', 'summary', 'contentPurgedAt',
          'safetyClass', 'safetyReasonCode', 'updatedAt'
        ]
      );

    versioned_expiration :=
      OLD."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
      AND NEW."status" = 'EXPIRED'::"MemoryCandidateStatus"
      AND (
        to_jsonb(NEW) - ARRAY['status', 'updatedAt']
      ) = (
        to_jsonb(OLD) - ARRAY['status', 'updatedAt']
      )
      AND EXISTS (
        SELECT 1
          FROM "GovernedMemoryVersion" version_record
         WHERE version_record."sourceCandidateId" = OLD."id"
      );
  END IF;

  IF NOT controlled_purge
     AND NOT monotonic_invalidation
     AND NOT versioned_expiration THEN
    PERFORM "memory_assert_audience_text_source"(
      NEW."sourceMessageId",
      NEW."sourceConversationId",
      'MemoryCandidate_audience_text_source_check'
    );
  END IF;

  IF NEW."extractionRunId" IS NOT NULL THEN
    IF NEW."sourceKind" <> 'AUDIENCE_MESSAGE'::"MemorySourceKind" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_extraction_source_kind_check',
        MESSAGE = 'extracted candidates must retain audience-message provenance';
    END IF;

    SELECT * INTO extraction_record
      FROM "MemoryExtractionRun"
     WHERE "id" = NEW."extractionRunId"
       AND "representativeId" = NEW."representativeId"
       AND "contactId" = NEW."sourceContactId"
       AND "sourceConversationId" = NEW."sourceConversationId"
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryCandidate_extraction_scope_fkey',
        MESSAGE = 'memory candidate extraction run does not match its source scope';
    END IF;

    IF extraction_record."sourceMessageId" IS DISTINCT FROM NEW."sourceMessageId"
       OR extraction_record."sourceChannel" IS DISTINCT FROM NEW."originChannel" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_extraction_source_check',
        MESSAGE = 'memory candidate source message and channel must match its extraction run';
    END IF;

    IF extraction_record."status" = 'CANCELED'::"MemoryExtractionStatus"
       AND NOT controlled_purge
       AND NOT monotonic_invalidation
       AND NOT versioned_expiration THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_extraction_active_check',
        MESSAGE = 'a canceled extraction run cannot create or mutate a candidate';
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW."status" = 'APPROVED'::"MemoryCandidateStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryCandidate_direct_approval_check',
      MESSAGE = 'memory candidates must be approved only through a review transition';
  END IF;

  -- Sensitive outcomes are markers, not storage. This insertion-only rule
  -- leaves the T1 deletion flow free to retain an audit hash while purging an
  -- already-extracted candidate after its source is invalidated.
  IF TG_OP = 'INSERT'
     AND NEW."status" IN (
       'BLOCKED'::"MemoryCandidateStatus",
       'QUARANTINED'::"MemoryCandidateStatus"
     )
     AND (
       NEW."contentPurgedAt" IS NULL
       OR NEW."safeText" IS NOT NULL
       OR NEW."summary" IS NOT NULL
       OR NEW."contentHash" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryCandidate_marker_bodyless_check',
      MESSAGE = 'blocked and quarantined candidate markers cannot retain content or hashes';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Preserve edit provenance even for direct SQL that forgot editedAt. This
-- executes before source invalidation because PostgreSQL orders same-time
-- triggers by name.
CREATE OR REPLACE FUNCTION "memory_mark_message_edit"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."senderType" <> 'AUDIENCE'::"MessageSenderType"
     AND NEW."senderType" <> 'AUDIENCE'::"MessageSenderType" THEN
    RETURN NEW;
  END IF;

  IF NEW."deliveryStatus" = 'REDACTED'::"MessageDeliveryStatus"
     AND OLD."deliveryStatus" <> 'REDACTED'::"MessageDeliveryStatus" THEN
    NEW."redactedAt" := COALESCE(NEW."redactedAt", CURRENT_TIMESTAMP);
  ELSIF NEW."deliveryStatus" = 'EDITED'::"MessageDeliveryStatus"
     AND OLD."deliveryStatus" <> 'EDITED'::"MessageDeliveryStatus" THEN
    NEW."editedAt" := COALESCE(NEW."editedAt", CURRENT_TIMESTAMP);
  ELSIF (
    NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
    OR NEW."senderType" IS DISTINCT FROM OLD."senderType"
    OR NEW."contentType" IS DISTINCT FROM OLD."contentType"
    OR NEW."text" IS DISTINCT FROM OLD."text"
    OR NEW."content" IS DISTINCT FROM OLD."content"
  ) AND NEW."redactedAt" IS NULL THEN
    NEW."editedAt" := COALESCE(NEW."editedAt", CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_invalidate_message_source"() RETURNS TRIGGER AS $$
DECLARE
  invalidation_reason TEXT;
BEGIN
  IF NEW."redactedAt" IS NOT NULL
     AND (
       OLD."redactedAt" IS NULL
       OR NEW."redactedAt" IS DISTINCT FROM OLD."redactedAt"
       OR NEW."deliveryStatus" = 'REDACTED'::"MessageDeliveryStatus"
     ) THEN
    invalidation_reason := 'source_message_redacted';
  ELSIF NEW."editedAt" IS NOT NULL
     AND (
       NEW."editedAt" IS DISTINCT FROM OLD."editedAt"
       OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
       OR NEW."senderType" IS DISTINCT FROM OLD."senderType"
       OR NEW."contentType" IS DISTINCT FROM OLD."contentType"
       OR NEW."text" IS DISTINCT FROM OLD."text"
       OR NEW."content" IS DISTINCT FROM OLD."content"
     ) THEN
    invalidation_reason := 'source_message_edited';
  ELSE
    RETURN NEW;
  END IF;

  UPDATE "MemoryExtractionRun" AS extraction_run
  SET
    "status" = 'CANCELED'::"MemoryExtractionStatus",
    "startedAt" = COALESCE(
      extraction_run."startedAt",
      GREATEST(CURRENT_TIMESTAMP, extraction_run."createdAt")
    ),
    "finishedAt" = GREATEST(
      CURRENT_TIMESTAMP,
      COALESCE(extraction_run."startedAt", CURRENT_TIMESTAMP),
      extraction_run."createdAt"
    ),
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "errorCode" = invalidation_reason,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE extraction_run."sourceMessageId" = OLD."id"
    AND extraction_run."sourceConversationId" = OLD."conversationId"
    AND extraction_run."status" IN ('QUEUED', 'RUNNING');

  -- Approval may have committed immediately before this source mutation. If
  -- the invalidated source owns the exact current approved version, close the
  -- authoritative recall fence in this same transaction. Candidate and
  -- version bodies remain immutable for the later T5 cleanup workflow.
  UPDATE "GovernedMemory" AS memory_record
  SET
    "status" = CASE
      WHEN memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
        THEN 'SUPPRESSED'::"GovernedMemoryStatus"
      ELSE memory_record."status"
    END,
    "recallDisabledAt" = COALESCE(
      memory_record."recallDisabledAt",
      CURRENT_TIMESTAMP
    ),
    "suppressedAt" = CASE
      WHEN memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
        THEN CURRENT_TIMESTAMP
      ELSE memory_record."suppressedAt"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE memory_record."status" NOT IN (
      'DELETE_PENDING'::"GovernedMemoryStatus",
      'DELETED'::"GovernedMemoryStatus"
    )
    AND EXISTS (
      SELECT 1
        FROM "GovernedMemoryVersion" version_record
        JOIN "MemoryCandidate" candidate
          ON candidate."id" = version_record."sourceCandidateId"
         AND candidate."representativeId" = version_record."representativeId"
       WHERE version_record."id" = memory_record."currentVersionId"
         AND version_record."memoryId" = memory_record."id"
         AND version_record."representativeId" = memory_record."representativeId"
         AND candidate."status" = 'APPROVED'::"MemoryCandidateStatus"
         AND candidate."sourceMessageId" = OLD."id"
         AND candidate."sourceConversationId" = OLD."conversationId"
    );

  -- Non-versioned candidates can be purged immediately under the original T1
  -- controlled-purge rules. Keep contentHash as body-free audit evidence.
  UPDATE "MemoryCandidate" AS candidate
  SET
    "status" = CASE
      WHEN candidate."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
        THEN 'EXPIRED'::"MemoryCandidateStatus"
      WHEN candidate."status" = 'EXTRACTED'::"MemoryCandidateStatus"
        THEN 'BLOCKED'::"MemoryCandidateStatus"
      ELSE candidate."status"
    END,
    "safeText" = NULL,
    "summary" = NULL,
    "contentPurgedAt" = COALESCE(candidate."contentPurgedAt", CURRENT_TIMESTAMP),
    "safetyClass" = CASE
      WHEN candidate."status" IN ('EXTRACTED', 'PENDING_REVIEW')
        THEN 'PROHIBITED'::"MemorySafetyClass"
      ELSE candidate."safetyClass"
    END,
    "safetyReasonCode" = CASE
      WHEN candidate."status" IN ('EXTRACTED', 'PENDING_REVIEW')
        THEN invalidation_reason
      ELSE candidate."safetyReasonCode"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE candidate."sourceMessageId" = OLD."id"
    AND candidate."sourceConversationId" = OLD."conversationId"
    AND candidate."status" NOT IN (
      'APPROVED'::"MemoryCandidateStatus",
      'BLOCKED'::"MemoryCandidateStatus",
      'QUARANTINED'::"MemoryCandidateStatus"
    )
    AND NOT EXISTS (
      SELECT 1
        FROM "GovernedMemoryVersion" version_record
       WHERE version_record."sourceCandidateId" = candidate."id"
    );

  -- A pre-created immutable version cannot be physically purged here. Expire
  -- its pending candidate immediately, recall-block the business memory, and
  -- hand the version to the durable T6 deletion pipeline.
  UPDATE "MemoryCandidate" AS candidate
  SET
    "status" = 'EXPIRED'::"MemoryCandidateStatus",
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE candidate."sourceMessageId" = OLD."id"
    AND candidate."sourceConversationId" = OLD."conversationId"
    AND candidate."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
    AND EXISTS (
      SELECT 1
        FROM "GovernedMemoryVersion" version_record
       WHERE version_record."sourceCandidateId" = candidate."id"
    );

  UPDATE "GovernedMemory" AS memory_record
  SET
    "status" = 'DELETE_PENDING'::"GovernedMemoryStatus",
    "recallDisabledAt" = COALESCE(memory_record."recallDisabledAt", CURRENT_TIMESTAMP),
    "deleteRequestedAt" = COALESCE(memory_record."deleteRequestedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE memory_record."status" IN (
      'SUPPRESSED'::"GovernedMemoryStatus",
      'SUPERSEDED'::"GovernedMemoryStatus",
      'EXPIRED'::"GovernedMemoryStatus",
      'ARCHIVED'::"GovernedMemoryStatus"
    )
    AND EXISTS (
      SELECT 1
        FROM "GovernedMemoryVersion" version_record
        JOIN "MemoryCandidate" candidate
          ON candidate."id" = version_record."sourceCandidateId"
       WHERE version_record."memoryId" = memory_record."id"
         AND candidate."sourceMessageId" = OLD."id"
         AND candidate."sourceConversationId" = OLD."conversationId"
         AND candidate."status" <> 'APPROVED'::"MemoryCandidateStatus"
    );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One-time cleanup for pre-T3 markers uses the original T1 controlled-purge
-- path. Historical hashes remain as body-free audit fingerprints.
UPDATE "MemoryCandidate"
SET
  "safeText" = NULL,
  "summary" = NULL,
  "contentPurgedAt" = COALESCE("contentPurgedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN (
    'BLOCKED'::"MemoryCandidateStatus",
    'QUARANTINED'::"MemoryCandidateStatus"
  )
  AND (
    "contentPurgedAt" IS NULL
    OR "safeText" IS NOT NULL
    OR "summary" IS NOT NULL
  );

-- Close pre-migration invalid provenance using the same conservative split.
UPDATE "MemoryExtractionRun" AS extraction_run
SET
  "status" = 'CANCELED'::"MemoryExtractionStatus",
  "startedAt" = COALESCE(
    extraction_run."startedAt",
    GREATEST(CURRENT_TIMESTAMP, extraction_run."createdAt")
  ),
  "finishedAt" = GREATEST(
    CURRENT_TIMESTAMP,
    COALESCE(extraction_run."startedAt", CURRENT_TIMESTAMP),
    extraction_run."createdAt"
  ),
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "errorCode" = "memory_source_invalidation_reason"(
    extraction_run."sourceMessageId",
    extraction_run."sourceConversationId"
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE extraction_run."status" IN ('QUEUED', 'RUNNING')
  AND extraction_run."sourceMessageId" IS NOT NULL
  AND "memory_source_invalidation_reason"(
    extraction_run."sourceMessageId",
    extraction_run."sourceConversationId"
  ) IS NOT NULL;

-- Close the same approved-current recall window for invalid sources that
-- predate this migration. Historical superseded versions are intentionally
-- ignored because they are not the business memory's current pointer.
UPDATE "GovernedMemory" AS memory_record
SET
  "status" = CASE
    WHEN memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
      THEN 'SUPPRESSED'::"GovernedMemoryStatus"
    ELSE memory_record."status"
  END,
  "recallDisabledAt" = COALESCE(
    memory_record."recallDisabledAt",
    CURRENT_TIMESTAMP
  ),
  "suppressedAt" = CASE
    WHEN memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
      THEN CURRENT_TIMESTAMP
    ELSE memory_record."suppressedAt"
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE memory_record."status" NOT IN (
    'DELETE_PENDING'::"GovernedMemoryStatus",
    'DELETED'::"GovernedMemoryStatus"
  )
  AND EXISTS (
    SELECT 1
      FROM "GovernedMemoryVersion" version_record
      JOIN "MemoryCandidate" candidate
        ON candidate."id" = version_record."sourceCandidateId"
       AND candidate."representativeId" = version_record."representativeId"
     WHERE version_record."id" = memory_record."currentVersionId"
       AND version_record."memoryId" = memory_record."id"
       AND version_record."representativeId" = memory_record."representativeId"
       AND candidate."status" = 'APPROVED'::"MemoryCandidateStatus"
       AND "memory_source_invalidation_reason"(
         candidate."sourceMessageId",
         candidate."sourceConversationId"
       ) IS NOT NULL
  );

UPDATE "MemoryCandidate" AS candidate
SET
  "status" = CASE
    WHEN candidate."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
      THEN 'EXPIRED'::"MemoryCandidateStatus"
    WHEN candidate."status" = 'EXTRACTED'::"MemoryCandidateStatus"
      THEN 'BLOCKED'::"MemoryCandidateStatus"
    ELSE candidate."status"
  END,
  "safeText" = NULL,
  "summary" = NULL,
  "contentPurgedAt" = COALESCE(candidate."contentPurgedAt", CURRENT_TIMESTAMP),
  "safetyClass" = CASE
    WHEN candidate."status" IN ('EXTRACTED', 'PENDING_REVIEW')
      THEN 'PROHIBITED'::"MemorySafetyClass"
    ELSE candidate."safetyClass"
  END,
  "safetyReasonCode" = CASE
    WHEN candidate."status" IN ('EXTRACTED', 'PENDING_REVIEW')
      THEN "memory_source_invalidation_reason"(
        candidate."sourceMessageId",
        candidate."sourceConversationId"
      )
    ELSE candidate."safetyReasonCode"
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE candidate."status" NOT IN (
    'APPROVED'::"MemoryCandidateStatus",
    'BLOCKED'::"MemoryCandidateStatus",
    'QUARANTINED'::"MemoryCandidateStatus"
  )
  AND "memory_source_invalidation_reason"(
    candidate."sourceMessageId",
    candidate."sourceConversationId"
  ) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM "GovernedMemoryVersion" version_record
     WHERE version_record."sourceCandidateId" = candidate."id"
  );

UPDATE "MemoryCandidate" AS candidate
SET
  "status" = 'EXPIRED'::"MemoryCandidateStatus",
  "updatedAt" = CURRENT_TIMESTAMP
WHERE candidate."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
  AND "memory_source_invalidation_reason"(
    candidate."sourceMessageId",
    candidate."sourceConversationId"
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM "GovernedMemoryVersion" version_record
     WHERE version_record."sourceCandidateId" = candidate."id"
  );

UPDATE "GovernedMemory" AS memory_record
SET
  "status" = 'DELETE_PENDING'::"GovernedMemoryStatus",
  "recallDisabledAt" = COALESCE(memory_record."recallDisabledAt", CURRENT_TIMESTAMP),
  "deleteRequestedAt" = COALESCE(memory_record."deleteRequestedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE memory_record."status" IN (
    'SUPPRESSED'::"GovernedMemoryStatus",
    'SUPERSEDED'::"GovernedMemoryStatus",
    'EXPIRED'::"GovernedMemoryStatus",
    'ARCHIVED'::"GovernedMemoryStatus"
  )
  AND EXISTS (
    SELECT 1
      FROM "GovernedMemoryVersion" version_record
      JOIN "MemoryCandidate" candidate
        ON candidate."id" = version_record."sourceCandidateId"
     WHERE version_record."memoryId" = memory_record."id"
       AND candidate."status" <> 'APPROVED'::"MemoryCandidateStatus"
       AND "memory_source_invalidation_reason"(
         candidate."sourceMessageId",
         candidate."sourceConversationId"
       ) IS NOT NULL
  );

-- Install separate source guards; the T1 lifecycle/channel functions and
-- triggers remain byte-for-byte unchanged.
DROP TRIGGER IF EXISTS "MemoryExtractionRun_source_guard" ON "MemoryExtractionRun";
CREATE TRIGGER "MemoryExtractionRun_source_guard"
  BEFORE INSERT OR UPDATE ON "MemoryExtractionRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_extraction_source_guard"();

DROP TRIGGER IF EXISTS "MemoryCandidate_source_guard" ON "MemoryCandidate";
CREATE TRIGGER "MemoryCandidate_source_guard"
  BEFORE INSERT OR UPDATE ON "MemoryCandidate"
  FOR EACH ROW EXECUTE FUNCTION "memory_candidate_source_guard"();

DROP TRIGGER IF EXISTS "Message_memory_mark_edit" ON "Message";
CREATE TRIGGER "Message_memory_mark_edit"
  BEFORE UPDATE OF
    "conversationId", "senderType", "contentType", "text", "content",
    "deliveryStatus"
  ON "Message"
  FOR EACH ROW EXECUTE FUNCTION "memory_mark_message_edit"();

DROP TRIGGER IF EXISTS "Message_memory_source_invalidation" ON "Message";
CREATE TRIGGER "Message_memory_source_invalidation"
  BEFORE UPDATE OF
    "conversationId", "senderType", "contentType", "text", "content",
    "editedAt", "redactedAt", "deliveryStatus"
  ON "Message"
  FOR EACH ROW EXECUTE FUNCTION "memory_invalidate_message_source"();

COMMIT;
