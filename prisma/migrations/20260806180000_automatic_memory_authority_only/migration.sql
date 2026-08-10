-- Historical human-review decisions remain immutable audit records, but they
-- no longer authorize recall. Fail closed for every active memory that lacks
-- a matching automatic decision and withdraw any corresponding projection.
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
   AND NOT EXISTS (
     SELECT 1
       FROM "GovernedMemoryVersion" version
       JOIN "MemoryPolicyDecision" decision
         ON decision."candidateId" = version."sourceCandidateId"
        AND decision."resultVersionId" = version."id"
        AND decision."memoryId" = version."memoryId"
        AND decision."representativeId" = version."representativeId"
        AND decision."outputHash" = version."contentHash"
        AND decision."outcome" IN (
          'ACTIVATED'::"MemoryPolicyDecisionOutcome",
          'UPDATED'::"MemoryPolicyDecisionOutcome"
        )
      WHERE version."id" = memory_record."currentVersionId"
        AND version."memoryId" = memory_record."id"
        AND version."representativeId" = memory_record."representativeId"
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
         ELSE 'legacy_human_authority_retired'
       END,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM "GovernedMemory" memory_record
  JOIN "GovernedMemoryVersion" version
    ON version."id" = memory_record."currentVersionId"
   AND version."memoryId" = memory_record."id"
   AND version."representativeId" = memory_record."representativeId"
 WHERE projection."memoryId" = memory_record."id"
   AND projection."representativeId" = memory_record."representativeId"
   AND projection."status" <> 'DELETED'::"MemoryProjectionStatus"
   AND NOT EXISTS (
     SELECT 1
       FROM "MemoryPolicyDecision" decision
      WHERE decision."candidateId" = version."sourceCandidateId"
        AND decision."resultVersionId" = version."id"
        AND decision."memoryId" = memory_record."id"
        AND decision."representativeId" = memory_record."representativeId"
        AND decision."outputHash" = version."contentHash"
        AND decision."outcome" IN (
          'ACTIVATED'::"MemoryPolicyDecisionOutcome",
          'UPDATED'::"MemoryPolicyDecisionOutcome"
        )
   );

CREATE OR REPLACE FUNCTION "memory_automatic_authority_only_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'::"GovernedMemoryStatus"
     AND (
       NEW."currentVersionId" IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM "GovernedMemoryVersion" version
           JOIN "MemoryPolicyDecision" decision
             ON decision."candidateId" = version."sourceCandidateId"
            AND decision."resultVersionId" = version."id"
            AND decision."memoryId" = NEW."id"
            AND decision."representativeId" = NEW."representativeId"
            AND decision."outputHash" = version."contentHash"
            AND decision."outcome" IN (
              'ACTIVATED'::"MemoryPolicyDecisionOutcome",
              'UPDATED'::"MemoryPolicyDecisionOutcome"
            )
          WHERE version."id" = NEW."currentVersionId"
            AND version."memoryId" = NEW."id"
            AND version."representativeId" = NEW."representativeId"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_automatic_authority_only_check',
      MESSAGE = 'active memory requires an automatic policy decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GovernedMemory_automatic_authority_only_guard"
  ON "GovernedMemory";
CREATE TRIGGER "GovernedMemory_automatic_authority_only_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "memory_automatic_authority_only_guard"();

CREATE OR REPLACE FUNCTION "memory_projection_automatic_authority_only_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'::"MemoryProjectionStatus"
     AND (
       TG_OP = 'INSERT'
       OR OLD."status" <> 'ACTIVE'::"MemoryProjectionStatus"
     )
     AND NOT EXISTS (
       SELECT 1
         FROM "GovernedMemoryVersion" version
         JOIN "MemoryPolicyDecision" decision
           ON decision."candidateId" = version."sourceCandidateId"
          AND decision."resultVersionId" = version."id"
          AND decision."memoryId" = NEW."memoryId"
          AND decision."representativeId" = NEW."representativeId"
          AND decision."outputHash" = version."contentHash"
          AND decision."outcome" IN (
            'ACTIVATED'::"MemoryPolicyDecisionOutcome",
            'UPDATED'::"MemoryPolicyDecisionOutcome"
          )
        WHERE version."id" = NEW."memoryVersionId"
          AND version."memoryId" = NEW."memoryId"
          AND version."representativeId" = NEW."representativeId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_automatic_authority_only_check',
      MESSAGE = 'active recall projection requires an automatic policy decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryProjectionItem_automatic_authority_only_guard"
  ON "MemoryProjectionItem";
CREATE TRIGGER "MemoryProjectionItem_automatic_authority_only_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION
    "memory_projection_automatic_authority_only_guard"();

CREATE OR REPLACE FUNCTION "memory_use_automatic_authority_only_guard"()
RETURNS TRIGGER AS $$
DECLARE
  injection_transition BOOLEAN := FALSE;
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
     )
     AND NOT EXISTS (
       SELECT 1
         FROM "GovernedMemoryVersion" version
         JOIN "MemoryPolicyDecision" decision
           ON decision."candidateId" = version."sourceCandidateId"
          AND decision."resultVersionId" = version."id"
          AND decision."memoryId" = version."memoryId"
          AND decision."representativeId" = NEW."representativeId"
          AND decision."outputHash" = version."contentHash"
          AND decision."outcome" IN (
            'ACTIVATED'::"MemoryPolicyDecisionOutcome",
            'UPDATED'::"MemoryPolicyDecisionOutcome"
          )
        WHERE version."id" = NEW."memoryVersionId"
          AND version."representativeId" = NEW."representativeId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_automatic_authority_only_check',
      MESSAGE = 'model injection requires an automatic policy decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryUseItem_automatic_authority_only_guard"
  ON "MemoryUseItem";
CREATE TRIGGER "MemoryUseItem_automatic_authority_only_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_automatic_authority_only_guard"();
