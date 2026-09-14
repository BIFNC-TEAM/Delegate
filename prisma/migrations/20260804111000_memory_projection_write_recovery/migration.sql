-- Forward-only repair for databases that already applied T5-B/C before the
-- ambiguous-write recovery reason was introduced. The projection identity and
-- receipt chain remain immutable; only a fenced write cleanup may advance the
-- verified write receipt.

BEGIN;

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

COMMIT;
