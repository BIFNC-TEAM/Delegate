BEGIN;

-- P0 exposes governed long-term memory on Web only. Normalize any policy
-- written by an earlier build before making the invariant structural.
-- LEGACY_MEMORY_POLICY_NORMALIZATION_BEGIN
UPDATE "RepresentativeMemoryPolicy"
   SET "autoExtract" = CASE
         WHEN NOT "contactMemoryEnabled" THEN false
         ELSE "autoExtract"
       END,
       "webExtractEnabled" = CASE
         WHEN NOT "contactMemoryEnabled" OR NOT "autoExtract" THEN false
         ELSE "webExtractEnabled"
       END,
       "matrixRecallEnabled" = false,
       "matrixExtractEnabled" = false,
       "telegramRecallEnabled" = false,
       "telegramExtractEnabled" = false,
       "revision" = "revision" + 1,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "matrixRecallEnabled"
    OR "matrixExtractEnabled"
    OR "telegramRecallEnabled"
    OR "telegramExtractEnabled"
    OR ("autoExtract" AND NOT "contactMemoryEnabled")
    OR (
      "webExtractEnabled"
      AND (NOT "contactMemoryEnabled" OR NOT "autoExtract")
    );
-- LEGACY_MEMORY_POLICY_NORMALIZATION_END

ALTER TABLE "RepresentativeMemoryPolicy"
  DROP CONSTRAINT "MemoryPolicy_safe_enablement_check",
  ADD CONSTRAINT "MemoryPolicy_safe_enablement_check" CHECK (
    (NOT "contactMemoryEnabled" OR "longTermMemoryEnabled")
    AND (NOT "representativeExperienceEnabled" OR "longTermMemoryEnabled")
    AND (NOT "autoExtract" OR (
      "longTermMemoryEnabled" AND "contactMemoryEnabled"
    ))
    AND (NOT "webRecallEnabled" OR "longTermMemoryEnabled")
    AND (NOT "webExtractEnabled" OR (
      "longTermMemoryEnabled" AND "contactMemoryEnabled" AND "autoExtract"
    ))
  ),
  ADD CONSTRAINT "MemoryPolicy_p0_web_only_check" CHECK (
    NOT "matrixRecallEnabled"
    AND NOT "matrixExtractEnabled"
    AND NOT "telegramRecallEnabled"
    AND NOT "telegramExtractEnabled"
  );

CREATE TYPE "PublicKnowledgeProjectionSourceKind" AS ENUM (
  'REPRESENTATIVE_VERSION_RESOURCE',
  'KNOWLEDGE_ASSET'
);

CREATE TABLE "RepresentativeVersionResource" (
  "publishedVersionId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "sourceKind" "PublicKnowledgeProjectionSourceKind" NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "knowledgeAssetId" TEXT,
  "contentHash" TEXT NOT NULL,
  "safeText" TEXT NOT NULL,
  "citationTitle" VARCHAR(200),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RepresentativeVersionResource_pkey"
    PRIMARY KEY ("publishedVersionId", "resourceKey"),
  CONSTRAINT "RepresentativeVersionResource_version_resource_hash_key"
    UNIQUE ("publishedVersionId", "resourceKey", "contentHash"),
  CONSTRAINT "RepresentativeVersionResource_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "RepresentativeVersionResource_text_check" CHECK (
    btrim("resourceKey") <> ''
    AND btrim("safeText") <> ''
    AND (
      "citationTitle" IS NULL
      OR (
        btrim("citationTitle") <> ''
        AND "citationTitle" = btrim("citationTitle")
      )
    )
    AND "resourceKey" = btrim("resourceKey")
    AND "resourceKey" !~ '[[:space:]\\%?#]'
    AND "resourceKey" !~ '(^/|/$|(^|/)\.\.(/|$))'
  ),
  CONSTRAINT "RepresentativeVersionResource_source_shape_check" CHECK (
    (
      "sourceKind" = 'REPRESENTATIVE_VERSION_RESOURCE'::"PublicKnowledgeProjectionSourceKind"
      AND "knowledgeAssetId" IS NULL
      AND "resourceKey" IN (
        'identity/profile.md',
        'faq/index.md',
        'materials/index.md',
        'policies/index.md',
        'pricing/index.md'
      )
    ) OR (
      "sourceKind" = 'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind"
      AND "knowledgeAssetId" IS NOT NULL
      AND "resourceKey" = 'knowledge/' || "knowledgeAssetId" || '.md'
    )
  ),
  CONSTRAINT "RepresentativeVersionResource_rep_fkey"
    FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RepresentativeVersionResource_version_scope_fkey"
    FOREIGN KEY ("publishedVersionId", "representativeId")
    REFERENCES "RepresentativeVersion"("id", "representativeId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "RepresentativeVersionResource_rep_version_idx"
  ON "RepresentativeVersionResource"("representativeId", "publishedVersionId", "createdAt");
CREATE INDEX "RepresentativeVersionResource_asset_idx"
  ON "RepresentativeVersionResource"("knowledgeAssetId", "createdAt");

CREATE TABLE "PublicKnowledgeProjectionItem" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "publishedVersionId" TEXT NOT NULL,
  "sourceKind" "PublicKnowledgeProjectionSourceKind" NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "knowledgeAssetId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'openviking',
  "contentHash" TEXT NOT NULL,
  "remoteUri" TEXT NOT NULL,
  "projectedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PublicKnowledgeProjectionItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicKnowledgeProjectionItem_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "PublicKnowledgeProjectionItem_version_resource_key" UNIQUE ("publishedVersionId", "resourceKey"),
  CONSTRAINT "PublicKnowledgeProjectionItem_provider_uri_key" UNIQUE ("provider", "remoteUri"),
  CONSTRAINT "PublicKnowledgeProjectionItem_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PublicKnowledgeProjectionItem_text_check" CHECK (
    btrim("provider") <> ''
    AND btrim("resourceKey") <> ''
    AND btrim("remoteUri") <> ''
    AND "resourceKey" = btrim("resourceKey")
    AND "remoteUri" = btrim("remoteUri")
    AND "resourceKey" !~ '[[:space:]\\%?#]'
    AND "resourceKey" !~ '(^/|/$|(^|/)\.\.(/|$))'
    AND "remoteUri" !~ '[[:space:]\\%?#]'
  ),
  CONSTRAINT "PublicKnowledgeProjectionItem_source_shape_check" CHECK (
    (
      "sourceKind" = 'REPRESENTATIVE_VERSION_RESOURCE'::"PublicKnowledgeProjectionSourceKind"
      AND "knowledgeAssetId" IS NULL
      AND "resourceKey" IN (
        'identity/profile.md',
        'faq/index.md',
        'materials/index.md',
        'policies/index.md',
        'pricing/index.md'
      )
    ) OR (
      "sourceKind" = 'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind"
      AND "knowledgeAssetId" IS NOT NULL
      AND "resourceKey" LIKE 'knowledge/%'
    )
  )
);

CREATE INDEX "PublicKnowledgeProjectionItem_rep_version_idx"
  ON "PublicKnowledgeProjectionItem"("representativeId", "publishedVersionId", "createdAt");
CREATE INDEX "PublicKnowledgeProjectionItem_asset_idx"
  ON "PublicKnowledgeProjectionItem"("knowledgeAssetId", "createdAt");

ALTER TABLE "PublicKnowledgeProjectionItem"
  ADD CONSTRAINT "PublicKnowledgeProjectionItem_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublicKnowledgeProjectionItem_version_scope_fkey"
  FOREIGN KEY ("publishedVersionId", "representativeId")
  REFERENCES "RepresentativeVersion"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublicKnowledgeProjectionItem_resource_manifest_fkey"
  FOREIGN KEY ("publishedVersionId", "resourceKey", "contentHash")
  REFERENCES "RepresentativeVersionResource"(
    "publishedVersionId", "resourceKey", "contentHash"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Remove raw recall coordinates from every nesting level of legacy audit
-- payloads. No URI, score, layer, or candidate identity is retained here.
CREATE FUNCTION "memory_scrub_selected_recall_uris"(input_value JSONB)
RETURNS JSONB AS $$
  SELECT CASE jsonb_typeof(input_value)
    WHEN 'object' THEN COALESCE((
      SELECT jsonb_object_agg(entry.key, "memory_scrub_selected_recall_uris"(entry.value))
        FROM jsonb_each(input_value) AS entry
       WHERE entry.key <> 'selectedRecallUris'
    ), '{}'::JSONB)
    WHEN 'array' THEN COALESCE((
      SELECT jsonb_agg("memory_scrub_selected_recall_uris"(element.value))
        FROM jsonb_array_elements(input_value) AS element(value)
    ), '[]'::JSONB)
    ELSE input_value
  END;
$$ LANGUAGE SQL IMMUTABLE STRICT;

UPDATE "EventAudit"
   SET "payload" = "memory_scrub_selected_recall_uris"("payload")
 WHERE "payload"::TEXT LIKE '%"selectedRecallUris"%';

DROP FUNCTION "memory_scrub_selected_recall_uris"(JSONB);

DROP TRIGGER "MemoryUseItem_scope_guard" ON "MemoryUseItem";
DROP FUNCTION "memory_use_item_scope_guard"();

-- Pre-T6 citations were selected by URI before generation and have no nonce
-- proof of model citation. Clear the old relationship first, then remove every
-- historical citation. Injection facts remain, but cited/displayed truth starts
-- at zero under the new protocol.
-- HISTORICAL_CITATION_SCRUB_BEGIN
ALTER TABLE "MemoryUseItem"
  DROP CONSTRAINT "MemoryUseItem_citation_fkey";

UPDATE "MemoryUseItem"
   SET "displayedCitationId" = NULL,
       "displayedAt" = NULL
 WHERE "displayedCitationId" IS NOT NULL
    OR "displayedAt" IS NOT NULL;

DELETE FROM "MessageCitation";

ALTER TABLE "MessageCitation"
  DROP COLUMN "uri",
  DROP COLUMN "score";
-- HISTORICAL_CITATION_SCRUB_END

DROP TABLE "ConversationRecallTrace";

DROP TRIGGER "MemoryUseRun_channel_guard" ON "MemoryUseRun";
DROP FUNCTION "memory_use_run_channel_guard"();

-- LEGACY_MEMORY_USE_REMEDIATION_BEGIN
-- Preserve an old run only when one exact generation has the same
-- conversation, input message, and published version. Unmappable runs and
-- public items had no authoritative provenance under the old schema, so they
-- are removed instead of manufacturing generation IDs, projection IDs, or
-- remote URIs. Retained governed-memory facts keep their stage timestamps.
-- LEGACY_MEMORY_USE_GENERATION_MAPPING_BEGIN
WITH generation_candidates AS (
  SELECT use_run."id" AS "useRunId",
         generation."id" AS "generationRunId",
         COUNT(*) OVER (PARTITION BY use_run."id") AS "generationCount",
         COUNT(*) OVER (PARTITION BY generation."id") AS "useRunCount"
    FROM "MemoryUseRun" AS use_run
    JOIN "GenerationRun" AS generation
      ON generation."conversationId" = use_run."conversationId"
     AND generation."inputMessageId" = use_run."inputMessageId"
     AND generation."representativeVersionId" = use_run."representativeVersionId"
   WHERE use_run."generationRunId" IS NULL
     AND NOT EXISTS (
       SELECT 1
        FROM "MemoryUseRun" AS bound_run
        WHERE bound_run."generationRunId" = generation."id"
     )
), exact_generation AS (
  SELECT "useRunId", "generationRunId"
    FROM generation_candidates
   WHERE "generationCount" = 1
     AND "useRunCount" = 1
)
UPDATE "MemoryUseRun" AS use_run
   SET "generationRunId" = exact_generation."generationRunId",
       "updatedAt" = CURRENT_TIMESTAMP
  FROM exact_generation
 WHERE use_run."id" = exact_generation."useRunId";

DELETE FROM "MemoryUseRun"
 WHERE "generationRunId" IS NULL;
-- LEGACY_MEMORY_USE_GENERATION_MAPPING_END

-- STARTED + completedAt was legal under the previous one-way terminal check.
-- Preserve the completion fact, but make the row explicitly failed before
-- current-Episode re-proof so a later release does not make that historical
-- completion look like abandoned open work.
UPDATE "MemoryUseRun"
   SET "status" = 'FAILED'::"MemoryUseRunStatus",
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "status" = 'STARTED'::"MemoryUseRunStatus"
   AND "completedAt" IS NOT NULL;

-- Re-prove every pre-existing binding against the stricter generation truth
-- contract. The previous trigger checked only the representative version for
-- already-bound runs, so a legacy row could point at another input or output
-- message while still satisfying all old constraints. Such rows are not safe
-- to attribute and are removed with their cascade-owned items.
DELETE FROM "MemoryUseRun" AS use_run
 WHERE NOT EXISTS (
   SELECT 1
     FROM "GenerationRun" AS generation
     JOIN "Representative" AS representative
       ON representative."id" = use_run."representativeId"
     JOIN "RepresentativeVersion" AS published_version
       ON published_version."id" = use_run."representativeVersionId"
      AND published_version."representativeId" = use_run."representativeId"
      AND published_version."status" = 'PUBLISHED'
     JOIN "Conversation" AS conversation
      ON conversation."id" = use_run."conversationId"
      AND conversation."representativeId" = use_run."representativeId"
      AND conversation."contactId" = use_run."contactId"
      AND conversation."sourceChannel" = use_run."sourceChannel"::TEXT
     LEFT JOIN "ConversationEpisode" AS episode
       ON episode."id" = generation."episodeId"
     LEFT JOIN "Message" AS output_message
       ON output_message."id" = use_run."outputMessageId"
      AND output_message."conversationId" = use_run."conversationId"
    WHERE generation."id" = use_run."generationRunId"
      AND generation."conversationId" = use_run."conversationId"
      AND generation."inputMessageId" = use_run."inputMessageId"
      AND generation."representativeVersionId" = use_run."representativeVersionId"
      AND (
        generation."episodeId" IS NULL
        OR (
          generation."episodeId" IS NOT NULL
          AND episode."conversationId" = use_run."conversationId"
          AND episode."representativeVersionId" = use_run."representativeVersionId"
        )
      )
      AND (
        use_run."status" <> 'STARTED'::"MemoryUseRunStatus"
        OR (
          generation."episodeId" IS NULL
          AND conversation."activeEpisodeId" IS NULL
          AND representative."activeVersionId" = use_run."representativeVersionId"
        ) OR (
          generation."episodeId" IS NOT NULL
          AND conversation."activeEpisodeId" = generation."episodeId"
          AND episode."status" = 'ACTIVE'::"ConversationEpisodeStatus"
        )
      )
      AND (
        use_run."outputMessageId" IS NULL
        OR (
          generation."outputMessageId" = use_run."outputMessageId"
          AND output_message."id" IS NOT NULL
        )
      )
      AND (
        use_run."status" NOT IN (
          'COMPLETED'::"MemoryUseRunStatus",
          'DEGRADED'::"MemoryUseRunStatus"
        ) OR (
          generation."status" = 'COMPLETED'::"GenerationRunStatus"
          AND output_message."senderType" = 'REPRESENTATIVE'::"MessageSenderType"
          AND output_message."deliveryStatus" IN (
            'ACCEPTED'::"MessageDeliveryStatus",
            'QUEUED'::"MessageDeliveryStatus",
            'PROCESSING'::"MessageDeliveryStatus",
            'SENT'::"MessageDeliveryStatus"
          )
        )
      )
 );

-- LEGACY_MEMORY_USE_REJECTION_NORMALIZATION_BEGIN
DELETE FROM "MemoryUseItem"
 WHERE "sourceKind" = 'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind";

-- A free-form legacy reason was not proof that either the scope or safety
-- check failed. Retain it only where a failed check is structurally visible;
-- otherwise clear it rather than manufacturing a rejection.
UPDATE "MemoryUseItem"
   SET "rejectionReasonCode" = NULL,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "rejectionReasonCode" IS NOT NULL
   AND NOT (
     ("scopeCheckedAt" IS NOT NULL AND "scopePassedAt" IS NULL)
     OR ("safetyCheckedAt" IS NOT NULL AND "safetyPassedAt" IS NULL)
   );

UPDATE "MemoryUseItem"
   SET "rejectionReasonCode" = CASE
         WHEN "scopeCheckedAt" IS NOT NULL AND "scopePassedAt" IS NULL
           THEN 'legacy_scope_rejected'
         ELSE 'legacy_safety_rejected'
       END,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE (
     ("scopeCheckedAt" IS NOT NULL AND "scopePassedAt" IS NULL)
     OR ("safetyCheckedAt" IS NOT NULL AND "safetyPassedAt" IS NULL)
   );
-- LEGACY_MEMORY_USE_REJECTION_NORMALIZATION_END
-- LEGACY_MEMORY_USE_REMEDIATION_END

ALTER TABLE "MemoryUseRun"
  DROP CONSTRAINT "MemoryUseRun_counts_check",
  DROP CONSTRAINT "MemoryUseRun_terminal_check",
  DROP CONSTRAINT "MemoryUseRun_input_message_fkey",
  DROP CONSTRAINT "MemoryUseRun_output_message_fkey",
  DROP CONSTRAINT "MemoryUseRun_generation_fkey",
  ADD COLUMN "reasonCode" TEXT,
  ADD COLUMN "unmappedCandidateCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "citedCount" INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN "generationRunId" SET NOT NULL;

-- LEGACY_MEMORY_USE_TERMINAL_REASON_BEGIN
UPDATE "MemoryUseRun"
   SET "reasonCode" = CASE "status"
         WHEN 'DEGRADED'::"MemoryUseRunStatus" THEN 'legacy_degraded'
         WHEN 'FAILED'::"MemoryUseRunStatus" THEN 'legacy_failed'
         WHEN 'CANCELED'::"MemoryUseRunStatus" THEN 'legacy_canceled'
         ELSE NULL
       END,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "status" IN (
   'DEGRADED'::"MemoryUseRunStatus",
   'FAILED'::"MemoryUseRunStatus",
   'CANCELED'::"MemoryUseRunStatus"
 );
-- LEGACY_MEMORY_USE_TERMINAL_REASON_END

ALTER TABLE "MemoryUseRun"
  ADD CONSTRAINT "MemoryUseRun_reason_code_check" CHECK (
    "reasonCode" IS NULL OR "reasonCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  ADD CONSTRAINT "MemoryUseRun_terminal_check" CHECK (
    (
      "status" = 'STARTED'::"MemoryUseRunStatus"
      AND "completedAt" IS NULL
    ) OR (
      "status" <> 'STARTED'::"MemoryUseRunStatus"
      AND "completedAt" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "MemoryUseRun_terminal_reason_check" CHECK (
    (
      "status" = 'COMPLETED'::"MemoryUseRunStatus"
      AND "reasonCode" IS NULL
    ) OR (
      "status" IN (
        'DEGRADED'::"MemoryUseRunStatus",
        'FAILED'::"MemoryUseRunStatus",
        'CANCELED'::"MemoryUseRunStatus"
      )
      AND "reasonCode" IS NOT NULL
    ) OR "status" = 'STARTED'::"MemoryUseRunStatus"
  ),
  ADD CONSTRAINT "MemoryUseRun_input_message_fkey"
  FOREIGN KEY ("inputMessageId", "conversationId")
  REFERENCES "Message"("id", "conversationId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_output_message_fkey"
  FOREIGN KEY ("outputMessageId") REFERENCES "Message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_generation_fkey"
  FOREIGN KEY ("generationRunId", "conversationId")
  REFERENCES "GenerationRun"("id", "conversationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MemoryUseUnmappedObservation" (
  "id" TEXT NOT NULL,
  "useRunId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryUseUnmappedObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryUseUnmappedObservation_count_check" CHECK (
    "candidateCount" > 0 AND "candidateCount" <= 10000
  ),
  CONSTRAINT "MemoryUseUnmappedObservation_key_check" CHECK (
    "observationKey" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MemoryUseUnmappedObservation_run_key"
    UNIQUE ("useRunId", "observationKey"),
  CONSTRAINT "MemoryUseUnmappedObservation_run_scope_fkey"
    FOREIGN KEY ("useRunId", "representativeId")
    REFERENCES "MemoryUseRun"("id", "representativeId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MemoryUseUnmappedObservation_run_created_idx"
  ON "MemoryUseUnmappedObservation"("useRunId", "createdAt");

ALTER TABLE "MemoryUseItem"
  DROP CONSTRAINT "MemoryUseItem_source_shape_check",
  DROP CONSTRAINT "MemoryUseItem_stage_chain_check",
  DROP CONSTRAINT "MemoryUseItem_stage_time_check",
  DROP CONSTRAINT "MemoryUseItem_knowledge_binding_fkey",
  DROP CONSTRAINT "MemoryUseItem_rep_version_fkey",
  DROP CONSTRAINT "MemoryUseItem_displayedCitationId_key",
  ADD COLUMN "publicKnowledgeProjectionId" TEXT,
  ADD COLUMN "citedAt" TIMESTAMP(3),
  ADD COLUMN "citationPurgedAt" TIMESTAMP(3);

ALTER TABLE "MemoryUseItem"
  RENAME COLUMN "displayedCitationId" TO "citationId";

DROP INDEX "MemoryUseItem_public_knowledge_idx";

ALTER TABLE "MemoryUseItem"
  DROP CONSTRAINT "MemoryUseItem_text_check",
  DROP COLUMN "knowledgeBindingId",
  DROP COLUMN "representativeVersionId",
  ADD CONSTRAINT "MemoryUseItem_text_check" CHECK (
    btrim("itemKey") <> ''
    AND (
      "rejectionReasonCode" IS NULL
      OR "rejectionReasonCode" ~ '^[a-z][a-z0-9_]{0,63}$'
    )
  ),
  ADD CONSTRAINT "MemoryUseItem_citationId_key" UNIQUE ("citationId"),
  ADD CONSTRAINT "MemoryUseItem_source_shape_check" CHECK (
    (
      "sourceKind" = 'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind"
      AND "publicKnowledgeProjectionId" IS NOT NULL
      AND "memoryScope" IS NULL
      AND "memoryVersionId" IS NULL
      AND "projectionItemId" IS NULL
    ) OR (
      "sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
      AND "memoryScope" = 'CONTACT_CHANNEL'::"MemoryScope"
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "publicKnowledgeProjectionId" IS NULL
    ) OR (
      "sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
      AND "memoryScope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "publicKnowledgeProjectionId" IS NULL
    )
  ),
  ADD CONSTRAINT "MemoryUseItem_stage_chain_check" CHECK (
    ("scopeCheckedAt" IS NULL OR "searchedAt" IS NOT NULL)
    AND ("scopePassedAt" IS NULL OR "scopeCheckedAt" IS NOT NULL)
    AND ("safetyCheckedAt" IS NULL OR "scopePassedAt" IS NOT NULL)
    AND ("safetyPassedAt" IS NULL OR "safetyCheckedAt" IS NOT NULL)
    AND ("injectedAt" IS NULL OR "safetyPassedAt" IS NOT NULL)
    AND ("citedAt" IS NULL OR (
      "injectedAt" IS NOT NULL
      AND ("citationId" IS NOT NULL OR "citationPurgedAt" IS NOT NULL)
    ))
    AND ("displayedAt" IS NULL OR "citedAt" IS NOT NULL)
    AND ("citationId" IS NULL OR "citedAt" IS NOT NULL)
    AND ("citationPurgedAt" IS NULL OR (
      "citedAt" IS NOT NULL
      AND "citationId" IS NULL
    ))
  ),
  ADD CONSTRAINT "MemoryUseItem_stage_time_check" CHECK (
    ("scopeCheckedAt" IS NULL OR "scopeCheckedAt" >= "searchedAt")
    AND ("scopePassedAt" IS NULL OR "scopePassedAt" >= "scopeCheckedAt")
    AND ("safetyCheckedAt" IS NULL OR "safetyCheckedAt" >= "scopePassedAt")
    AND ("safetyPassedAt" IS NULL OR "safetyPassedAt" >= "safetyCheckedAt")
    AND ("injectedAt" IS NULL OR "injectedAt" >= "safetyPassedAt")
    AND ("citedAt" IS NULL OR "citedAt" >= "injectedAt")
    AND ("displayedAt" IS NULL OR "displayedAt" >= "citedAt")
    AND ("citationPurgedAt" IS NULL OR "citationPurgedAt" >= "citedAt")
  ),
  ADD CONSTRAINT "MemoryUseItem_rejection_shape_check" CHECK (
    (
      "scopeCheckedAt" IS NULL
      OR "scopePassedAt" IS NOT NULL
      OR "rejectionReasonCode" IS NOT NULL
    )
    AND (
      "safetyCheckedAt" IS NULL
      OR "safetyPassedAt" IS NOT NULL
      OR "rejectionReasonCode" IS NOT NULL
    )
    AND (
      "rejectionReasonCode" IS NULL
      OR (
        "scopeCheckedAt" IS NOT NULL
        AND "scopePassedAt" IS NULL
      )
      OR (
        "safetyCheckedAt" IS NOT NULL
        AND "safetyPassedAt" IS NULL
      )
    )
  ),
  ADD CONSTRAINT "MemoryUseItem_public_projection_fkey"
  FOREIGN KEY ("publicKnowledgeProjectionId", "representativeId")
  REFERENCES "PublicKnowledgeProjectionItem"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_citation_fkey"
  FOREIGN KEY ("citationId") REFERENCES "MessageCitation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MemoryUseItem_public_knowledge_idx"
  ON "MemoryUseItem"("publicKnowledgeProjectionId", "createdAt");
CREATE INDEX "MemoryUseItem_run_cited_idx"
  ON "MemoryUseItem"("useRunId", "citedAt");

-- Existing retained contact/experience usage counts are re-derived once.
-- Thereafter only the item trigger below can change these six counters.
-- LEGACY_MEMORY_USE_COUNT_REDERIVATION_BEGIN
UPDATE "MemoryUseRun" AS use_run
   SET "searchedCount" = counts."searchedCount",
       "scopePassedCount" = counts."scopePassedCount",
       "safetyPassedCount" = counts."safetyPassedCount",
       "injectedCount" = counts."injectedCount",
       "citedCount" = counts."citedCount",
       "displayedCount" = counts."displayedCount",
       "updatedAt" = CURRENT_TIMESTAMP
  FROM (
    SELECT run."id",
           COUNT(item."id") FILTER (WHERE item."searchedAt" IS NOT NULL)::INTEGER AS "searchedCount",
           COUNT(item."id") FILTER (WHERE item."scopePassedAt" IS NOT NULL)::INTEGER AS "scopePassedCount",
           COUNT(item."id") FILTER (WHERE item."safetyPassedAt" IS NOT NULL)::INTEGER AS "safetyPassedCount",
           COUNT(item."id") FILTER (WHERE item."injectedAt" IS NOT NULL)::INTEGER AS "injectedCount",
           COUNT(item."id") FILTER (WHERE item."citedAt" IS NOT NULL)::INTEGER AS "citedCount",
           COUNT(item."id") FILTER (WHERE item."displayedAt" IS NOT NULL)::INTEGER AS "displayedCount"
      FROM "MemoryUseRun" AS run
      LEFT JOIN "MemoryUseItem" AS item ON item."useRunId" = run."id"
     GROUP BY run."id"
  ) AS counts
 WHERE counts."id" = use_run."id";

-- The old schema allowed displayedCount up to injectedCount and had no
-- citedCount. Add the stricter aggregate invariant only after historical
-- citations have been scrubbed and every retained run has been re-derived
-- from its retained items. Adding this constraint earlier rejects otherwise
-- valid legacy rows with displayedCount > 0 during an in-place upgrade.
ALTER TABLE "MemoryUseRun"
  ADD CONSTRAINT "MemoryUseRun_counts_check" CHECK (
    "unmappedCandidateCount" >= 0
    AND "searchedCount" >= 0
    AND "scopePassedCount" BETWEEN 0 AND "searchedCount"
    AND "safetyPassedCount" BETWEEN 0 AND "scopePassedCount"
    AND "injectedCount" BETWEEN 0 AND "safetyPassedCount"
    AND "citedCount" BETWEEN 0 AND "injectedCount"
    AND "displayedCount" BETWEEN 0 AND "citedCount"
  );
-- LEGACY_MEMORY_USE_COUNT_REDERIVATION_END

-- Published RepresentativeVersion snapshots are the immutable root for the
-- resource manifest. Publishing creates a new version instead of rewriting
-- bytes that an existing conversation or projection has already pinned.
CREATE FUNCTION "representative_published_version_immutable_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'RepresentativeVersion_published_immutable_check',
      MESSAGE = 'published representative versions cannot be deleted';
  END IF;
  IF OLD."status" = 'PUBLISHED'
     AND (
       NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
       OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'RepresentativeVersion_published_immutable_check',
      MESSAGE = 'published representative versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepresentativeVersion_published_immutable_guard"
  BEFORE UPDATE OR DELETE ON "RepresentativeVersion"
  FOR EACH ROW EXECUTE FUNCTION "representative_published_version_immutable_guard"();

CREATE FUNCTION "representative_version_resource_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "RepresentativeVersion"%ROWTYPE;
  asset_record "KnowledgeAsset"%ROWTYPE;
  representative_owner_id TEXT;
  asset_found BOOLEAN := FALSE;
  binding_approved BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'RepresentativeVersionResource_append_only_check',
      MESSAGE = 'published representative resource manifests are immutable';
  END IF;

  SELECT * INTO version_record
    FROM "RepresentativeVersion"
   WHERE "id" = NEW."publishedVersionId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND OR version_record."status" IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'RepresentativeVersionResource_published_version_check',
      MESSAGE = 'resource manifest must bind a published representative version';
  END IF;

  IF NEW."sourceKind" = 'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind" THEN
    SELECT "ownerId" INTO representative_owner_id
      FROM "Representative"
     WHERE "id" = NEW."representativeId"
     FOR SHARE;
    SELECT * INTO asset_record
      FROM "KnowledgeAsset"
     WHERE "id" = NEW."knowledgeAssetId"
     FOR SHARE;
    asset_found := FOUND;
    PERFORM 1
      FROM "KnowledgeAssetRepresentative" AS binding
     WHERE binding."assetId" = NEW."knowledgeAssetId"
       AND binding."representativeId" = NEW."representativeId"
       AND binding."enabled" IS TRUE
       AND binding."reviewStatus" = 'APPROVED'::"KnowledgeAssetReviewStatus"
     FOR SHARE;
    binding_approved := FOUND;
    IF NOT asset_found
       OR asset_record."ownerId" IS DISTINCT FROM representative_owner_id
       OR asset_record."status" <> 'READY'::"KnowledgeAssetStatus"
       OR asset_record."archivedAt" IS NOT NULL
       OR asset_record."checksum" IS DISTINCT FROM NEW."contentHash"
       OR asset_record."extractedText" IS DISTINCT FROM NEW."safeText"
       OR NOT binding_approved
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(version_record."snapshot"::JSONB -> 'knowledgeAssets', '[]'::JSONB)
           ) AS pin
          WHERE pin ->> 'assetId' = NEW."knowledgeAssetId"
            AND pin ->> 'checksum' = NEW."contentHash"
            AND (pin ->> 'processingVersion') ~ '^[0-9]+$'
            AND (pin ->> 'processingVersion')::INTEGER = asset_record."processingVersion"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'RepresentativeVersionResource_asset_snapshot_check',
        MESSAGE = 'knowledge asset manifest is not byte-pinned by the published snapshot';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepresentativeVersionResource_guard"
  BEFORE INSERT OR UPDATE ON "RepresentativeVersionResource"
  FOR EACH ROW EXECUTE FUNCTION "representative_version_resource_guard"();

CREATE FUNCTION "representative_version_resource_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'RepresentativeVersionResource_append_only_check',
    MESSAGE = 'published representative resource manifests cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepresentativeVersionResource_delete_guard"
  BEFORE DELETE ON "RepresentativeVersionResource"
  FOR EACH ROW EXECUTE FUNCTION "representative_version_resource_delete_guard"();

-- Capture linked KnowledgeAsset bytes in the same transaction that publishes
-- the RepresentativeVersion. Later edits, reprocessing, unlinking, archival,
-- or deletion of the KnowledgeAsset must not rewrite this published release.
CREATE FUNCTION "representative_version_snapshot_resources"() RETURNS TRIGGER AS $$
DECLARE
  pin JSONB;
  asset_record "KnowledgeAsset"%ROWTYPE;
  representative_owner_id TEXT;
  binding_approved BOOLEAN;
BEGIN
  IF NEW."status" IS DISTINCT FROM 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(COALESCE(NEW."snapshot"::JSONB -> 'knowledgeAssets', '[]'::JSONB))
     IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'RepresentativeVersion_knowledge_assets_shape_check',
      MESSAGE = 'published knowledge asset pins must be an array';
  END IF;

  SELECT "ownerId" INTO representative_owner_id
    FROM "Representative"
   WHERE "id" = NEW."representativeId"
   FOR SHARE;
  FOR pin IN
    SELECT value
      FROM jsonb_array_elements(
        COALESCE(NEW."snapshot"::JSONB -> 'knowledgeAssets', '[]'::JSONB)
      )
  LOOP
    IF btrim(COALESCE(pin ->> 'assetId', '')) = ''
       OR COALESCE(pin ->> 'checksum', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(pin ->> 'processingVersion', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'RepresentativeVersion_knowledge_asset_pin_check',
        MESSAGE = 'published knowledge asset pin is incomplete';
    END IF;

    SELECT * INTO asset_record
      FROM "KnowledgeAsset"
     WHERE "id" = pin ->> 'assetId'
     FOR SHARE;
    PERFORM 1
      FROM "KnowledgeAssetRepresentative" AS binding
     WHERE binding."assetId" = pin ->> 'assetId'
       AND binding."representativeId" = NEW."representativeId"
       AND binding."enabled" IS TRUE
       AND binding."reviewStatus" = 'APPROVED'::"KnowledgeAssetReviewStatus"
     FOR SHARE;
    binding_approved := FOUND;
    IF asset_record."id" IS NULL
       OR asset_record."ownerId" IS DISTINCT FROM representative_owner_id
       OR asset_record."status" <> 'READY'::"KnowledgeAssetStatus"
       OR asset_record."archivedAt" IS NOT NULL
       OR btrim(COALESCE(asset_record."extractedText", '')) = ''
       OR asset_record."checksum" IS DISTINCT FROM pin ->> 'checksum'
       OR asset_record."processingVersion" IS DISTINCT FROM (pin ->> 'processingVersion')::INTEGER
       OR NOT binding_approved THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'RepresentativeVersion_knowledge_asset_snapshot_check',
        MESSAGE = 'published knowledge asset pin no longer matches approved authoritative bytes';
    END IF;

    INSERT INTO "RepresentativeVersionResource" (
      "publishedVersionId", "representativeId", "sourceKind",
      "resourceKey", "knowledgeAssetId", "contentHash", "safeText",
      "citationTitle"
    ) VALUES (
      NEW."id", NEW."representativeId",
      'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind",
      'knowledge/' || asset_record."id" || '.md', asset_record."id",
      asset_record."checksum", asset_record."extractedText", btrim(asset_record."title")
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepresentativeVersion_snapshot_resources"
  AFTER INSERT OR UPDATE OF "status" ON "RepresentativeVersion"
  FOR EACH ROW EXECUTE FUNCTION "representative_version_snapshot_resources"();

-- Existing releases predate the atomic snapshot trigger. Preserve every pin
-- whose current authoritative bytes still match exactly; unrecoverable stale
-- pins remain absent and therefore fail closed per resource without blocking
-- the migration or unrelated published resources.
INSERT INTO "RepresentativeVersionResource" (
  "publishedVersionId", "representativeId", "sourceKind", "resourceKey",
  "knowledgeAssetId", "contentHash", "safeText", "citationTitle"
)
SELECT version."id", version."representativeId",
       'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind",
       'knowledge/' || asset."id" || '.md', asset."id", asset."checksum",
       asset."extractedText", btrim(asset."title")
  FROM "RepresentativeVersion" AS version
  JOIN "Representative" AS representative
    ON representative."id" = version."representativeId"
 CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(version."snapshot"::JSONB -> 'knowledgeAssets') = 'array'
        THEN version."snapshot"::JSONB -> 'knowledgeAssets'
      ELSE '[]'::JSONB
    END
  ) AS pin
  JOIN "KnowledgeAsset" AS asset
    ON asset."id" = pin ->> 'assetId'
   AND asset."id" ~ '^[A-Za-z0-9_-]{1,128}$'
   AND asset."ownerId" = representative."ownerId"
   AND asset."status" = 'READY'::"KnowledgeAssetStatus"
   AND asset."archivedAt" IS NULL
   AND btrim(COALESCE(asset."extractedText", '')) <> ''
   AND asset."checksum" ~ '^[0-9a-f]{64}$'
   AND asset."checksum" = pin ->> 'checksum'
   AND btrim(asset."title") <> ''
   AND length(btrim(asset."title")) <= 200
   AND (pin ->> 'processingVersion') ~ '^[0-9]+$'
   AND asset."processingVersion" = (pin ->> 'processingVersion')::INTEGER
  JOIN "KnowledgeAssetRepresentative" AS binding
    ON binding."assetId" = asset."id"
   AND binding."representativeId" = version."representativeId"
   AND binding."enabled" IS TRUE
   AND binding."reviewStatus" = 'APPROVED'::"KnowledgeAssetReviewStatus"
 WHERE version."status" = 'PUBLISHED'
ON CONFLICT ("publishedVersionId", "resourceKey") DO NOTHING;

-- An exact public-knowledge projection is an immutable receipt. KnowledgeAsset
-- is intentionally checked by trigger but not referenced by FK so the ledger
-- cannot block normal Knowledge Base deletion/retention.
CREATE FUNCTION "public_knowledge_projection_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "RepresentativeVersion"%ROWTYPE;
  manifest_record "RepresentativeVersionResource"%ROWTYPE;
  representative_slug TEXT;
  canonical_slug TEXT;
  expected_prefix TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'PublicKnowledgeProjectionItem_append_only_check',
      MESSAGE = 'public knowledge projection receipts are immutable';
  END IF;

  SELECT * INTO version_record
    FROM "RepresentativeVersion"
   WHERE "id" = NEW."publishedVersionId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  IF NOT FOUND OR version_record."status" IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'PublicKnowledgeProjectionItem_published_version_check',
      MESSAGE = 'public knowledge projection must bind a published representative version';
  END IF;

  SELECT * INTO manifest_record
    FROM "RepresentativeVersionResource"
   WHERE "publishedVersionId" = NEW."publishedVersionId"
     AND "resourceKey" = NEW."resourceKey"
   FOR SHARE;
  IF NOT FOUND
     OR manifest_record."representativeId" IS DISTINCT FROM NEW."representativeId"
     OR manifest_record."sourceKind" IS DISTINCT FROM NEW."sourceKind"
     OR manifest_record."knowledgeAssetId" IS DISTINCT FROM NEW."knowledgeAssetId"
     OR manifest_record."contentHash" IS DISTINCT FROM NEW."contentHash" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'PublicKnowledgeProjectionItem_resource_manifest_check',
      MESSAGE = 'public knowledge projection does not match the immutable published resource manifest';
  END IF;

  SELECT "slug" INTO representative_slug
    FROM "Representative"
   WHERE "id" = NEW."representativeId"
   FOR SHARE;
  canonical_slug := regexp_replace(
    regexp_replace(lower(btrim(representative_slug)), '[^a-z0-9._-]+', '-', 'g'),
    '^-+|-+$',
    '',
    'g'
  );
  IF canonical_slug = '' THEN
    canonical_slug := 'unknown';
  END IF;
  expected_prefix := 'viking://resources/delegate/reps/'
    || canonical_slug
    || '/versions/'
    || NEW."publishedVersionId"
    || '/';

  IF NEW."provider" IS DISTINCT FROM 'openviking'
     OR NEW."remoteUri" IS DISTINCT FROM expected_prefix || NEW."resourceKey" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'PublicKnowledgeProjectionItem_exact_uri_check',
      MESSAGE = 'public knowledge projection URI is not the exact published-version resource URI';
  END IF;

  IF NEW."sourceKind" = 'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind" THEN
    IF NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(version_record."snapshot"::JSONB -> 'knowledgeAssets', '[]'::JSONB)
           ) AS pin
          WHERE pin ->> 'assetId' = NEW."knowledgeAssetId"
            AND pin ->> 'checksum' = NEW."contentHash"
            AND (pin ->> 'processingVersion') ~ '^[0-9]+$'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'PublicKnowledgeProjectionItem_asset_snapshot_check',
        MESSAGE = 'knowledge asset projection is not byte-pinned by the immutable published snapshot';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PublicKnowledgeProjectionItem_guard"
  BEFORE INSERT OR UPDATE ON "PublicKnowledgeProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "public_knowledge_projection_guard"();

CREATE FUNCTION "public_knowledge_projection_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'PublicKnowledgeProjectionItem_append_only_check',
    MESSAGE = 'public knowledge projection receipts cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PublicKnowledgeProjectionItem_delete_guard"
  BEFORE DELETE ON "PublicKnowledgeProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "public_knowledge_projection_delete_guard"();

CREATE FUNCTION "memory_use_run_channel_guard"() RETURNS TRIGGER AS $$
DECLARE
  pinned_version_status TEXT;
  active_version_id TEXT;
  generation_record "GenerationRun"%ROWTYPE;
  conversation_active_episode_id TEXT;
  episode_conversation_id TEXT;
  episode_version_id TEXT;
  episode_status "ConversationEpisodeStatus";
  output_conversation_id TEXT;
  output_sender_type "MessageSenderType";
  output_delivery_status "MessageDeliveryStatus";
  check_pinned_version BOOLEAN;
  require_current_episode BOOLEAN;
  output_retention_clear BOOLEAN := FALSE;
BEGIN
  PERFORM "memory_assert_channel_match"(
    NEW."conversationId",
    NEW."sourceChannel",
    'MemoryUseRun_source_channel_check'
  );

  check_pinned_version := TG_OP = 'INSERT';
  require_current_episode := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    check_pinned_version :=
      NEW."representativeVersionId" IS DISTINCT FROM OLD."representativeVersionId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId";
    output_retention_clear :=
      OLD."outputMessageId" IS NOT NULL
      AND NEW."outputMessageId" IS NULL
      AND pg_trigger_depth() > 1;
    require_current_episode := OLD."status" = 'STARTED'::"MemoryUseRunStatus";
  END IF;

  IF check_pinned_version THEN
    SELECT "status" INTO pinned_version_status
      FROM "RepresentativeVersion"
     WHERE "id" = NEW."representativeVersionId"
       AND "representativeId" = NEW."representativeId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseRun_rep_version_fkey',
        MESSAGE = 'memory use representative version does not exist';
    END IF;
    IF pinned_version_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_pinned_version_check',
        MESSAGE = 'memory use run must pin a published representative version';
    END IF;
  END IF;

  SELECT * INTO generation_record
    FROM "GenerationRun"
   WHERE "id" = NEW."generationRunId"
     AND "conversationId" = NEW."conversationId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'MemoryUseRun_generation_fkey',
      MESSAGE = 'memory use generation run does not exist in the conversation';
  END IF;
  IF generation_record."representativeVersionId" IS DISTINCT FROM NEW."representativeVersionId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_generation_version_check',
      MESSAGE = 'memory use run and generation run pinned different representative versions';
  END IF;
  IF generation_record."inputMessageId" IS DISTINCT FROM NEW."inputMessageId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_generation_input_check',
      MESSAGE = 'memory use run and generation run have different input messages';
  END IF;
  IF generation_record."episodeId" IS NULL THEN
    -- Compatibility for pre-Episode generations: they are safe only while
    -- an open run is pinned to the representative's active release and the
    -- conversation has not moved into the Episode lifecycle. Terminal rows
    -- remain valid historical evidence after a later publication.
    IF require_current_episode THEN
      SELECT representative."activeVersionId", conversation."activeEpisodeId"
        INTO active_version_id, conversation_active_episode_id
        FROM "Representative" AS representative
        JOIN "Conversation" AS conversation
          ON conversation."id" = NEW."conversationId"
       WHERE representative."id" = NEW."representativeId"
       FOR SHARE OF representative, conversation;
    END IF;
    IF require_current_episode AND (
      active_version_id IS DISTINCT FROM NEW."representativeVersionId"
      OR conversation_active_episode_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_legacy_active_version_check',
        MESSAGE = 'open legacy memory use generation is no longer the current conversation generation';
    END IF;
  ELSE
    SELECT episode."conversationId", episode."representativeVersionId",
           episode."status", conversation."activeEpisodeId"
      INTO episode_conversation_id, episode_version_id, episode_status,
           conversation_active_episode_id
      FROM "ConversationEpisode" AS episode
      JOIN "Conversation" AS conversation
        ON conversation."id" = NEW."conversationId"
     WHERE episode."id" = generation_record."episodeId"
     FOR SHARE OF episode, conversation;
    IF NOT FOUND
       OR episode_conversation_id IS DISTINCT FROM NEW."conversationId"
       OR episode_version_id IS DISTINCT FROM NEW."representativeVersionId"
       OR (
         require_current_episode
         AND (
           conversation_active_episode_id IS DISTINCT FROM generation_record."episodeId"
           OR episode_status IS DISTINCT FROM 'ACTIVE'::"ConversationEpisodeStatus"
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_episode_version_check',
        MESSAGE = 'open memory use run must match the current active generation episode and published version';
    END IF;
  END IF;

  IF NEW."outputMessageId" IS NOT NULL THEN
    SELECT "conversationId", "senderType", "deliveryStatus"
      INTO output_conversation_id, output_sender_type, output_delivery_status
      FROM "Message"
     WHERE "id" = NEW."outputMessageId"
     FOR SHARE;
    IF NOT FOUND OR output_conversation_id IS DISTINCT FROM NEW."conversationId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_output_message_scope_check',
        MESSAGE = 'memory use output message belongs to another conversation';
    END IF;
    IF generation_record."outputMessageId" IS DISTINCT FROM NEW."outputMessageId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_generation_output_check',
        MESSAGE = 'memory use run and generation run have different output messages';
    END IF;
  END IF;

  IF NOT output_retention_clear
     AND NEW."status" IN (
       'COMPLETED'::"MemoryUseRunStatus",
       'DEGRADED'::"MemoryUseRunStatus"
     ) AND (
       NEW."outputMessageId" IS NULL
       OR generation_record."status" <> 'COMPLETED'::"GenerationRunStatus"
       OR generation_record."outputMessageId" IS DISTINCT FROM NEW."outputMessageId"
       OR output_sender_type IS DISTINCT FROM 'REPRESENTATIVE'::"MessageSenderType"
       OR output_delivery_status NOT IN (
         'ACCEPTED'::"MessageDeliveryStatus",
         'QUEUED'::"MessageDeliveryStatus",
         'PROCESSING'::"MessageDeliveryStatus",
         'SENT'::"MessageDeliveryStatus"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_completed_output_check',
      MESSAGE = 'completed memory use must bind the completed generation representative output';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseRun_channel_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_run_channel_guard"();

CREATE FUNCTION "memory_use_run_truth_guard"() RETURNS TRIGGER AS $$
DECLARE
  count_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."unmappedCandidateCount" <> 0
       OR NEW."searchedCount" <> 0
       OR NEW."scopePassedCount" <> 0
       OR NEW."safetyPassedCount" <> 0
       OR NEW."injectedCount" <> 0
       OR NEW."citedCount" <> 0
       OR NEW."displayedCount" <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_initial_counts_check',
        MESSAGE = 'new memory use runs must start with zero service and item counts';
    END IF;
    RETURN NEW;
  END IF;

  count_changed := NEW."searchedCount" IS DISTINCT FROM OLD."searchedCount"
    OR NEW."scopePassedCount" IS DISTINCT FROM OLD."scopePassedCount"
    OR NEW."safetyPassedCount" IS DISTINCT FROM OLD."safetyPassedCount"
    OR NEW."injectedCount" IS DISTINCT FROM OLD."injectedCount"
    OR NEW."citedCount" IS DISTINCT FROM OLD."citedCount"
    OR NEW."displayedCount" IS DISTINCT FROM OLD."displayedCount";

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
     OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
     OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
     OR NEW."representativeVersionId" IS DISTINCT FROM OLD."representativeVersionId"
     OR NEW."inputMessageId" IS DISTINCT FROM OLD."inputMessageId"
     OR NEW."generationRunId" IS DISTINCT FROM OLD."generationRunId"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_locked_coordinates_check',
      MESSAGE = 'memory use run scope and generation coordinates are immutable';
  END IF;

  IF OLD."outputMessageId" IS NOT NULL
     AND NEW."outputMessageId" IS DISTINCT FROM OLD."outputMessageId"
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_output_immutable_check',
      MESSAGE = 'memory use output message cannot be rebound or manually cleared';
  END IF;

  IF OLD."status" <> 'STARTED'::"MemoryUseRunStatus"
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_terminal_immutable_check',
      MESSAGE = 'terminal memory use run status is immutable';
  END IF;
  IF OLD."completedAt" IS NOT NULL
     AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_completed_immutable_check',
      MESSAGE = 'memory use completion time is immutable';
  END IF;
  IF OLD."reasonCode" IS NOT NULL
     AND NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
     AND NOT (
       OLD."status" = 'STARTED'::"MemoryUseRunStatus"
       AND NEW."status" <> 'STARTED'::"MemoryUseRunStatus"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_reason_immutable_check',
      MESSAGE = 'memory use reason code is immutable once recorded';
  END IF;

  IF NEW."unmappedCandidateCount" < OLD."unmappedCandidateCount"
     OR (
       NEW."unmappedCandidateCount" IS DISTINCT FROM OLD."unmappedCandidateCount"
       AND pg_trigger_depth() <= 1
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_unmapped_monotonic_check',
      MESSAGE = 'unmapped candidate count is append-only and maintained from anonymous observations';
  END IF;

  IF count_changed AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseRun_item_counts_managed_check',
      MESSAGE = 'mapped memory use counts are maintained only from use items';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseRun_truth_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_run_truth_guard"();

CREATE FUNCTION "memory_use_unmapped_observation_guard"() RETURNS TRIGGER AS $$
DECLARE
  run_record "MemoryUseRun"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND pg_trigger_depth() <= 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'MemoryUseUnmappedObservation_append_only_check',
      MESSAGE = 'anonymous recall observations are append-only and delete only with parent retention';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO run_record
    FROM "MemoryUseRun"
   WHERE "id" = NEW."useRunId"
   FOR UPDATE;
  IF NOT FOUND
     OR run_record."representativeId" IS DISTINCT FROM NEW."representativeId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'MemoryUseUnmappedObservation_run_scope_fkey',
      MESSAGE = 'anonymous recall observation does not belong to the use run';
  END IF;
  IF run_record."status" <> 'STARTED'::"MemoryUseRunStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseUnmappedObservation_run_open_check',
      MESSAGE = 'anonymous recall observations can be recorded only while the use run is open';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseUnmappedObservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "MemoryUseUnmappedObservation"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_unmapped_observation_guard"();

CREATE FUNCTION "memory_use_unmapped_observation_refresh"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "MemoryUseRun"
     SET "unmappedCandidateCount" = GREATEST(
           "unmappedCandidateCount",
           NEW."candidateCount"
         ),
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = NEW."useRunId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseUnmappedObservation_refresh"
  AFTER INSERT ON "MemoryUseUnmappedObservation"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_unmapped_observation_refresh"();

CREATE FUNCTION "memory_use_item_scope_guard"() RETURNS TRIGGER AS $$
DECLARE
  run_record "MemoryUseRun"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  projection_record "MemoryProjectionItem"%ROWTYPE;
  public_projection_record "PublicKnowledgeProjectionItem"%ROWTYPE;
  public_manifest_record "RepresentativeVersionResource"%ROWTYPE;
  public_version_record "RepresentativeVersion"%ROWTYPE;
  generation_record "GenerationRun"%ROWTYPE;
  policy_record "RepresentativeMemoryPolicy"%ROWTYPE;
  active_version_id TEXT;
  conversation_active_episode_id TEXT;
  episode_conversation_id TEXT;
  episode_version_id TEXT;
  episode_status "ConversationEpisodeStatus";
  citation_message_id TEXT;
  output_delivery_status "MessageDeliveryStatus";
  candidate_approved BOOLEAN := FALSE;
  review_approved BOOLEAN := FALSE;
  policy_found BOOLEAN := FALSE;
  public_manifest_found BOOLEAN := FALSE;
  public_version_found BOOLEAN := FALSE;
  injection_transition BOOLEAN;
  cited_transition BOOLEAN;
  displayed_transition BOOLEAN;
  business_stage_transition BOOLEAN;
  citation_retention_clear BOOLEAN := FALSE;
BEGIN
  injection_transition := NEW."injectedAt" IS NOT NULL AND TG_OP = 'INSERT';
  cited_transition := NEW."citedAt" IS NOT NULL AND TG_OP = 'INSERT';
  displayed_transition := NEW."displayedAt" IS NOT NULL AND TG_OP = 'INSERT';
  business_stage_transition := NEW."searchedAt" IS NOT NULL AND TG_OP = 'INSERT';

  IF TG_OP = 'INSERT' AND NEW."citationPurgedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_citation_purge_internal_check',
      MESSAGE = 'citation purge evidence is maintained only by message retention';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    injection_transition := NEW."injectedAt" IS NOT NULL AND OLD."injectedAt" IS NULL;
    cited_transition := NEW."citedAt" IS NOT NULL AND OLD."citedAt" IS NULL;
    displayed_transition := NEW."displayedAt" IS NOT NULL AND OLD."displayedAt" IS NULL;
    business_stage_transition :=
      (NEW."searchedAt" IS NOT NULL AND OLD."searchedAt" IS NULL)
      OR (NEW."scopeCheckedAt" IS NOT NULL AND OLD."scopeCheckedAt" IS NULL)
      OR (NEW."scopePassedAt" IS NOT NULL AND OLD."scopePassedAt" IS NULL)
      OR (NEW."safetyCheckedAt" IS NOT NULL AND OLD."safetyCheckedAt" IS NULL)
      OR (NEW."safetyPassedAt" IS NOT NULL AND OLD."safetyPassedAt" IS NULL)
      OR injection_transition
      OR cited_transition
      OR (NEW."searchRank" IS NOT NULL AND OLD."searchRank" IS NULL)
      OR (NEW."searchScore" IS NOT NULL AND OLD."searchScore" IS NULL)
      OR (
        NEW."rejectionReasonCode" IS NOT NULL
        AND OLD."rejectionReasonCode" IS NULL
      );

    citation_retention_clear :=
      OLD."citationId" IS NOT NULL
      AND NEW."citationId" IS NULL
      AND pg_trigger_depth() > 1;
    IF citation_retention_clear THEN
      NEW."citationPurgedAt" := COALESCE(OLD."citationPurgedAt", CURRENT_TIMESTAMP);
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."useRunId" IS DISTINCT FROM OLD."useRunId"
       OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
       OR NEW."itemKey" IS DISTINCT FROM OLD."itemKey"
       OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
       OR NEW."memoryScope" IS DISTINCT FROM OLD."memoryScope"
       OR NEW."memoryVersionId" IS DISTINCT FROM OLD."memoryVersionId"
       OR NEW."projectionItemId" IS DISTINCT FROM OLD."projectionItemId"
       OR NEW."publicKnowledgeProjectionId" IS DISTINCT FROM OLD."publicKnowledgeProjectionId"
       OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
       OR (OLD."searchRank" IS NOT NULL AND NEW."searchRank" IS DISTINCT FROM OLD."searchRank")
       OR (OLD."searchScore" IS NOT NULL AND NEW."searchScore" IS DISTINCT FROM OLD."searchScore")
       OR (OLD."rejectionReasonCode" IS NOT NULL AND NEW."rejectionReasonCode" IS DISTINCT FROM OLD."rejectionReasonCode")
       OR (OLD."citationId" IS NOT NULL AND NEW."citationId" IS DISTINCT FROM OLD."citationId" AND NOT citation_retention_clear)
       OR (OLD."searchedAt" IS NOT NULL AND NEW."searchedAt" IS DISTINCT FROM OLD."searchedAt")
       OR (OLD."scopeCheckedAt" IS NOT NULL AND NEW."scopeCheckedAt" IS DISTINCT FROM OLD."scopeCheckedAt")
       OR (OLD."scopePassedAt" IS NOT NULL AND NEW."scopePassedAt" IS DISTINCT FROM OLD."scopePassedAt")
       OR (OLD."safetyCheckedAt" IS NOT NULL AND NEW."safetyCheckedAt" IS DISTINCT FROM OLD."safetyCheckedAt")
       OR (OLD."safetyPassedAt" IS NOT NULL AND NEW."safetyPassedAt" IS DISTINCT FROM OLD."safetyPassedAt")
       OR (OLD."injectedAt" IS NOT NULL AND NEW."injectedAt" IS DISTINCT FROM OLD."injectedAt")
       OR (OLD."citedAt" IS NOT NULL AND NEW."citedAt" IS DISTINCT FROM OLD."citedAt")
       OR (OLD."displayedAt" IS NOT NULL AND NEW."displayedAt" IS DISTINCT FROM OLD."displayedAt")
       OR (OLD."citationPurgedAt" IS NOT NULL AND NEW."citationPurgedAt" IS DISTINCT FROM OLD."citationPurgedAt")
       OR (
         OLD."citationPurgedAt" IS NULL
         AND NEW."citationPurgedAt" IS NOT NULL
         AND NOT citation_retention_clear
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_append_only_stages_check',
        MESSAGE = 'memory use identity and completed stages are append-only';
    END IF;

    IF OLD."rejectionReasonCode" IS NOT NULL AND business_stage_transition THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_rejected_terminal_check',
        MESSAGE = 'a rejected use item cannot advance to a later stage';
    END IF;
  END IF;

  SELECT * INTO run_record
    FROM "MemoryUseRun"
   WHERE "id" = NEW."useRunId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'MemoryUseItem_run_scope_fkey',
      MESSAGE = 'memory use run does not exist';
  END IF;

  IF (TG_OP = 'INSERT' OR business_stage_transition)
     AND run_record."status" <> 'STARTED'::"MemoryUseRunStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryUseItem_run_open_check',
      MESSAGE = 'memory use stages can advance only while the use run is open';
  END IF;
  IF displayed_transition THEN
    SELECT "deliveryStatus" INTO output_delivery_status
      FROM "Message"
     WHERE "id" = run_record."outputMessageId"
       AND "conversationId" = run_record."conversationId"
     FOR SHARE;
    IF run_record."status" NOT IN (
         'COMPLETED'::"MemoryUseRunStatus",
         'DEGRADED'::"MemoryUseRunStatus"
       )
       OR run_record."sourceChannel" <> 'WEB'::"RepresentativeChannelKind"
       OR NOT FOUND
       OR output_delivery_status <> 'SENT'::"MessageDeliveryStatus" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_display_ack_check',
        MESSAGE = 'public display requires a successfully delivered Web response';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR injection_transition THEN
    SELECT * INTO generation_record
      FROM "GenerationRun"
     WHERE "id" = run_record."generationRunId"
       AND "conversationId" = run_record."conversationId"
     FOR SHARE;
    IF NOT FOUND
       OR generation_record."representativeVersionId" IS DISTINCT FROM run_record."representativeVersionId"
       OR generation_record."inputMessageId" IS DISTINCT FROM run_record."inputMessageId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_generation_version_check',
        MESSAGE = 'memory use item no longer matches its generation version pin';
    END IF;
    IF generation_record."episodeId" IS NULL THEN
      SELECT representative."activeVersionId", conversation."activeEpisodeId"
        INTO active_version_id, conversation_active_episode_id
        FROM "Representative" AS representative
        JOIN "Conversation" AS conversation
          ON conversation."id" = run_record."conversationId"
       WHERE representative."id" = run_record."representativeId"
       FOR SHARE OF representative, conversation;
      IF active_version_id IS DISTINCT FROM run_record."representativeVersionId"
         OR conversation_active_episode_id IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryUseItem_legacy_active_version_check',
          MESSAGE = 'legacy memory use item is no longer in the current conversation generation';
      END IF;
    ELSE
      SELECT episode."conversationId", episode."representativeVersionId",
             episode."status", conversation."activeEpisodeId"
        INTO episode_conversation_id, episode_version_id, episode_status,
             conversation_active_episode_id
        FROM "ConversationEpisode" AS episode
        JOIN "Conversation" AS conversation
          ON conversation."id" = run_record."conversationId"
       WHERE episode."id" = generation_record."episodeId"
       FOR SHARE OF episode, conversation;
      IF NOT FOUND
         OR episode_conversation_id IS DISTINCT FROM run_record."conversationId"
         OR episode_version_id IS DISTINCT FROM run_record."representativeVersionId"
         OR conversation_active_episode_id IS DISTINCT FROM generation_record."episodeId"
         OR episode_status IS DISTINCT FROM 'ACTIVE'::"ConversationEpisodeStatus" THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryUseItem_episode_version_check',
          MESSAGE = 'memory use item no longer matches the current active generation episode version pin';
      END IF;
    END IF;
  END IF;

  IF NEW."sourceKind" IN ('CONTACT_MEMORY', 'REPRESENTATIVE_EXPERIENCE') THEN
    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."memoryVersionId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_version_scope_fkey',
        MESSAGE = 'memory use version does not exist';
    END IF;
    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = version_record."memoryId"
     FOR SHARE;
    SELECT * INTO projection_record
      FROM "MemoryProjectionItem"
     WHERE "id" = NEW."projectionItemId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_projection_scope_fkey',
        MESSAGE = 'memory use projection does not exist';
    END IF;

    IF NEW."contentHash" IS DISTINCT FROM version_record."contentHash"
       OR NEW."contentHash" IS DISTINCT FROM projection_record."contentHash" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_content_hash_check',
        MESSAGE = 'memory use item hash does not match its version and projection';
    END IF;
    IF memory_record."representativeId" <> run_record."representativeId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_representative_scope_check',
        MESSAGE = 'memory use crossed representative scope';
    END IF;
    IF NEW."sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
       AND (
         memory_record."scope" <> 'CONTACT_CHANNEL'::"MemoryScope"
         OR memory_record."contactId" IS DISTINCT FROM run_record."contactId"
         OR memory_record."sourceChannel" IS DISTINCT FROM run_record."sourceChannel"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_contact_scope_check',
        MESSAGE = 'contact memory use crossed contact or channel scope';
    END IF;
    IF NEW."sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
       AND (
         memory_record."scope" <> 'REPRESENTATIVE'::"MemoryScope"
         OR memory_record."contactId" IS NOT NULL
         OR memory_record."sourceChannel" IS NOT NULL
         OR version_record."deidentifiedAt" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_rep_experience_scope_check',
        MESSAGE = 'representative experience is not deidentified and representative-scoped';
    END IF;
    IF injection_transition THEN
      SELECT * INTO policy_record
        FROM "RepresentativeMemoryPolicy"
       WHERE "representativeId" = run_record."representativeId"
       FOR SHARE;
      policy_found := FOUND;
      PERFORM 1
        FROM "MemoryCandidate"
       WHERE "id" = version_record."sourceCandidateId"
         AND "representativeId" = run_record."representativeId"
         AND "status" = 'APPROVED'::"MemoryCandidateStatus"
         AND "safetyClass" IN (
           'LOW_RISK'::"MemorySafetyClass",
           'REVIEW_REQUIRED'::"MemorySafetyClass"
         )
         AND "contentPurgedAt" IS NULL
       FOR SHARE;
      candidate_approved := FOUND;
      PERFORM 1
        FROM "MemoryReviewDecision"
       WHERE "resultVersionId" = version_record."id"
         AND "candidateId" = version_record."sourceCandidateId"
         AND "memoryId" = memory_record."id"
         AND "representativeId" = run_record."representativeId"
         AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
         AND "reviewerRole" <> 'SYSTEM'::"MemoryReviewerRole"
       FOR SHARE;
      review_approved := FOUND;
      IF (
         NOT policy_found
         OR NOT policy_record."longTermMemoryEnabled"
         OR run_record."sourceChannel" <> 'WEB'::"RepresentativeChannelKind"
         OR (
           run_record."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
           AND NOT policy_record."webRecallEnabled"
         )
         OR (
           run_record."sourceChannel" = 'MATRIX'::"RepresentativeChannelKind"
           AND NOT policy_record."matrixRecallEnabled"
         )
         OR (
           run_record."sourceChannel" = 'TELEGRAM'::"RepresentativeChannelKind"
           AND NOT policy_record."telegramRecallEnabled"
         )
         OR (
           NEW."sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
           AND NOT policy_record."contactMemoryEnabled"
         )
         OR (
           NEW."sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
           AND NOT policy_record."representativeExperienceEnabled"
         )
         OR memory_record."status" <> 'ACTIVE'::"GovernedMemoryStatus"
         OR memory_record."recallDisabledAt" IS NOT NULL
         OR memory_record."currentVersionId" IS DISTINCT FROM version_record."id"
         OR version_record."purgedAt" IS NOT NULL
         OR (memory_record."expiresAt" IS NOT NULL AND memory_record."expiresAt" <= NEW."injectedAt")
         OR projection_record."status" <> 'ACTIVE'::"MemoryProjectionStatus"
         OR projection_record."lane" <> 'RECALL'::"MemoryProjectionLane"
         OR projection_record."writeVerifiedAt" IS NULL
         OR projection_record."projectedAt" IS NULL
         OR projection_record."deletedAt" IS NOT NULL
         OR NOT candidate_approved
         OR NOT review_approved
         OR (
           NEW."sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
           AND (
             version_record."deidentifiedAt" IS NULL
             OR btrim(COALESCE(version_record."deidentificationMethod", '')) = ''
           )
         )
       ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryUseItem_injection_allowlist_check',
          MESSAGE = 'memory was not active, current, independently reviewed, policy-enabled, and recall-projected at injection';
      END IF;
    END IF;
  ELSE
    SELECT * INTO public_projection_record
      FROM "PublicKnowledgeProjectionItem"
     WHERE "id" = NEW."publicKnowledgeProjectionId"
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_public_projection_fkey',
        MESSAGE = 'public knowledge projection does not exist';
    END IF;
    IF public_projection_record."representativeId" IS DISTINCT FROM run_record."representativeId"
       OR public_projection_record."publishedVersionId" IS DISTINCT FROM run_record."representativeVersionId"
       OR public_projection_record."contentHash" IS DISTINCT FROM NEW."contentHash" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_published_knowledge_check',
        MESSAGE = 'public knowledge use crossed representative, published version, or content hash';
    END IF;

    SELECT * INTO public_manifest_record
      FROM "RepresentativeVersionResource"
     WHERE "publishedVersionId" = public_projection_record."publishedVersionId"
       AND "resourceKey" = public_projection_record."resourceKey"
     FOR SHARE;
    public_manifest_found := FOUND;
    SELECT * INTO public_version_record
      FROM "RepresentativeVersion"
     WHERE "id" = public_projection_record."publishedVersionId"
       AND "representativeId" = run_record."representativeId"
     FOR SHARE;
    public_version_found := FOUND;
    IF NOT public_manifest_found
       OR NOT public_version_found
       OR public_version_record."status" IS DISTINCT FROM 'PUBLISHED'
       OR public_manifest_record."publishedVersionId" IS DISTINCT FROM public_projection_record."publishedVersionId"
       OR public_manifest_record."representativeId" IS DISTINCT FROM run_record."representativeId"
       OR public_manifest_record."sourceKind" IS DISTINCT FROM public_projection_record."sourceKind"
       OR public_manifest_record."resourceKey" IS DISTINCT FROM public_projection_record."resourceKey"
       OR public_manifest_record."knowledgeAssetId" IS DISTINCT FROM public_projection_record."knowledgeAssetId"
       OR public_manifest_record."contentHash" IS DISTINCT FROM public_projection_record."contentHash" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_public_manifest_check',
        MESSAGE = 'public knowledge is not backed by the current immutable published resource manifest';
    END IF;

  END IF;

  IF NEW."citedAt" IS NOT NULL AND NEW."citationId" IS NOT NULL THEN
    SELECT "messageId" INTO citation_message_id
      FROM "MessageCitation"
     WHERE "id" = NEW."citationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_citation_fkey',
        MESSAGE = 'memory use citation does not exist';
    END IF;
    IF run_record."outputMessageId" IS NULL
       OR citation_message_id IS DISTINCT FROM run_record."outputMessageId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_cited_source_check',
        MESSAGE = 'cited source is not attached to the run output message';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseItem_scope_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_scope_guard"();

CREATE FUNCTION "memory_use_item_count_refresh"() RETURNS TRIGGER AS $$
DECLARE
  searched_delta INTEGER := 0;
  scope_delta INTEGER := 0;
  safety_delta INTEGER := 0;
  injected_delta INTEGER := 0;
  cited_delta INTEGER := 0;
  displayed_delta INTEGER := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    searched_delta := CASE WHEN NEW."searchedAt" IS NOT NULL THEN 1 ELSE 0 END;
    scope_delta := CASE WHEN NEW."scopePassedAt" IS NOT NULL THEN 1 ELSE 0 END;
    safety_delta := CASE WHEN NEW."safetyPassedAt" IS NOT NULL THEN 1 ELSE 0 END;
    injected_delta := CASE WHEN NEW."injectedAt" IS NOT NULL THEN 1 ELSE 0 END;
    cited_delta := CASE WHEN NEW."citedAt" IS NOT NULL THEN 1 ELSE 0 END;
    displayed_delta := CASE WHEN NEW."displayedAt" IS NOT NULL THEN 1 ELSE 0 END;
  ELSE
    searched_delta := CASE WHEN OLD."searchedAt" IS NULL AND NEW."searchedAt" IS NOT NULL THEN 1 ELSE 0 END;
    scope_delta := CASE WHEN OLD."scopePassedAt" IS NULL AND NEW."scopePassedAt" IS NOT NULL THEN 1 ELSE 0 END;
    safety_delta := CASE WHEN OLD."safetyPassedAt" IS NULL AND NEW."safetyPassedAt" IS NOT NULL THEN 1 ELSE 0 END;
    injected_delta := CASE WHEN OLD."injectedAt" IS NULL AND NEW."injectedAt" IS NOT NULL THEN 1 ELSE 0 END;
    cited_delta := CASE WHEN OLD."citedAt" IS NULL AND NEW."citedAt" IS NOT NULL THEN 1 ELSE 0 END;
    displayed_delta := CASE WHEN OLD."displayedAt" IS NULL AND NEW."displayedAt" IS NOT NULL THEN 1 ELSE 0 END;
  END IF;

  IF searched_delta + scope_delta + safety_delta + injected_delta + cited_delta + displayed_delta > 0 THEN
    UPDATE "MemoryUseRun"
       SET "searchedCount" = "searchedCount" + searched_delta,
           "scopePassedCount" = "scopePassedCount" + scope_delta,
           "safetyPassedCount" = "safetyPassedCount" + safety_delta,
           "injectedCount" = "injectedCount" + injected_delta,
           "citedCount" = "citedCount" + cited_delta,
           "displayedCount" = "displayedCount" + displayed_delta,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = NEW."useRunId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseItem_count_refresh"
  AFTER INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_count_refresh"();

CREATE FUNCTION "memory_use_item_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'MemoryUseItem_append_only_delete_check',
      MESSAGE = 'memory use items can be removed only by parent retention';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseItem_delete_guard"
  BEFORE DELETE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_delete_guard"();

CREATE FUNCTION "memory_use_run_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'MemoryUseRun_parent_retention_check',
      MESSAGE = 'memory use runs can be removed only with their input message or generation run';
  END IF;

  DELETE FROM "MessageCitation" AS citation
   USING "MemoryUseItem" AS item
   WHERE item."useRunId" = OLD."id"
     AND item."citationId" = citation."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseRun_delete_guard"
  BEFORE DELETE ON "MemoryUseRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_run_delete_guard"();

CREATE FUNCTION "message_citation_append_only_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'MessageCitation_append_only_check',
      MESSAGE = 'message citations are immutable and delete only with retained parent data';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MessageCitation_append_only_guard"
  BEFORE UPDATE OR DELETE ON "MessageCitation"
  FOR EACH ROW EXECUTE FUNCTION "message_citation_append_only_guard"();

CREATE FUNCTION "message_citation_proof_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MessageCitation" WHERE "id" = NEW."id") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "MemoryUseItem" AS item
      JOIN "MemoryUseRun" AS use_run ON use_run."id" = item."useRunId"
     WHERE item."citationId" = NEW."id"
       AND item."injectedAt" IS NOT NULL
       AND item."citedAt" IS NOT NULL
       AND use_run."generationRunId" IS NOT NULL
       AND use_run."outputMessageId" = NEW."messageId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MessageCitation_proven_use_check',
      MESSAGE = 'message citation must be linked to an injected and explicitly cited use item';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "MessageCitation_proof_guard"
  AFTER INSERT ON "MessageCitation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "message_citation_proof_guard"();

COMMIT;
