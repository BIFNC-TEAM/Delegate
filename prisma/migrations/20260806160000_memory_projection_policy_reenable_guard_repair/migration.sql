-- Repair databases that applied the first 1300 lifecycle migration before its
-- receipt/attempt guard collaboration was finalized. This is deliberately an
-- additive replay: migrate deploy never re-runs an already recorded migration.

BEGIN;

CREATE OR REPLACE FUNCTION "memory_projection_policy_reenable_allowed"(
  old_record "MemoryProjectionItem",
  new_record "MemoryProjectionItem"
) RETURNS BOOLEAN AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
BEGIN
  IF old_record."status" NOT IN ('DELETE_PENDING', 'DELETE_FAILED', 'DELETED')
     OR new_record."status" <> 'QUEUED'::"MemoryProjectionStatus" THEN
    RETURN FALSE;
  END IF;
  SELECT * INTO version_record
    FROM "GovernedMemoryVersion"
   WHERE "id" = new_record."memoryVersionId"
     AND "memoryId" = new_record."memoryId"
     AND "representativeId" = new_record."representativeId";
  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = new_record."memoryId"
     AND "representativeId" = new_record."representativeId";
  SELECT * INTO policy_record
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = new_record."representativeId";
  RETURN
    old_record."lane" = 'RECALL'::"MemoryProjectionLane"
    AND old_record."deleteRequestedAt" IS NOT NULL
    AND new_record."lane" = old_record."lane"
    AND new_record."provider" = old_record."provider"
    AND new_record."memoryId" = old_record."memoryId"
    AND new_record."memoryVersionId" = old_record."memoryVersionId"
    AND new_record."contentHash" = old_record."contentHash"
    AND new_record."remoteObjectId" IS NULL
    AND new_record."writeReceiptHash" IS NULL
    AND new_record."writeVerifiedAt" IS NULL
    AND new_record."deleteReceiptHash" IS NULL
    AND new_record."remoteAbsentAt" IS NULL
    AND new_record."attemptCount" = 0
    AND new_record."leaseToken" IS NULL
    AND new_record."leaseExpiresAt" IS NULL
    AND new_record."projectedAt" IS NULL
    AND new_record."deleteRequestedAt" IS NULL
    AND new_record."deletedAt" IS NULL
    AND new_record."lastErrorCode" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "MemoryDeletionProof"
       WHERE "memoryId" = new_record."memoryId"
         AND "representativeId" = new_record."representativeId"
    )
    AND version_record."id" IS NOT NULL
    AND version_record."purgedAt" IS NULL
    AND version_record."safeText" IS NOT NULL
    AND version_record."contentHash" = new_record."contentHash"
    AND memory_record."id" IS NOT NULL
    AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
    AND memory_record."recallDisabledAt" IS NULL
    AND memory_record."currentVersionId" = new_record."memoryVersionId"
    AND (memory_record."expiresAt" IS NULL OR memory_record."expiresAt" > CURRENT_TIMESTAMP)
    AND policy_record."representativeId" IS NOT NULL
    AND policy_record."provider" = new_record."provider"
    AND policy_record."longTermMemoryEnabled"
    AND (
      (
        memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
        AND memory_record."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
        AND policy_record."contactMemoryEnabled"
        AND policy_record."webRecallEnabled"
      ) OR (
        memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
        AND policy_record."representativeExperienceEnabled"
      )
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_projection_coordinates_guard"() RETURNS TRIGGER AS $$
DECLARE
  repair_receipt_transition BOOLEAN;
  policy_reenable_reset BOOLEAN;
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
  policy_reenable_reset := "memory_projection_policy_reenable_allowed"(OLD, NEW);

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

  IF NOT policy_reenable_reset AND (
    (OLD."remoteObjectId" IS NOT NULL AND NEW."remoteObjectId" IS DISTINCT FROM OLD."remoteObjectId")
    OR (OLD."deleteReceiptHash" IS NOT NULL AND NEW."deleteReceiptHash" IS DISTINCT FROM OLD."deleteReceiptHash")
    OR (OLD."remoteAbsentAt" IS NOT NULL AND NEW."remoteAbsentAt" IS DISTINCT FROM OLD."remoteAbsentAt")
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_receipt_immutable_check',
      MESSAGE = 'memory projection provider identity and receipts are append-only';
  END IF;

  IF (
       (OLD."writeReceiptHash" IS NOT NULL AND NEW."writeReceiptHash" IS DISTINCT FROM OLD."writeReceiptHash")
       OR (OLD."writeVerifiedAt" IS NOT NULL AND NEW."writeVerifiedAt" IS DISTINCT FROM OLD."writeVerifiedAt")
     ) AND NOT repair_receipt_transition AND NOT policy_reenable_reset THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_write_receipt_chain_check',
      MESSAGE = 'write receipt evidence may advance only during a fenced reconciliation repair';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "memory_projection_execution_guard"() RETURNS TRIGGER AS $$
DECLARE
  entering_write BOOLEAN;
  entering_delete BOOLEAN;
  policy_reenable_reset BOOLEAN := FALSE;
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

  policy_reenable_reset := "memory_projection_policy_reenable_allowed"(OLD, NEW);
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
  ELSIF NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount"
        AND NOT policy_reenable_reset THEN
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

COMMIT;
