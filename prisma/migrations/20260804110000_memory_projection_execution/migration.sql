-- Memory System T5-B/C: exact managed-user projection execution, lease/CAS
-- receipts, and deletion-proof drain fences.

BEGIN;

ALTER TABLE "MemoryProjectionItem"
  ADD COLUMN IF NOT EXISTS "writeReceiptHash" TEXT,
  ADD COLUMN IF NOT EXISTS "writeVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deleteReceiptHash" TEXT,
  ADD COLUMN IF NOT EXISTS "remoteAbsentAt" TIMESTAMP(3);

-- LEGACY_REMOTE_EVIDENCE_PREFLIGHT_BEGIN
-- The previous contract stored provider coordinates directly on the
-- projection row. Replacing one of those URIs would turn the old remote leaf
-- into an untraceable orphan, and OpenViking cannot enumerate a complete
-- point-in-time inventory to recover it later. Only rows whose old state
-- proves that no provider attempt ever started may be canonicalized in place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "MemoryProjectionItem" projection
     WHERE projection."status" NOT IN (
             'DISABLED'::"MemoryProjectionStatus",
             'QUEUED'::"MemoryProjectionStatus",
             'DELETE_PENDING'::"MemoryProjectionStatus"
           )
        OR projection."attemptCount" <> 0
        OR projection."leaseToken" IS NOT NULL
        OR projection."leaseExpiresAt" IS NOT NULL
        OR projection."remoteUri" IS NOT NULL
        OR projection."remoteObjectId" IS NOT NULL
        OR projection."projectedAt" IS NOT NULL
        OR projection."deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_legacy_remote_evidence_requires_cleanup',
      MESSAGE = 'legacy memory projection evidence requires explicit exact-URI cleanup before canonical backfill';
  END IF;
END;
$$;
-- LEGACY_REMOTE_EVIDENCE_PREFLIGHT_END

-- Fail closed before constructing canonical URIs. Namespace keys and every
-- path coordinate are server-owned opaque segments, never Owner-provided
-- shorthand or an Agent URI.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "MemoryProjectionItem" projection
      JOIN "GovernedMemory" memory_record
        ON memory_record."id" = projection."memoryId"
       AND memory_record."representativeId" = projection."representativeId"
      JOIN "RepresentativeMemoryPolicy" policy
        ON policy."representativeId" = projection."representativeId"
     WHERE policy."namespaceKey" !~ '^[A-Za-z0-9_-]{1,128}$'
        OR projection."memoryId" !~ '^[A-Za-z0-9_-]{1,128}$'
        OR projection."memoryVersionId" !~ '^[A-Za-z0-9_-]{1,128}$'
        OR (
          memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
          AND (
            memory_record."contactId" IS NULL
            OR memory_record."contactId" !~ '^[A-Za-z0-9_-]{1,128}$'
            OR memory_record."sourceChannel" IS NULL
          )
        )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
      MESSAGE = 'existing memory projection coordinates cannot form a canonical managed-user URI';
  END IF;
END;
$$;

UPDATE "MemoryProjectionItem" projection
   SET "remoteUri" = CASE memory_record."scope"
     WHEN 'CONTACT_CHANNEL'::"MemoryScope" THEN
       'viking://user/delegate-memory-' || policy."namespaceKey"
       || '/memories/delegate/' || policy."namespaceKey"
       || '/contacts/' || memory_record."contactId"
       || '/channels/' || lower(memory_record."sourceChannel"::TEXT)
       || '/memories/' || projection."memoryId"
       || '/versions/' || projection."memoryVersionId" || '.md'
     ELSE
       'viking://user/delegate-memory-' || policy."namespaceKey"
       || '/memories/delegate/' || policy."namespaceKey"
       || '/representative-experience/memories/' || projection."memoryId"
       || '/versions/' || projection."memoryVersionId" || '.md'
   END
  FROM "GovernedMemory" memory_record,
       "RepresentativeMemoryPolicy" policy
 WHERE memory_record."id" = projection."memoryId"
   AND memory_record."representativeId" = projection."representativeId"
   AND policy."representativeId" = projection."representativeId"
   AND projection."status" IN (
     'DISABLED'::"MemoryProjectionStatus",
     'QUEUED'::"MemoryProjectionStatus",
     'DELETE_PENDING'::"MemoryProjectionStatus"
   )
   AND projection."attemptCount" = 0
   AND projection."leaseToken" IS NULL
   AND projection."leaseExpiresAt" IS NULL
   AND projection."remoteUri" IS NULL
   AND projection."remoteObjectId" IS NULL
   AND projection."projectedAt" IS NULL
   AND projection."deletedAt" IS NULL;

ALTER TABLE "MemoryProjectionItem"
  ALTER COLUMN "remoteUri" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'MemoryProjectionItem_receipt_check'
       AND conrelid = '"MemoryProjectionItem"'::regclass
  ) THEN
    ALTER TABLE "MemoryProjectionItem"
      ADD CONSTRAINT "MemoryProjectionItem_receipt_check" CHECK (
        ("writeReceiptHash" IS NULL OR "writeReceiptHash" ~ '^[0-9a-f]{64}$')
        AND ("deleteReceiptHash" IS NULL OR "deleteReceiptHash" ~ '^[0-9a-f]{64}$')
        AND (("writeReceiptHash" IS NULL) = ("writeVerifiedAt" IS NULL))
        AND (("deleteReceiptHash" IS NULL) = ("remoteAbsentAt" IS NULL))
      );
  END IF;
END;
$$;

-- remoteUri is part of the immutable projection identity. Provider receipts
-- and confirmed-absence evidence are append-only once observed.
CREATE OR REPLACE FUNCTION "memory_projection_coordinates_guard"() RETURNS TRIGGER AS $$
DECLARE
  repair_receipt_transition BOOLEAN;
BEGIN
  repair_receipt_transition :=
    OLD."status" = 'PROJECTING'::"MemoryProjectionStatus"
    AND OLD."lastErrorCode" IN (
      'reconciliation_missing_remote',
      'reconciliation_hash_mismatch',
      'reconciliation_stale_active_pointer',
      'projection_write_cleanup_required'
    )
    AND NEW."status" IN (
      'ACTIVE'::"MemoryProjectionStatus",
      'DELETE_PENDING'::"MemoryProjectionStatus"
    )
    AND NEW."writeReceiptHash" IS NOT NULL
    AND NEW."writeVerifiedAt" IS NOT NULL;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."memoryId" IS DISTINCT FROM OLD."memoryId"
     OR NEW."memoryVersionId" IS DISTINCT FROM OLD."memoryVersionId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."lane" IS DISTINCT FROM OLD."lane"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."remoteUri" IS DISTINCT FROM OLD."remoteUri" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_locked_coordinates_check',
      MESSAGE = 'memory projection coordinates and canonical URI are immutable';
  END IF;

  IF (OLD."remoteObjectId" IS NOT NULL AND NEW."remoteObjectId" IS DISTINCT FROM OLD."remoteObjectId")
     OR (OLD."deleteReceiptHash" IS NOT NULL AND NEW."deleteReceiptHash" IS DISTINCT FROM OLD."deleteReceiptHash")
     OR (OLD."remoteAbsentAt" IS NOT NULL AND NEW."remoteAbsentAt" IS DISTINCT FROM OLD."remoteAbsentAt") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_receipt_immutable_check',
      MESSAGE = 'memory projection provider identity and receipts are append-only';
  END IF;

  IF (
       (OLD."writeReceiptHash" IS NOT NULL AND NEW."writeReceiptHash" IS DISTINCT FROM OLD."writeReceiptHash")
       OR (OLD."writeVerifiedAt" IS NOT NULL AND NEW."writeVerifiedAt" IS DISTINCT FROM OLD."writeVerifiedAt")
     ) AND NOT repair_receipt_transition THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_write_receipt_chain_check',
      MESSAGE = 'write receipt evidence may advance only during a fenced reconciliation repair';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_projection_canonical_uri_guard"() RETURNS TRIGGER AS $$
DECLARE
  memory_record "GovernedMemory"%ROWTYPE;
  namespace_key TEXT;
  expected_uri TEXT;
BEGIN
  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  SELECT "namespaceKey" INTO namespace_key
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = NEW."representativeId"
   FOR SHARE;

  IF memory_record."id" IS NULL
     OR namespace_key IS NULL
     OR namespace_key !~ '^[A-Za-z0-9_-]{1,128}$'
     OR NEW."memoryId" !~ '^[A-Za-z0-9_-]{1,128}$'
     OR NEW."memoryVersionId" !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
      MESSAGE = 'memory projection coordinates cannot form a canonical managed-user URI';
  END IF;

  IF memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope" THEN
    IF memory_record."contactId" IS NULL
       OR memory_record."contactId" !~ '^[A-Za-z0-9_-]{1,128}$'
       OR memory_record."sourceChannel" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
        MESSAGE = 'contact projection coordinates cannot form a canonical managed-user URI';
    END IF;
    expected_uri :=
      'viking://user/delegate-memory-' || namespace_key
      || '/memories/delegate/' || namespace_key
      || '/contacts/' || memory_record."contactId"
      || '/channels/' || lower(memory_record."sourceChannel"::TEXT)
      || '/memories/' || NEW."memoryId"
      || '/versions/' || NEW."memoryVersionId" || '.md';
  ELSE
    expected_uri :=
      'viking://user/delegate-memory-' || namespace_key
      || '/memories/delegate/' || namespace_key
      || '/representative-experience/memories/' || NEW."memoryId"
      || '/versions/' || NEW."memoryVersionId" || '.md';
  END IF;

  IF NEW."remoteUri" IS DISTINCT FROM expected_uri
     OR NEW."remoteUri" LIKE 'viking://agent/%'
     OR NEW."remoteUri" LIKE 'viking://user/memories/%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_check',
      MESSAGE = 'projection URI must be the exact immutable managed-user version leaf';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_canonical_uri_guard" ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_canonical_uri_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_canonical_uri_guard"();

-- T1 originally made ACTIVE terminal except for supersession/deletion. A
-- reconciliation repair must first remove the row from recall eligibility,
-- then re-use the same immutable URI and approved bytes. Permit that one
-- transition only when an open scoped reconciliation issue proves why the
-- local ACTIVE pointer is no longer trustworthy.
CREATE OR REPLACE FUNCTION "memory_projection_state_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  reconciliation_issue "MemoryReconciliationIssueKind";
BEGIN
  IF TG_OP = 'INSERT' AND NEW."status" NOT IN ('DISABLED', 'QUEUED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_initial_state_check',
      MESSAGE = 'new projection must start disabled or queued';
  END IF;

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "MemoryDeletionProof"
     WHERE "memoryId" = NEW."memoryId"
       AND "remotePurgeCompletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_after_remote_purge_check',
      MESSAGE = 'projection cannot be recreated after remote purge completion';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'ACTIVE'::"MemoryProjectionStatus"
     AND NEW."status" = 'RETRYING'::"MemoryProjectionStatus" THEN
    reconciliation_issue := CASE NEW."lastErrorCode"
      WHEN 'reconciliation_missing_remote' THEN 'MISSING_REMOTE'::"MemoryReconciliationIssueKind"
      WHEN 'reconciliation_hash_mismatch' THEN 'HASH_MISMATCH'::"MemoryReconciliationIssueKind"
      WHEN 'reconciliation_stale_active_pointer' THEN 'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
      ELSE NULL
    END;
    IF reconciliation_issue IS NULL OR NOT EXISTS (
      SELECT 1
        FROM "MemoryReconciliationItem" item
       WHERE item."projectionItemId" = NEW."id"
         AND item."representativeId" = NEW."representativeId"
         AND item."issueKind" = reconciliation_issue
         AND item."status" IN (
           'OPEN'::"MemoryReconciliationItemStatus",
           'RETRYING'::"MemoryReconciliationItemStatus"
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_reconciliation_repair_check',
        MESSAGE = 'active projection repair requires a matching open reconciliation issue';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DISABLED' AND NEW."status" IN ('QUEUED', 'DELETE_PENDING'))
    OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('PROJECTING', 'RETRYING', 'FAILED', 'DELETE_PENDING', 'DISABLED'))
    OR (OLD."status" = 'PROJECTING' AND NEW."status" IN ('STAGED', 'ACTIVE', 'RETRYING', 'FAILED', 'DELETE_PENDING'))
    OR (OLD."status" = 'RETRYING' AND NEW."status" IN ('PROJECTING', 'FAILED', 'DELETE_PENDING'))
    OR (OLD."status" = 'STAGED' AND NEW."status" IN ('QUEUED', 'SUPERSEDED', 'DELETE_PENDING'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUPERSEDED', 'DELETE_PENDING', 'RETRYING'))
    OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'DELETE_PENDING')
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('QUEUED', 'RETRYING', 'DELETE_PENDING'))
    OR (OLD."status" = 'DELETE_PENDING' AND NEW."status" IN ('DELETING', 'DELETE_FAILED'))
    OR (OLD."status" = 'DELETING' AND NEW."status" IN ('DELETED', 'DELETE_FAILED'))
    OR (OLD."status" = 'DELETE_FAILED' AND NEW."status" IN ('DELETE_PENDING', 'DELETING'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_state_transition_check',
      MESSAGE = 'invalid memory projection state transition';
  END IF;

  IF NEW."status" = 'STAGED'::"MemoryProjectionStatus"
     AND NEW."lane" <> 'STAGING'::"MemoryProjectionLane" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_staged_lane_check',
      MESSAGE = 'only staging projections may reach the staged terminal state';
  END IF;

  IF NEW."status" = 'ACTIVE'::"MemoryProjectionStatus"
     AND (TG_OP = 'INSERT' OR OLD."status" <> 'ACTIVE'::"MemoryProjectionStatus") THEN
    SELECT * INTO version_record FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."memoryVersionId";
    SELECT * INTO memory_record FROM "GovernedMemory"
     WHERE "id" = NEW."memoryId";
    IF NEW."lane" <> 'RECALL'::"MemoryProjectionLane"
       OR version_record."id" IS NULL
       OR memory_record."id" IS NULL
       OR version_record."purgedAt" IS NOT NULL
       OR version_record."contentHash" IS DISTINCT FROM NEW."contentHash"
       OR memory_record."status" <> 'ACTIVE'::"GovernedMemoryStatus"
       OR memory_record."recallDisabledAt" IS NOT NULL
       OR memory_record."currentVersionId" IS DISTINCT FROM version_record."id"
       OR NOT EXISTS (
         SELECT 1 FROM "MemoryCandidate"
          WHERE "id" = version_record."sourceCandidateId"
            AND "representativeId" = memory_record."representativeId"
            AND "status" = 'APPROVED'::"MemoryCandidateStatus"
            AND "contentPurgedAt" IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM "MemoryReviewDecision"
          WHERE "candidateId" = version_record."sourceCandidateId"
            AND "resultVersionId" = version_record."id"
            AND "memoryId" = memory_record."id"
            AND "representativeId" = memory_record."representativeId"
            AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_active_version_check',
        MESSAGE = 'late or staging projection cannot become recall-active';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_projection_execution_guard"() RETURNS TRIGGER AS $$
DECLARE
  entering_write BOOLEAN;
  entering_delete BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."writeReceiptHash" IS NOT NULL
       OR NEW."writeVerifiedAt" IS NOT NULL
       OR NEW."deleteReceiptHash" IS NOT NULL
       OR NEW."remoteAbsentAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_execution_initial_check',
        MESSAGE = 'new projection cannot carry a worker lease or provider receipt';
    END IF;
    RETURN NEW;
  END IF;

  entering_write :=
    NEW."status" = 'PROJECTING'::"MemoryProjectionStatus"
    AND OLD."status" <> 'PROJECTING'::"MemoryProjectionStatus";
  entering_delete :=
    NEW."status" = 'DELETING'::"MemoryProjectionStatus"
    AND OLD."status" <> 'DELETING'::"MemoryProjectionStatus";

  IF entering_write OR entering_delete THEN
    IF NEW."attemptCount" <> OLD."attemptCount" + 1
       OR NEW."leaseToken" IS NULL
       OR NEW."leaseExpiresAt" IS NULL
       OR NEW."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR (
         NEW."lastErrorCode" IS NOT NULL
         AND NEW."lastErrorCode" NOT IN (
           'reconciliation_missing_remote',
           'reconciliation_hash_mismatch',
           'reconciliation_stale_active_pointer',
           'projection_write_cleanup_required'
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_execution_claim_check',
        MESSAGE = 'projection claim requires one new attempt and a live clean lease';
    END IF;
  ELSIF NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_attempt_check',
      MESSAGE = 'projection attempt count changes only when work is claimed';
  END IF;

  IF OLD."status" IN ('PROJECTING'::"MemoryProjectionStatus", 'DELETING'::"MemoryProjectionStatus")
     AND NEW."status" = OLD."status"
     AND (
       NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
       OR NEW."leaseExpiresAt" < OLD."leaseExpiresAt"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_lease_check',
      MESSAGE = 'running projection may only extend its current lease';
  END IF;

  IF NEW."status" IN ('PROJECTING'::"MemoryProjectionStatus", 'DELETING'::"MemoryProjectionStatus") THEN
    IF NEW."leaseToken" IS NULL OR NEW."leaseExpiresAt" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_execution_lease_check',
        MESSAGE = 'running projection requires its worker lease';
    END IF;
  ELSIF NEW."leaseToken" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_lease_release_check',
      MESSAGE = 'non-running projection cannot retain a worker lease';
  END IF;

  IF NEW."status" IN ('RETRYING'::"MemoryProjectionStatus", 'FAILED'::"MemoryProjectionStatus", 'DELETE_FAILED'::"MemoryProjectionStatus")
     AND (NEW."lastErrorCode" IS NULL OR btrim(NEW."lastErrorCode") = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_failure_check',
      MESSAGE = 'retryable or failed projection must retain a stable error code';
  END IF;

  IF NEW."lastErrorCode" IN (
       'reconciliation_missing_remote',
       'reconciliation_hash_mismatch',
       'reconciliation_stale_active_pointer',
       'projection_write_cleanup_required'
     ) AND NEW."status" NOT IN (
       'RETRYING'::"MemoryProjectionStatus",
       'PROJECTING'::"MemoryProjectionStatus",
       'FAILED'::"MemoryProjectionStatus"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_reconciliation_reason_state_check',
      MESSAGE = 'reconciliation repair reason may exist only while fenced or failed';
  END IF;

  IF NEW."status" = 'ACTIVE'::"MemoryProjectionStatus" AND (
    NEW."deleteRequestedAt" IS NOT NULL
    OR NEW."remoteObjectId" IS NULL
    OR NEW."writeReceiptHash" IS NULL
    OR NEW."writeVerifiedAt" IS NULL
    OR NEW."projectedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_active_receipt_check',
      MESSAGE = 'active projection requires a verified write receipt and no deletion request';
  END IF;

  IF NEW."status" = 'DELETED'::"MemoryProjectionStatus" AND (
    TG_OP <> 'UPDATE'
    OR OLD."status" <> 'DELETING'::"MemoryProjectionStatus"
    OR OLD."leaseToken" IS NULL
    OR OLD."leaseExpiresAt" IS NULL
    OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
    OR NEW."deleteRequestedAt" IS NULL
    OR NEW."deleteReceiptHash" IS NULL
    OR NEW."remoteAbsentAt" IS NULL
    OR NEW."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_execution_delete_receipt_check',
      MESSAGE = 'deleted projection requires a live deleting lease and exact-leaf absence evidence';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_execution_guard" ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_execution_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_execution_guard"();

-- The T1 state guard remains the authority check. Tighten its ACTIVE branch so
-- a late write can never win after deletion was requested.
CREATE OR REPLACE FUNCTION "memory_projection_delete_request_active_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'::"MemoryProjectionStatus"
     AND NEW."deleteRequestedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_active_delete_request_check',
      MESSAGE = 'projection with a deletion request cannot become active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_delete_request_active_guard" ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_delete_request_active_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_delete_request_active_guard"();

-- A deletion proof may complete only after every exact projection has drained
-- its write/delete lease and recorded a confirmed remote absence receipt.
CREATE OR REPLACE FUNCTION "memory_deletion_proof_projection_drain_guard"() RETURNS TRIGGER AS $$
DECLARE
  remote_transition BOOLEAN;
  completion_transition BOOLEAN;
BEGIN
  remote_transition := NEW."remotePurgeCompletedAt" IS NOT NULL AND TG_OP = 'INSERT';
  completion_transition := NEW."completedAt" IS NOT NULL AND TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    remote_transition :=
      NEW."remotePurgeCompletedAt" IS NOT NULL
      AND OLD."remotePurgeCompletedAt" IS NULL;
    completion_transition :=
      NEW."completedAt" IS NOT NULL
      AND OLD."completedAt" IS NULL;
  END IF;

  IF remote_transition OR completion_transition THEN
    IF EXISTS (
      SELECT 1
        FROM "MemoryProjectionItem"
       WHERE "memoryId" = NEW."memoryId"
         AND (
           "status" <> 'DELETED'::"MemoryProjectionStatus"
           OR "leaseToken" IS NOT NULL
           OR "leaseExpiresAt" IS NOT NULL
           OR "deleteReceiptHash" IS NULL
           OR "remoteAbsentAt" IS NULL
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_projection_drain_check',
        MESSAGE = 'remote purge cannot complete before every projection is confirmed absent';
    END IF;

    IF NEW."providerReceiptHash" IS NULL
       OR NEW."providerReceiptHash" !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_provider_receipt_check',
        MESSAGE = 'remote purge requires an aggregate provider receipt hash';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryDeletionProof_projection_drain_guard" ON "MemoryDeletionProof";
CREATE TRIGGER "MemoryDeletionProof_projection_drain_guard"
  BEFORE INSERT OR UPDATE ON "MemoryDeletionProof"
  FOR EACH ROW EXECUTE FUNCTION "memory_deletion_proof_projection_drain_guard"();

COMMIT;
