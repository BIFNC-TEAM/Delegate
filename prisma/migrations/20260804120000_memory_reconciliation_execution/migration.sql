-- Memory System T5-E: bounded, exact-only reconciliation execution.
-- OpenViking does not expose a trustworthy point-in-time inventory cursor, so
-- this migration persists only committed local projection targets. It cannot
-- represent or authorize deletion of remote-only objects.

BEGIN;

CREATE TYPE "MemoryReconciliationTargetKind" AS ENUM (
  'EXPECTED_ACTIVE',
  'KNOWN_STALE',
  'RETAINED_INACTIVE',
  'LIVE_IN_FLIGHT'
);

CREATE TYPE "MemoryReconciliationTargetStatus" AS ENUM (
  'PENDING',
  'CHECKING',
  'RETRYING',
  'MATCHED',
  'ISSUE',
  'SKIPPED',
  'FAILED'
);

CREATE TABLE "MemoryReconciliationTarget" (
  "reconciliationRunId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "projectionItemId" TEXT NOT NULL,
  "kind" "MemoryReconciliationTargetKind" NOT NULL,
  "status" "MemoryReconciliationTargetStatus" NOT NULL DEFAULT 'PENDING',
  "snapshotProjectionStatus" "MemoryProjectionStatus" NOT NULL,
  "snapshotProjectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "snapshotAttemptCount" INTEGER NOT NULL,
  "snapshotRemoteUri" TEXT NOT NULL,
  "expectedContentHash" TEXT NOT NULL,
  "remoteExists" BOOLEAN,
  "observedContentHash" TEXT,
  "checkedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryReconciliationTarget_pkey"
    PRIMARY KEY ("reconciliationRunId", "projectionItemId"),
  CONSTRAINT "MemoryReconciliationTarget_run_scope_fkey"
    FOREIGN KEY ("reconciliationRunId", "representativeId")
    REFERENCES "MemoryReconciliationRun"("id", "representativeId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MemoryReconciliationTarget_rep_fkey"
    FOREIGN KEY ("representativeId")
    REFERENCES "Representative"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MemoryReconciliationTarget_projection_scope_fkey"
    FOREIGN KEY ("projectionItemId", "representativeId")
    REFERENCES "MemoryProjectionItem"("id", "representativeId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MemoryReconciliationTarget_attempt_check" CHECK (
    "snapshotAttemptCount" >= 0 AND "attemptCount" >= 0
  ),
  CONSTRAINT "MemoryReconciliationTarget_hash_check" CHECK (
    "expectedContentHash" ~ '^[0-9a-f]{64}$'
    AND (
      "observedContentHash" IS NULL
      OR "observedContentHash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "MemoryReconciliationTarget_text_check" CHECK (
    btrim("snapshotRemoteUri") <> ''
    AND (
      "lastErrorCode" IS NULL
      OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,127}$'
    )
  ),
  CONSTRAINT "MemoryReconciliationTarget_lease_pair_check" CHECK (
    ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryReconciliationTarget_state_shape_check" CHECK (
    (
      "status" = 'PENDING'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" = 0
      AND "leaseToken" IS NULL
      AND "remoteExists" IS NULL
      AND "observedContentHash" IS NULL
      AND "checkedAt" IS NULL
      AND "lastErrorCode" IS NULL
    ) OR (
      "status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NOT NULL
      AND "remoteExists" IS NULL
      AND "observedContentHash" IS NULL
      AND "checkedAt" IS NULL
      AND "lastErrorCode" IS NULL
    ) OR (
      "status" = 'RETRYING'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NULL
      AND "remoteExists" IS NULL
      AND "observedContentHash" IS NULL
      AND "checkedAt" IS NULL
      AND "lastErrorCode" IS NOT NULL
    ) OR (
      "status" = 'MATCHED'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NULL
      AND "remoteExists" IS TRUE
      AND "observedContentHash" = "expectedContentHash"
      AND "checkedAt" IS NOT NULL
      AND "lastErrorCode" IS NULL
    ) OR (
      "status" = 'ISSUE'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NULL
      AND "checkedAt" IS NOT NULL
      AND "lastErrorCode" IS NULL
    ) OR (
      "status" = 'SKIPPED'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NULL
      AND "remoteExists" IS NULL
      AND "observedContentHash" IS NULL
      AND "checkedAt" IS NOT NULL
      AND "lastErrorCode" IS NOT NULL
    ) OR (
      "status" = 'FAILED'::"MemoryReconciliationTargetStatus"
      AND "attemptCount" > 0
      AND "leaseToken" IS NULL
      AND "remoteExists" IS NULL
      AND "observedContentHash" IS NULL
      AND "checkedAt" IS NULL
      AND "lastErrorCode" IS NOT NULL
    )
  )
);

CREATE INDEX "MemoryReconciliationTarget_run_due_idx"
  ON "MemoryReconciliationTarget"(
    "reconciliationRunId", "status", "availableAt", "projectionItemId"
  );
CREATE INDEX "MemoryReconciliationTarget_lease_idx"
  ON "MemoryReconciliationTarget"("status", "leaseExpiresAt");
CREATE INDEX "MemoryReconciliationTarget_projection_idx"
  ON "MemoryReconciliationTarget"("projectionItemId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "MemoryReconciliationRun"
     WHERE "status" IN (
       'QUEUED'::"MemoryReconciliationStatus",
       'RUNNING'::"MemoryReconciliationStatus"
     )
     GROUP BY "representativeId", "provider"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      CONSTRAINT = 'MemoryReconciliationRun_one_active_rep_provider_key',
      MESSAGE = 'multiple active reconciliation runs must be drained before enabling periodic execution';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "MemoryReconciliationRun_one_active_rep_provider_key"
  ON "MemoryReconciliationRun"("representativeId", "provider")
  WHERE "status" IN (
    'QUEUED'::"MemoryReconciliationStatus",
    'RUNNING'::"MemoryReconciliationStatus"
  );

ALTER TABLE "MemoryReconciliationRun"
  ADD CONSTRAINT "MemoryReconciliationRun_execution_shape_check" CHECK (
    btrim("provider") <> ''
    AND btrim("idempotencyKey") <> ''
    AND (
      "idempotencyKey" !~ '^periodic:'
      OR "idempotencyKey" ~ '^periodic:[0-9]+$'
    )
    AND "attemptCount" >= 0
    AND "expectedCount" >= 0
    AND "observedCount" >= 0
    AND "matchedCount" >= 0
    AND "issueCount" >= 0
    AND "resolvedCount" >= 0
    AND "observedCount" <= "expectedCount"
    AND "matchedCount" <= "observedCount"
    AND "issueCount" <= "expectedCount"
    AND "resolvedCount" <= "issueCount"
    AND ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
    AND (
      "errorCode" IS NULL
      OR "errorCode" ~ '^[a-z][a-z0-9_]{0,127}$'
    )
    AND "status" <> 'SUCCEEDED'::"MemoryReconciliationStatus"
    AND (
      (
        "status" = 'QUEUED'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NULL
        AND "finishedAt" IS NULL
        AND "errorCode" IN (
          'reconciliation_run_lease_expired',
          'reconciliation_work_remaining'
        )
      )
      OR (
        "status" = 'QUEUED'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NULL
        AND "finishedAt" IS NULL
        AND "errorCode" IS NULL
      )
      OR (
        "status" = 'RUNNING'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NOT NULL
        AND "finishedAt" IS NULL
        AND "errorCode" IS NULL
      )
      OR (
        "status" = 'PARTIAL'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NULL
        AND "finishedAt" IS NOT NULL
        AND "errorCode" = 'openviking_inventory_no_snapshot_cursor'
      )
      OR (
        "status" = 'FAILED'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NULL
        AND "finishedAt" IS NOT NULL
        AND "errorCode" IS NOT NULL
      )
      OR (
        "status" = 'CANCELED'::"MemoryReconciliationStatus"
        AND "leaseToken" IS NULL
        AND "finishedAt" IS NOT NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION "memory_reconciliation_run_execution_guard"()
RETURNS TRIGGER AS $$
DECLARE
  resolution_rollup BOOLEAN;
  actual_expected INTEGER;
  actual_observed INTEGER;
  actual_matched INTEGER;
  actual_issues INTEGER;
  actual_resolved INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUEUED'::"MemoryReconciliationStatus"
       OR NEW."attemptCount" <> 0
       OR NEW."expectedCount" <> 0
       OR NEW."observedCount" <> 0
       OR NEW."matchedCount" <> 0
       OR NEW."issueCount" <> 0
       OR NEW."resolvedCount" <> 0
       OR NEW."cursor" IS NOT NULL
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."startedAt" IS NOT NULL
       OR NEW."finishedAt" IS NOT NULL
       OR NEW."errorCode" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationRun_initial_state_check',
        MESSAGE = 'reconciliation run must start as an empty unleased queue item';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationRun_locked_coordinates_check',
      MESSAGE = 'reconciliation run identity and provider coordinates are immutable';
  END IF;

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE target."remoteExists" IS TRUE)::INTEGER,
         COUNT(*) FILTER (
           WHERE target."status" = 'MATCHED'::"MemoryReconciliationTargetStatus"
         )::INTEGER,
         COUNT(*) FILTER (
           WHERE target."status" = 'ISSUE'::"MemoryReconciliationTargetStatus"
         )::INTEGER
    INTO actual_expected, actual_observed, actual_matched, actual_issues
    FROM "MemoryReconciliationTarget" target
   WHERE target."reconciliationRunId" = NEW."id";
  SELECT COUNT(*)::INTEGER
    INTO actual_resolved
    FROM "MemoryReconciliationItem" item
   WHERE item."reconciliationRunId" = NEW."id"
     AND item."status" = 'RESOLVED'::"MemoryReconciliationItemStatus";

  resolution_rollup :=
    NEW."status" = OLD."status"
    AND OLD."status" IN (
      'QUEUED'::"MemoryReconciliationStatus",
      'PARTIAL'::"MemoryReconciliationStatus",
      'FAILED'::"MemoryReconciliationStatus",
      'CANCELED'::"MemoryReconciliationStatus"
    )
    AND NEW."resolvedCount" >= OLD."resolvedCount"
    AND NEW."resolvedCount" = actual_resolved
    AND NEW."asOf" IS NOT DISTINCT FROM OLD."asOf"
    AND NEW."expectedCount" = OLD."expectedCount"
    AND NEW."observedCount" = OLD."observedCount"
    AND NEW."matchedCount" = OLD."matchedCount"
    AND NEW."issueCount" = OLD."issueCount"
    AND NEW."cursor" IS NOT DISTINCT FROM OLD."cursor"
    AND NEW."attemptCount" = OLD."attemptCount"
    AND NEW."availableAt" IS NOT DISTINCT FROM OLD."availableAt"
    AND NEW."leaseToken" IS NOT DISTINCT FROM OLD."leaseToken"
    AND NEW."leaseExpiresAt" IS NOT DISTINCT FROM OLD."leaseExpiresAt"
    AND NEW."startedAt" IS NOT DISTINCT FROM OLD."startedAt"
    AND NEW."finishedAt" IS NOT DISTINCT FROM OLD."finishedAt"
    AND NEW."errorCode" IS NOT DISTINCT FROM OLD."errorCode";

  IF OLD."status" IN (
       'PARTIAL'::"MemoryReconciliationStatus",
       'FAILED'::"MemoryReconciliationStatus",
       'CANCELED'::"MemoryReconciliationStatus",
       'SUCCEEDED'::"MemoryReconciliationStatus"
     ) THEN
    IF resolution_rollup THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationRun_terminal_immutable_check',
      MESSAGE = 'terminal reconciliation runs are immutable except for monotonic resolution rollup';
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF resolution_rollup THEN
      RETURN NEW;
    END IF;
    IF OLD."status" = 'RUNNING'::"MemoryReconciliationStatus"
       AND NEW."attemptCount" = OLD."attemptCount"
       AND NEW."leaseToken" IS NOT DISTINCT FROM OLD."leaseToken"
       AND NEW."leaseExpiresAt" IS NOT DISTINCT FROM OLD."leaseExpiresAt"
       AND NEW."asOf" IS NOT DISTINCT FROM OLD."asOf"
       AND NEW."startedAt" IS NOT DISTINCT FROM OLD."startedAt"
       AND NEW."finishedAt" IS NULL
       AND NEW."errorCode" IS NULL
       AND NEW."availableAt" IS NOT DISTINCT FROM OLD."availableAt"
       AND NEW."cursor" IS NOT DISTINCT FROM OLD."cursor"
       AND NEW."expectedCount" = actual_expected
       AND NEW."observedCount" = OLD."observedCount"
       AND NEW."matchedCount" = OLD."matchedCount"
       AND NEW."issueCount" = OLD."issueCount"
       AND NEW."resolvedCount" = OLD."resolvedCount" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationRun_same_state_mutation_check',
      MESSAGE = 'reconciliation run state may change only through its worker lifecycle';
  END IF;

  IF OLD."status" = 'QUEUED'::"MemoryReconciliationStatus"
     AND NEW."status" = 'RUNNING'::"MemoryReconciliationStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount" + 1
       OR NEW."leaseToken" IS NULL
       OR NEW."leaseExpiresAt" IS NULL
       OR NEW."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."startedAt" IS NULL
       OR NEW."finishedAt" IS NOT NULL
       OR NEW."errorCode" IS NOT NULL
       OR NEW."expectedCount" <> OLD."expectedCount"
       OR NEW."observedCount" <> OLD."observedCount"
       OR NEW."matchedCount" <> OLD."matchedCount"
       OR NEW."issueCount" <> OLD."issueCount"
       OR NEW."resolvedCount" <> OLD."resolvedCount"
       OR NEW."cursor" IS DISTINCT FROM OLD."cursor"
       OR (
         OLD."attemptCount" > 0
         AND NEW."asOf" IS DISTINCT FROM OLD."asOf"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationRun_claim_check',
        MESSAGE = 'run claim requires one new attempt and a live lease without rewriting prior coverage';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RUNNING'::"MemoryReconciliationStatus"
     AND NEW."status" = 'QUEUED'::"MemoryReconciliationStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."finishedAt" IS NOT NULL
       OR NEW."asOf" IS DISTINCT FROM OLD."asOf"
       OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."expectedCount" <> actual_expected
       OR NEW."observedCount" <> actual_observed
       OR NEW."matchedCount" <> actual_matched
       OR NEW."issueCount" <> actual_issues
       OR NEW."resolvedCount" <> actual_resolved
       OR NEW."errorCode" NOT IN (
         'reconciliation_run_lease_expired',
         'reconciliation_work_remaining'
       )
       OR (
         NEW."errorCode" = 'reconciliation_run_lease_expired'
         AND OLD."leaseExpiresAt" > CURRENT_TIMESTAMP
       )
       OR (
         NEW."errorCode" = 'reconciliation_work_remaining'
         AND OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationRun_requeue_check',
        MESSAGE = 'run requeue must release its lease and preserve monotonic coverage';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RUNNING'::"MemoryReconciliationStatus"
     AND NEW."status" = 'PARTIAL'::"MemoryReconciliationStatus" THEN
    IF NEW."attemptCount" <> OLD."attemptCount"
       OR OLD."leaseToken" IS NULL
       OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."leaseToken" IS NOT NULL
       OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."finishedAt" IS NULL
       OR NEW."errorCode" <> 'openviking_inventory_no_snapshot_cursor'
       OR NEW."asOf" IS DISTINCT FROM OLD."asOf"
       OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."expectedCount" <> actual_expected
       OR NEW."observedCount" <> actual_observed
       OR NEW."matchedCount" <> actual_matched
       OR NEW."issueCount" <> actual_issues
       OR NEW."resolvedCount" <> actual_resolved THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationRun_partial_check',
        MESSAGE = 'exact-only reconciliation must finish as auditable partial truth';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RUNNING'::"MemoryReconciliationStatus"
     AND NEW."status" IN (
       'FAILED'::"MemoryReconciliationStatus",
       'CANCELED'::"MemoryReconciliationStatus"
     )
     AND NEW."attemptCount" = OLD."attemptCount"
     AND NEW."leaseToken" IS NULL
     AND NEW."leaseExpiresAt" IS NULL
     AND NEW."finishedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'MemoryReconciliationRun_state_transition_check',
    MESSAGE = 'invalid reconciliation run state transition';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryReconciliationRun_execution_guard"
  ON "MemoryReconciliationRun";
CREATE TRIGGER "MemoryReconciliationRun_execution_guard"
  BEFORE INSERT OR UPDATE ON "MemoryReconciliationRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_reconciliation_run_execution_guard"();

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

DROP TRIGGER IF EXISTS "MemoryReconciliationTarget_guard"
  ON "MemoryReconciliationTarget";
CREATE TRIGGER "MemoryReconciliationTarget_guard"
  BEFORE INSERT OR UPDATE ON "MemoryReconciliationTarget"
  FOR EACH ROW EXECUTE FUNCTION "memory_reconciliation_target_guard"();

ALTER TABLE "MemoryReconciliationItem"
  ADD CONSTRAINT "MemoryReconciliationItem_resolution_shape_check" CHECK (
    (
      "status" IN (
        'RESOLVED'::"MemoryReconciliationItemStatus",
        'IGNORED'::"MemoryReconciliationItemStatus"
      )
    ) = ("resolvedAt" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "memory_reconciliation_item_resolution_guard"()
RETURNS TRIGGER AS $$
DECLARE
  target_record "MemoryReconciliationTarget"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO target_record
      FROM "MemoryReconciliationTarget" target
     WHERE target."reconciliationRunId" = NEW."reconciliationRunId"
       AND target."representativeId" = NEW."representativeId"
       AND target."projectionItemId" = NEW."projectionItemId"
     FOR SHARE;
    IF NEW."status" <> 'OPEN'::"MemoryReconciliationItemStatus"
       OR NEW."attemptCount" <> 0
       OR NEW."resolvedAt" IS NOT NULL
       OR NEW."lastErrorCode" IS NOT NULL
       OR NEW."projectionItemId" IS NULL
       OR NEW."itemKey" <> 'known_projection:' || NEW."projectionItemId"
       OR NEW."expectedContentHash" IS NULL
       OR NEW."expectedContentHash" !~ '^[0-9a-f]{64}$'
       OR NEW."remoteObjectIdHash" IS NULL
       OR NEW."remoteObjectIdHash" !~ '^[0-9a-f]{64}$'
       OR target_record."projectionItemId" IS NULL
       OR target_record."status" <> 'CHECKING'::"MemoryReconciliationTargetStatus"
       OR target_record."leaseToken" IS NULL
       OR target_record."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR target_record."expectedContentHash" IS DISTINCT FROM NEW."expectedContentHash"
       OR (
         NEW."issueKind" = 'MISSING_REMOTE'::"MemoryReconciliationIssueKind"
         AND (
           target_record."kind" <> 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind"
           OR NEW."reasonCode" <> 'reconciliation_missing_remote'
           OR NEW."observedContentHash" IS NOT NULL
         )
       )
       OR (
         NEW."issueKind" = 'HASH_MISMATCH'::"MemoryReconciliationIssueKind"
         AND (
           target_record."kind" <> 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind"
           OR NEW."reasonCode" <> 'reconciliation_hash_mismatch'
           OR NEW."observedContentHash" IS NULL
           OR NEW."observedContentHash" = NEW."expectedContentHash"
         )
       )
       OR (
         NEW."issueKind" = 'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
         AND (
           target_record."kind" <> 'KNOWN_STALE'::"MemoryReconciliationTargetKind"
           OR NEW."reasonCode" <> 'reconciliation_stale_active_pointer'
           OR NEW."observedContentHash" IS NOT NULL
         )
       )
       OR NEW."issueKind" NOT IN (
         'MISSING_REMOTE'::"MemoryReconciliationIssueKind",
         'HASH_MISMATCH'::"MemoryReconciliationIssueKind",
         'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationItem_initial_evidence_check',
        MESSAGE = 'reconciliation issue must start open and match one live claimed local target';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reconciliationRunId" IS DISTINCT FROM OLD."reconciliationRunId"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."projectionItemId" IS DISTINCT FROM OLD."projectionItemId"
     OR NEW."itemKey" IS DISTINCT FROM OLD."itemKey"
     OR NEW."issueKind" IS DISTINCT FROM OLD."issueKind"
     OR NEW."expectedContentHash" IS DISTINCT FROM OLD."expectedContentHash"
     OR NEW."observedContentHash" IS DISTINCT FROM OLD."observedContentHash"
     OR NEW."remoteObjectIdHash" IS DISTINCT FROM OLD."remoteObjectIdHash"
     OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationItem_evidence_immutable_check',
      MESSAGE = 'reconciliation issue identity and observed evidence are immutable';
  END IF;

  IF OLD."status" IN (
       'RESOLVED'::"MemoryReconciliationItemStatus",
       'IGNORED'::"MemoryReconciliationItemStatus",
       'FAILED'::"MemoryReconciliationItemStatus"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationItem_terminal_immutable_check',
      MESSAGE = 'terminal reconciliation issue evidence is immutable';
  END IF;

  IF NEW."status" = 'RESOLVED'::"MemoryReconciliationItemStatus"
     AND OLD."status" <> 'RESOLVED'::"MemoryReconciliationItemStatus" THEN
    IF OLD."status" NOT IN (
         'OPEN'::"MemoryReconciliationItemStatus",
         'RETRYING'::"MemoryReconciliationItemStatus"
       )
       OR NEW."projectionItemId" IS NULL
       OR NEW."resolvedAt" IS NULL
       OR NEW."lastErrorCode" IS NOT NULL
       OR NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationItem_resolution_transition_check',
        MESSAGE = 'only an open scoped projection issue may be resolved';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'OPEN'::"MemoryReconciliationItemStatus"
     AND NEW."status" = 'IGNORED'::"MemoryReconciliationItemStatus" THEN
    SELECT * INTO target_record
      FROM "MemoryReconciliationTarget" target
     WHERE target."reconciliationRunId" = NEW."reconciliationRunId"
       AND target."representativeId" = NEW."representativeId"
       AND target."projectionItemId" = NEW."projectionItemId"
     FOR SHARE;
    IF target_record."projectionItemId" IS NULL
       OR target_record."status" <> 'CHECKING'::"MemoryReconciliationTargetStatus"
       OR target_record."leaseToken" IS NULL
       OR target_record."leaseExpiresAt" <= CURRENT_TIMESTAMP
       OR NEW."resolvedAt" IS NULL
       OR NEW."lastErrorCode" <> 'reconciliation_moving_target'
       OR NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReconciliationItem_cas_ignore_check',
        MESSAGE = 'issue may be ignored only while its claimed target is proven moving';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'MemoryReconciliationItem_state_transition_check',
    MESSAGE = 'invalid reconciliation issue state transition';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryReconciliationItem_resolution_guard"
  ON "MemoryReconciliationItem";
CREATE TRIGGER "MemoryReconciliationItem_resolution_guard"
  BEFORE INSERT OR UPDATE ON "MemoryReconciliationItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_reconciliation_item_resolution_guard"();

-- Projection completion and issue resolution deliberately happen in one
-- data-modifying CTE. Validate the receipt at transaction end so the guard
-- sees the final projection state instead of the statement snapshot.
CREATE OR REPLACE FUNCTION "memory_reconciliation_item_resolution_receipt_guard"()
RETURNS TRIGGER AS $$
DECLARE
  projection_record "MemoryProjectionItem"%ROWTYPE;
BEGIN
  SELECT * INTO projection_record
    FROM "MemoryProjectionItem"
   WHERE "id" = NEW."projectionItemId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF projection_record."id" IS NULL
     OR (
       NEW."issueKind" IN (
         'MISSING_REMOTE'::"MemoryReconciliationIssueKind",
         'HASH_MISMATCH'::"MemoryReconciliationIssueKind"
       )
       AND NOT (
         (
           projection_record."status" = 'ACTIVE'::"MemoryProjectionStatus"
           AND projection_record."contentHash" = NEW."expectedContentHash"
           AND projection_record."writeReceiptHash" IS NOT NULL
           AND projection_record."writeVerifiedAt" IS NOT NULL
           AND projection_record."lastErrorCode" IS NULL
         )
         OR (
           projection_record."status" = 'DELETED'::"MemoryProjectionStatus"
           AND projection_record."contentHash" = NEW."expectedContentHash"
           AND projection_record."deleteReceiptHash" IS NOT NULL
           AND projection_record."remoteAbsentAt" IS NOT NULL
           AND projection_record."deletedAt" IS NOT NULL
         )
       )
     )
     OR (
       NEW."issueKind" = 'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"
       AND (
         projection_record."status" <> 'DELETED'::"MemoryProjectionStatus"
         OR projection_record."deleteReceiptHash" IS NULL
         OR projection_record."remoteAbsentAt" IS NULL
         OR projection_record."deletedAt" IS NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryReconciliationItem_resolution_receipt_check',
      MESSAGE = 'issue resolution requires a verified exact write or confirmed exact deletion';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MemoryReconciliationItem_resolution_receipt_guard"
  ON "MemoryReconciliationItem";
CREATE CONSTRAINT TRIGGER "MemoryReconciliationItem_resolution_receipt_guard"
  AFTER UPDATE ON "MemoryReconciliationItem"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    NEW."status" = 'RESOLVED'::"MemoryReconciliationItemStatus"
    AND OLD."status" <> 'RESOLVED'::"MemoryReconciliationItemStatus"
  )
  EXECUTE FUNCTION "memory_reconciliation_item_resolution_receipt_guard"();

COMMIT;
