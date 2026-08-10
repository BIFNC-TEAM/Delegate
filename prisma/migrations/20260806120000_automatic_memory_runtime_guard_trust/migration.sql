-- Extend runtime trust guards to automatic policy decisions without weakening
-- legacy state, scope, provenance, lifecycle, or reconciliation invariants.

BEGIN;

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
       OR NOT (
         EXISTS (
           SELECT 1 FROM "MemoryReviewDecision"
            WHERE "candidateId" = version_record."sourceCandidateId"
              AND "resultVersionId" = version_record."id"
              AND "memoryId" = memory_record."id"
              AND "representativeId" = memory_record."representativeId"
              AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
              AND "reviewerRole" <> 'SYSTEM'::"MemoryReviewerRole"
         )
         OR EXISTS (
           SELECT 1 FROM "MemoryPolicyDecision"
            WHERE "candidateId" = version_record."sourceCandidateId"
              AND "resultVersionId" = version_record."id"
              AND "memoryId" = memory_record."id"
              AND "representativeId" = memory_record."representativeId"
              AND "outputHash" IS NOT DISTINCT FROM version_record."contentHash"
              AND "outcome" IN (
                'ACTIVATED'::"MemoryPolicyDecisionOutcome",
                'UPDATED'::"MemoryPolicyDecisionOutcome"
              )
         )
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

CREATE OR REPLACE FUNCTION "memory_use_item_scope_guard"() RETURNS TRIGGER AS $$
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
      IF NOT review_approved THEN
        PERFORM 1
          FROM "MemoryPolicyDecision"
         WHERE "resultVersionId" = version_record."id"
           AND "candidateId" = version_record."sourceCandidateId"
           AND "memoryId" = memory_record."id"
           AND "representativeId" = run_record."representativeId"
           AND "outputHash" IS NOT DISTINCT FROM version_record."contentHash"
           AND "outcome" IN (
             'ACTIVATED'::"MemoryPolicyDecisionOutcome",
             'UPDATED'::"MemoryPolicyDecisionOutcome"
           )
         FOR SHARE;
        review_approved := FOUND;
      END IF;
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

COMMIT;
