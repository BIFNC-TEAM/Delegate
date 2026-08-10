-- A MemoryPolicyDecision is system-owned authority. Historical owner
-- corrections may remain for audit, but cannot be relabelled as automatic.
CREATE OR REPLACE FUNCTION "memory_has_non_manual_automatic_authority"(
  representative_id TEXT,
  memory_id TEXT,
  version_id TEXT
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "GovernedMemoryVersion" version
      JOIN "MemoryCandidate" candidate
        ON candidate."id" = version."sourceCandidateId"
       AND candidate."representativeId" = version."representativeId"
      JOIN "MemoryPolicyDecision" decision
        ON decision."candidateId" = candidate."id"
       AND decision."resultVersionId" = version."id"
       AND decision."memoryId" = version."memoryId"
       AND decision."representativeId" = version."representativeId"
       AND decision."outputHash" = version."contentHash"
       AND decision."outcome" IN (
         'ACTIVATED'::"MemoryPolicyDecisionOutcome",
         'UPDATED'::"MemoryPolicyDecisionOutcome"
       )
     WHERE version."id" = version_id
       AND version."memoryId" = memory_id
       AND version."representativeId" = representative_id
       AND candidate."sourceKind" <> 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "memory_policy_non_manual_source_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "MemoryCandidate" candidate
     WHERE candidate."id" = NEW."candidateId"
       AND candidate."representativeId" = NEW."representativeId"
       AND candidate."sourceKind" = 'OWNER_VERIFIED_CORRECTION'::"MemorySourceKind"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicyDecision_non_manual_source_check',
      MESSAGE = 'owner correction cannot be used as automatic memory authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryPolicyDecision_non_manual_source_guard"
  ON "MemoryPolicyDecision";
CREATE TRIGGER "MemoryPolicyDecision_non_manual_source_guard"
  BEFORE INSERT ON "MemoryPolicyDecision"
  FOR EACH ROW EXECUTE FUNCTION "memory_policy_non_manual_source_guard"();

UPDATE "GovernedMemory" memory_record
   SET "status" = 'SUPPRESSED'::"GovernedMemoryStatus",
       "recallDisabledAt" = COALESCE(
         memory_record."recallDisabledAt",
         CURRENT_TIMESTAMP
       ),
       "suppressedAt" = COALESCE(
         memory_record."suppressedAt",
         CURRENT_TIMESTAMP
       ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
   AND NOT "memory_has_non_manual_automatic_authority"(
     memory_record."representativeId",
     memory_record."id",
     memory_record."currentVersionId"
   );

UPDATE "MemoryProjectionItem" projection
   SET "status" = CASE
         WHEN projection."status" IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus"
         ) THEN projection."status"
         ELSE 'DELETE_PENDING'::"MemoryProjectionStatus"
       END,
       "deleteRequestedAt" = COALESCE(
         projection."deleteRequestedAt",
         CURRENT_TIMESTAMP
       ),
       "leaseToken" = CASE
         WHEN projection."status" IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus"
         ) THEN projection."leaseToken"
         ELSE NULL
       END,
       "leaseExpiresAt" = CASE
         WHEN projection."status" IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus"
         ) THEN projection."leaseExpiresAt"
         ELSE NULL
       END,
       "lastErrorCode" = CASE
         WHEN projection."status" IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus"
         ) THEN projection."lastErrorCode"
         ELSE 'manual_memory_policy_source_retired'
       END,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM "GovernedMemory" memory_record
 WHERE projection."memoryId" = memory_record."id"
   AND projection."representativeId" = memory_record."representativeId"
   AND projection."status" <> 'DELETED'::"MemoryProjectionStatus"
   AND NOT "memory_has_non_manual_automatic_authority"(
     memory_record."representativeId",
     memory_record."id",
     projection."memoryVersionId"
   );

CREATE OR REPLACE FUNCTION "memory_non_manual_authority_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'::"GovernedMemoryStatus"
     AND NOT "memory_has_non_manual_automatic_authority"(
       NEW."representativeId",
       NEW."id",
       NEW."currentVersionId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_non_manual_authority_check',
      MESSAGE = 'active memory cannot use a manual correction as authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GovernedMemory_non_manual_authority_guard"
  ON "GovernedMemory";
CREATE TRIGGER "GovernedMemory_non_manual_authority_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "memory_non_manual_authority_guard"();

CREATE OR REPLACE FUNCTION "memory_projection_non_manual_authority_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'::"MemoryProjectionStatus"
     AND (
       TG_OP = 'INSERT'
       OR OLD."status" <> 'ACTIVE'::"MemoryProjectionStatus"
     )
     AND NOT "memory_has_non_manual_automatic_authority"(
       NEW."representativeId",
       NEW."memoryId",
       NEW."memoryVersionId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_non_manual_authority_check',
      MESSAGE = 'active projection cannot use a manual correction as authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_non_manual_authority_guard"
  ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_non_manual_authority_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION
    "memory_projection_non_manual_authority_guard"();

CREATE OR REPLACE FUNCTION "memory_use_non_manual_authority_guard"()
RETURNS TRIGGER AS $$
DECLARE
  injection_transition BOOLEAN := FALSE;
  governed_memory_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    injection_transition := NEW."injectedAt" IS NOT NULL;
  ELSE
    injection_transition := OLD."injectedAt" IS NULL
      AND NEW."injectedAt" IS NOT NULL;
  END IF;

  IF injection_transition
     AND NEW."sourceKind" IN (
       'CONTACT_MEMORY'::"MemoryUseSourceKind",
       'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
     ) THEN
    SELECT version."memoryId" INTO governed_memory_id
      FROM "GovernedMemoryVersion" version
     WHERE version."id" = NEW."memoryVersionId"
       AND version."representativeId" = NEW."representativeId";
    IF governed_memory_id IS NULL
       OR NOT "memory_has_non_manual_automatic_authority"(
         NEW."representativeId",
         governed_memory_id,
         NEW."memoryVersionId"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_non_manual_authority_check',
        MESSAGE = 'model injection cannot use a manual correction as authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryUseItem_non_manual_authority_guard"
  ON "MemoryUseItem";
CREATE TRIGGER "MemoryUseItem_non_manual_authority_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_non_manual_authority_guard"();
