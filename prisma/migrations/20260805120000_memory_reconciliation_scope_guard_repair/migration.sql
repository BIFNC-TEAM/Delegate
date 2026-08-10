BEGIN;

-- Repair environments where the reconciliation target guard casts the
-- REPRESENTATIVE_EXPERIENCE source kind as a MemoryScope value. MemoryScope
-- stores representative experience under REPRESENTATIVE.
-- Re-declare the complete guard so fresh and already-migrated databases converge
-- on the same current scope and issue-evidence semantics.
CREATE OR REPLACE FUNCTION "memory_reconciliation_target_guard"()
RETURNS TRIGGER AS $$
DECLARE
  run_record "MemoryReconciliationRun"%ROWTYPE;
  projection_record "MemoryProjectionItem"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
  expected_kind "MemoryReconciliationTargetKind";
  issue_kind "MemoryReconciliationIssueKind";
  issue_observed_content_hash TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO run_record
      FROM "MemoryReconciliationRun"
     WHERE "id" = NEW."reconciliationRunId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;
    SELECT * INTO projection_record
      FROM "MemoryProjectionItem"
     WHERE "id" = NEW."projectionItemId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;
    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = projection_record."memoryVersionId"
       AND "memoryId" = projection_record."memoryId"
       AND "representativeId" = projection_record."representativeId"
     FOR SHARE;
    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = projection_record."memoryId"
       AND "representativeId" = projection_record."representativeId"
     FOR SHARE;
    SELECT * INTO policy_record
      FROM "RepresentativeMemoryPolicy"
     WHERE "representativeId" = NEW."representativeId"
     FOR SHARE;

    IF run_record."id" IS NULL
       OR projection_record."id" IS NULL
       OR version_record."id" IS NULL
       OR memory_record."id" IS NULL
       OR policy_record."representativeId" IS NULL
       OR run_record."status" <> 'RUNNING'::"MemoryReconciliationStatus"
       OR run_record."attemptCount" <> 1
       OR run_record."leaseToken" IS NULL
       OR run_record."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR run_record."provider" IS DISTINCT FROM projection_record."provider"
       OR projection_record."lane" <> 'RECALL'::"MemoryProjectionLane"
       OR NEW."status" <> 'PENDING'::"MemoryReconciliationTargetStatus"
       OR NEW."attemptCount" <> 0
       OR NEW."snapshotProjectionStatus" IS DISTINCT FROM projection_record."status"
       OR NEW."snapshotProjectionUpdatedAt" IS DISTINCT FROM projection_record."updatedAt"
       OR NEW."snapshotAttemptCount" IS DISTINCT FROM projection_record."attemptCount"
       OR NEW."snapshotRemoteUri" IS DISTINCT FROM projection_record."remoteUri"
       OR NEW."expectedContentHash" IS DISTINCT FROM projection_record."contentHash"
       OR NEW."snapshotRemoteUri" NOT LIKE
         'viking://user/delegate-memory-' || policy_record."namespaceKey"
         || '/memories/delegate/' || policy_record."namespaceKey" || '/%'
       OR NEW."snapshotRemoteUri" LIKE 'viking://agent/%'
       OR NEW."snapshotRemoteUri" LIKE 'viking://user/memories/%' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_snapshot_check',
        MESSAGE = 'target must be an exact immutable snapshot of one canonical recall projection';
    END IF;

    IF projection_record."status" = 'PROJECTING'::"MemoryProjectionStatus"
       AND projection_record."leaseToken" IS NOT NULL
       AND projection_record."leaseExpiresAt" > CURRENT_TIMESTAMP THEN
      expected_kind := 'LIVE_IN_FLIGHT'::"MemoryReconciliationTargetKind";
    ELSIF projection_record."status" = 'ACTIVE'::"MemoryProjectionStatus"
       AND projection_record."deleteRequestedAt" IS NULL
       AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
       AND memory_record."recallDisabledAt" IS NULL
       AND (
         memory_record."expiresAt" IS NULL
         OR memory_record."expiresAt" > CURRENT_TIMESTAMP
       )
       AND memory_record."currentVersionId" = projection_record."memoryVersionId"
       AND version_record."purgedAt" IS NULL
       AND version_record."contentHash" = projection_record."contentHash"
       AND policy_record."provider" = projection_record."provider"
       AND policy_record."longTermMemoryEnabled"
       AND (
         (
           memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
           AND policy_record."contactMemoryEnabled"
           AND CASE memory_record."sourceChannel"
             WHEN 'WEB'::"RepresentativeChannelKind"
               THEN policy_record."webRecallEnabled"
             WHEN 'MATRIX'::"RepresentativeChannelKind"
               THEN policy_record."matrixRecallEnabled"
             WHEN 'TELEGRAM'::"RepresentativeChannelKind"
               THEN policy_record."telegramRecallEnabled"
             ELSE FALSE
           END
         )
         OR (
           memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
           AND policy_record."representativeExperienceEnabled"
         )
       ) THEN
      expected_kind := 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind";
    ELSIF projection_record."status" = 'SUPERSEDED'::"MemoryProjectionStatus"
       OR projection_record."deleteRequestedAt" IS NOT NULL
       OR memory_record."status" IN (
         'SUPERSEDED'::"GovernedMemoryStatus",
         'DELETE_PENDING'::"GovernedMemoryStatus",
         'DELETED'::"GovernedMemoryStatus"
       )
       OR (
         memory_record."currentVersionId" IS NOT NULL
         AND memory_record."currentVersionId" <> projection_record."memoryVersionId"
       )
       OR version_record."purgedAt" IS NOT NULL THEN
      expected_kind := 'KNOWN_STALE'::"MemoryReconciliationTargetKind";
    ELSIF projection_record."status" = 'ACTIVE'::"MemoryProjectionStatus" THEN
      expected_kind := 'RETAINED_INACTIVE'::"MemoryReconciliationTargetKind";
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_snapshot_state_check',
        MESSAGE = 'only committed active, stale, or live in-flight recall projections may be targeted';
    END IF;

    IF NEW."kind" IS DISTINCT FROM expected_kind THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_kind_check',
        MESSAGE = 'target kind must reflect the authoritative local snapshot';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."reconciliationRunId" IS DISTINCT FROM OLD."reconciliationRunId"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."projectionItemId" IS DISTINCT FROM OLD."projectionItemId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."snapshotProjectionStatus" IS DISTINCT FROM OLD."snapshotProjectionStatus"
     OR NEW."snapshotProjectionUpdatedAt" IS DISTINCT FROM OLD."snapshotProjectionUpdatedAt"
     OR NEW."snapshotAttemptCount" IS DISTINCT FROM OLD."snapshotAttemptCount"
     OR NEW."snapshotRemoteUri" IS DISTINCT FROM OLD."snapshotRemoteUri"
     OR NEW."expectedContentHash" IS DISTINCT FROM OLD."expectedContentHash"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationTarget_snapshot_immutable_check',
      MESSAGE = 'reconciliation target identity and committed projection snapshot are immutable';
  END IF;

  IF OLD."status" IN (
       'MATCHED'::"MemoryReconciliationTargetStatus",
       'ISSUE'::"MemoryReconciliationTargetStatus",
       'SKIPPED'::"MemoryReconciliationTargetStatus",
       'FAILED'::"MemoryReconciliationTargetStatus"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationTarget_terminal_immutable_check',
      MESSAGE = 'terminal reconciliation target evidence is immutable';
  END IF;

  IF OLD."status" IN (
       'PENDING'::"MemoryReconciliationTargetStatus",
       'RETRYING'::"MemoryReconciliationTargetStatus"
     )
     AND NEW."status" = 'CHECKING'::"MemoryReconciliationTargetStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount" + 1
       OR NEW."leaseToken" IS NULL
       OR NEW."leaseExpiresAt" IS NULL
       OR NEW."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."lastErrorCode" IS NOT NULL
       OR NEW."remoteExists" IS NOT NULL
       OR NEW."observedContentHash" IS NOT NULL
       OR NEW."checkedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_claim_check',
        MESSAGE = 'target claim requires one new attempt and a live clean lease';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
     AND NEW."status" = 'RETRYING'::"MemoryReconciliationTargetStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."lastErrorCode" IS NULL
       OR NEW."remoteExists" IS NOT NULL
       OR NEW."observedContentHash" IS NOT NULL
       OR NEW."checkedAt" IS NOT NULL
       OR (
         OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
         AND NEW."lastErrorCode" <> 'reconciliation_target_lease_expired'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_retry_check',
        MESSAGE = 'target retry must preserve its attempt and release its lease with a stable error';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
     AND NEW."status" IN (
       'MATCHED'::"MemoryReconciliationTargetStatus",
       'ISSUE'::"MemoryReconciliationTargetStatus",
       'SKIPPED'::"MemoryReconciliationTargetStatus",
       'FAILED'::"MemoryReconciliationTargetStatus"
     ) THEN
    IF OLD."leaseToken" IS NULL
       OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationTarget_completion_lease_check',
        MESSAGE = 'target completion requires the current live worker lease';
    END IF;

    IF NEW."status" = 'ISSUE'::"MemoryReconciliationTargetStatus" THEN
      SELECT item."issueKind", item."observedContentHash"
        INTO issue_kind, issue_observed_content_hash
        FROM "MemoryReconciliationItem" item
       WHERE item."reconciliationRunId" = NEW."reconciliationRunId"
         AND item."representativeId" = NEW."representativeId"
         AND item."projectionItemId" = NEW."projectionItemId"
         AND item."itemKey" = 'known_projection:' || NEW."projectionItemId"
         AND item."expectedContentHash" = NEW."expectedContentHash"
         AND item."status" IN (
           'OPEN'::"MemoryReconciliationItemStatus",
           'RETRYING'::"MemoryReconciliationItemStatus"
         )
       LIMIT 1;
      IF issue_kind IS NULL
         OR (
           issue_kind = 'MISSING_REMOTE'::"MemoryReconciliationIssueKind"
           AND (
             NEW."kind" <> 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind"
             OR NEW."remoteExists" IS DISTINCT FROM FALSE
             OR NEW."observedContentHash" IS NOT NULL
             OR issue_observed_content_hash IS NOT NULL
           )
         )
         OR (
           issue_kind = 'HASH_MISMATCH'::"MemoryReconciliationIssueKind"
           AND (
             NEW."kind" <> 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind"
             OR NEW."remoteExists" IS DISTINCT FROM TRUE
             OR NEW."observedContentHash" IS NULL
             OR NEW."observedContentHash" = NEW."expectedContentHash"
             OR issue_observed_content_hash IS DISTINCT FROM NEW."observedContentHash"
           )
         )
         OR (
           issue_kind = 'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
           AND (
             NEW."kind" <> 'KNOWN_STALE'::"MemoryReconciliationTargetKind"
             OR NEW."remoteExists" IS NOT NULL
             OR NEW."observedContentHash" IS NOT NULL
             OR issue_observed_content_hash IS NOT NULL
           )
         )
         OR issue_kind NOT IN (
           'MISSING_REMOTE'::"MemoryReconciliationIssueKind",
           'HASH_MISMATCH'::"MemoryReconciliationIssueKind",
           'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryReconciliationTarget_issue_before_fence_check',
          MESSAGE = 'issue target requires matching open scoped issue evidence';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'MemoryReconciliationTarget_state_transition_check',
    MESSAGE = 'invalid reconciliation target state transition';
END;
$$ LANGUAGE plpgsql;

COMMIT;
