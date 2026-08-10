BEGIN;

-- Automatic representative-evidence decisions intentionally lock the
-- candidate's safety/provenance coordinates. Source edit/redaction must still
-- be able to perform the existing controlled purge, but it must not rewrite
-- those immutable audit inputs. Candidates without an automatic decision keep
-- the historical safety reclassification behaviour.
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
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryPolicyDecision" policy_decision
          WHERE policy_decision."candidateId" = candidate."id"
            AND policy_decision."representativeId" = candidate."representativeId"
       ) THEN 'PROHIBITED'::"MemorySafetyClass"
      ELSE candidate."safetyClass"
    END,
    "safetyReasonCode" = CASE
      WHEN candidate."status" IN ('EXTRACTED', 'PENDING_REVIEW')
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryPolicyDecision" policy_decision
          WHERE policy_decision."candidateId" = candidate."id"
            AND policy_decision."representativeId" = candidate."representativeId"
       ) THEN invalidation_reason
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

COMMIT;
