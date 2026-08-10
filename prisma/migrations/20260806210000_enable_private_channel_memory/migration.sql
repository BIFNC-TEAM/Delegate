BEGIN;

-- Matrix and Telegram governed memory may be enabled only through the
-- channel-local runtime gates introduced with this migration. Cross-channel
-- Contact Memory remains disabled by the application and CONTACT_SHARED stays
-- fail-closed in the recall layer.
ALTER TABLE "RepresentativeMemoryPolicy"
  DROP CONSTRAINT IF EXISTS "MemoryPolicy_p0_web_only_check",
  DROP CONSTRAINT IF EXISTS "MemoryPolicy_safe_enablement_check",
  ADD CONSTRAINT "MemoryPolicy_safe_enablement_check" CHECK (
    (NOT "contactMemoryEnabled" OR "longTermMemoryEnabled")
    AND (NOT "representativeExperienceEnabled" OR "longTermMemoryEnabled")
    AND (NOT "contactMemoryCrossChannelEnabled" OR (
      "longTermMemoryEnabled" AND "contactMemoryEnabled"
    ))
    AND (NOT "autoExtract" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "webRecallEnabled" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "matrixRecallEnabled" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "telegramRecallEnabled" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "webExtractEnabled" OR (
      "longTermMemoryEnabled" AND "autoExtract"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "matrixExtractEnabled" OR (
      "longTermMemoryEnabled" AND "autoExtract"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "telegramExtractEnabled" OR (
      "longTermMemoryEnabled" AND "autoExtract"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
  );

CREATE TYPE "MemoryDisclosureDeliveryStatus" AS ENUM (
  'PENDING',
  'DELIVERED',
  'FAILED'
);

CREATE TYPE "MemoryDisclosureEvidenceKind" AS ENUM (
  'MATRIX_MESSAGE',
  'TELEGRAM_MESSAGE'
);

CREATE TABLE "MemoryChannelDisclosureDelivery" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "channelBindingId" TEXT NOT NULL,
  "bindingEpoch" TEXT NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "disclosureContractVersion" TEXT NOT NULL,
  "disclosureFingerprint" TEXT NOT NULL,
  "disclosureHash" TEXT NOT NULL,
  "disclosureSnapshot" JSONB NOT NULL,
  "evidenceKind" "MemoryDisclosureEvidenceKind" NOT NULL,
  "status" "MemoryDisclosureDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "representativeAssignmentRevision" INTEGER,
  "connectionId" TEXT,
  "externalMessageId" TEXT,
  "proofHash" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryChannelDisclosureDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryChannelDisclosureDelivery_policy_revision_check"
    CHECK ("policyRevision" >= 0 AND "attemptCount" >= 0),
  CONSTRAINT "MemoryChannelDisclosureDelivery_channel_check"
    CHECK ("sourceChannel" IN ('MATRIX', 'TELEGRAM')),
  CONSTRAINT "MemoryChannelDisclosureDelivery_evidence_channel_check" CHECK (
    ("sourceChannel" = 'MATRIX' AND "evidenceKind" = 'MATRIX_MESSAGE')
    OR
    ("sourceChannel" = 'TELEGRAM' AND "evidenceKind" = 'TELEGRAM_MESSAGE')
  ),
  CONSTRAINT "MemoryChannelDisclosureDelivery_text_check" CHECK (
    btrim("bindingEpoch") <> ''
    AND btrim("disclosureContractVersion") <> ''
    AND "disclosureFingerprint" ~ '^[A-Za-z0-9_-]{43}$'
    AND "disclosureHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("disclosureSnapshot") = 'object'
    AND ("connectionId" IS NULL OR btrim("connectionId") <> '')
    AND ("externalMessageId" IS NULL OR btrim("externalMessageId") <> '')
    AND ("proofHash" IS NULL OR "proofHash" ~ '^[0-9a-f]{64}$')
    AND ("lastErrorCode" IS NULL OR btrim("lastErrorCode") <> '')
  ),
  CONSTRAINT "MemoryChannelDisclosureDelivery_lease_check" CHECK (
    ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryChannelDisclosureDelivery_status_check" CHECK (
    (
      "status" = 'DELIVERED'
      AND "externalMessageId" IS NOT NULL
      AND "proofHash" IS NOT NULL
      AND "deliveredAt" IS NOT NULL
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "lastErrorCode" IS NULL
    )
    OR
    (
      "status" = 'PENDING'
      AND "externalMessageId" IS NULL
      AND "proofHash" IS NULL
      AND "deliveredAt" IS NULL
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "lastErrorCode" IS NULL
    )
    OR
    (
      "status" = 'FAILED'
      AND "externalMessageId" IS NULL
      AND "proofHash" IS NULL
      AND "deliveredAt" IS NULL
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "lastErrorCode" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "MemoryDisclosure_binding_policy_contract_epoch_key"
  ON "MemoryChannelDisclosureDelivery"(
    "channelBindingId",
    "policyRevision",
    "disclosureContractVersion",
    "bindingEpoch"
  );
CREATE UNIQUE INDEX "MemoryChannelDisclosureDelivery_id_scope_key"
  ON "MemoryChannelDisclosureDelivery"(
    "id",
    "representativeId",
    "contactId",
    "sourceChannel"
  );
CREATE UNIQUE INDEX "MemoryChannelDisclosureDelivery_proofHash_key"
  ON "MemoryChannelDisclosureDelivery"("proofHash");
CREATE INDEX "MemoryChannelDisclosureDelivery_contact_channel_idx"
  ON "MemoryChannelDisclosureDelivery"(
    "representativeId",
    "contactId",
    "sourceChannel",
    "status",
    "deliveredAt"
  );
CREATE INDEX "MemoryChannelDisclosureDelivery_conversation_channel_idx"
  ON "MemoryChannelDisclosureDelivery"(
    "conversationId",
    "sourceChannel",
    "status",
    "deliveredAt"
  );
CREATE INDEX "MemoryChannelDisclosureDelivery_due_idx"
  ON "MemoryChannelDisclosureDelivery"(
    "status",
    "availableAt",
    "leaseExpiresAt"
  );

ALTER TABLE "MemoryChannelDisclosureDelivery"
  ADD CONSTRAINT "MemoryChannelDisclosureDelivery_rep_fkey"
    FOREIGN KEY ("representativeId")
    REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryChannelDisclosureDelivery_contact_scope_fkey"
    FOREIGN KEY ("contactId", "representativeId")
    REFERENCES "Contact"("id", "representativeId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryChannelDisclosureDelivery_conversation_scope_fkey"
    FOREIGN KEY ("conversationId", "representativeId", "contactId")
    REFERENCES "Conversation"("id", "representativeId", "contactId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryChannelDisclosureDelivery_binding_fkey"
    FOREIGN KEY ("channelBindingId")
    REFERENCES "ConversationChannelBinding"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "protect_delivered_memory_channel_disclosure"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'DELIVERED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION
      'Delivered memory channel disclosure records are immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryChannelDisclosureDelivery_immutable_delivered_guard"
  BEFORE UPDATE ON "MemoryChannelDisclosureDelivery"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_delivered_memory_channel_disclosure"();

-- One exact private-channel input message may use governed memory only after
-- the current disclosure contract was delivered on the same binding epoch.
-- The caller passes the already locked/current policy revision; this helper
-- independently rechecks all immutable scope coordinates and provider proof.
CREATE OR REPLACE FUNCTION "memory_private_channel_disclosure_allows"(
  representative_id TEXT,
  contact_id TEXT,
  conversation_id TEXT,
  input_message_id TEXT,
  source_channel "RepresentativeChannelKind",
  policy_revision INTEGER,
  disclosure_contract_version TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  IF source_channel NOT IN (
       'MATRIX'::"RepresentativeChannelKind",
       'TELEGRAM'::"RepresentativeChannelKind"
     )
     OR policy_revision < 0
     OR disclosure_contract_version IS NULL
     OR btrim(disclosure_contract_version) = '' THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM "Message" AS input_message
      JOIN "ConversationChannelBinding" AS binding
        ON binding."id" = input_message."channelBindingId"
       AND binding."conversationId" = input_message."conversationId"
       AND binding."kind" = source_channel
      JOIN "MemoryChannelDisclosureDelivery" AS disclosure
        ON disclosure."representativeId" = representative_id
       AND disclosure."contactId" = contact_id
       AND disclosure."conversationId" = conversation_id
       AND disclosure."channelBindingId" = binding."id"
       AND disclosure."sourceChannel" = source_channel
       AND disclosure."policyRevision" = policy_revision
       AND disclosure."disclosureContractVersion" = disclosure_contract_version
       AND disclosure."representativeAssignmentRevision"
             IS NOT DISTINCT FROM binding."representativeAssignmentRevision"
       AND disclosure."connectionId" IS NOT DISTINCT FROM binding."connectionId"
       AND disclosure."status" = 'DELIVERED'::"MemoryDisclosureDeliveryStatus"
       AND disclosure."deliveredAt" IS NOT NULL
       AND disclosure."deliveredAt" < input_message."createdAt"
       AND disclosure."externalMessageId" IS NOT NULL
       AND disclosure."proofHash" ~ '^[0-9a-f]{64}$'
       AND (
         (source_channel = 'MATRIX'::"RepresentativeChannelKind"
          AND disclosure."evidenceKind" = 'MATRIX_MESSAGE'::"MemoryDisclosureEvidenceKind")
         OR
         (source_channel = 'TELEGRAM'::"RepresentativeChannelKind"
          AND disclosure."evidenceKind" = 'TELEGRAM_MESSAGE'::"MemoryDisclosureEvidenceKind")
       )
     WHERE input_message."id" = input_message_id
       AND input_message."conversationId" = conversation_id
       AND input_message."channelBindingId" IS NOT NULL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Preserve the complete 1200 truth-ledger guard definition and replace only
-- its former Web-only injection clause. Failing when the expected source text
-- is absent prevents a future migration order change from silently weakening
-- any of the existing lifecycle, provenance, or isolation invariants.
DO $migration$
DECLARE
  guard_definition TEXT;
  web_only_clause TEXT := $old$
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
$old$;
  private_channel_clause TEXT := $new$
         OR run_record."sourceChannel" NOT IN (
           'WEB'::"RepresentativeChannelKind",
           'MATRIX'::"RepresentativeChannelKind",
           'TELEGRAM'::"RepresentativeChannelKind"
         )
         OR (
           run_record."sourceChannel" = 'WEB'::"RepresentativeChannelKind"
           AND NOT policy_record."webRecallEnabled"
         )
         OR (
           run_record."sourceChannel" = 'MATRIX'::"RepresentativeChannelKind"
           AND (
             NOT policy_record."matrixRecallEnabled"
             OR NOT "memory_private_channel_disclosure_allows"(
               run_record."representativeId",
               run_record."contactId",
               run_record."conversationId",
               run_record."inputMessageId",
               run_record."sourceChannel",
               policy_record."revision",
               'private-channel-memory-v1'
             )
           )
         )
         OR (
           run_record."sourceChannel" = 'TELEGRAM'::"RepresentativeChannelKind"
           AND (
             NOT policy_record."telegramRecallEnabled"
             OR NOT "memory_private_channel_disclosure_allows"(
               run_record."representativeId",
               run_record."contactId",
               run_record."conversationId",
               run_record."inputMessageId",
               run_record."sourceChannel",
               policy_record."revision",
               'private-channel-memory-v1'
             )
           )
         )
$new$;
BEGIN
  SELECT pg_get_functiondef('"memory_use_item_scope_guard"()'::regprocedure)
    INTO guard_definition;
  IF guard_definition IS NULL
     OR strpos(guard_definition, web_only_clause) = 0
     OR strpos(
       substr(
         guard_definition,
         strpos(guard_definition, web_only_clause) + length(web_only_clause)
       ),
       web_only_clause
     ) > 0 THEN
    RAISE EXCEPTION
      'Expected exactly one Web-only memory injection clause before private-channel migration.';
  END IF;
  EXECUTE replace(guard_definition, web_only_clause, private_channel_clause);
END;
$migration$;

-- A policy re-enable may recreate a private-channel Contact Memory projection
-- only when its original source message is itself covered by the exact current
-- disclosure. Representative Experience keeps its pre-existing representative
-- scope rule; every actual Matrix/Telegram injection is still fenced above.
CREATE OR REPLACE FUNCTION "memory_projection_policy_reenable_allowed"(
  old_record "MemoryProjectionItem",
  new_record "MemoryProjectionItem"
) RETURNS BOOLEAN AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  candidate_record "MemoryCandidate"%ROWTYPE;
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
  SELECT * INTO candidate_record
    FROM "MemoryCandidate"
   WHERE "id" = version_record."sourceCandidateId"
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
        memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
        AND memory_record."sourceChannel" IN (
          'MATRIX'::"RepresentativeChannelKind",
          'TELEGRAM'::"RepresentativeChannelKind"
        )
        AND policy_record."contactMemoryEnabled"
        AND candidate_record."id" IS NOT NULL
        AND candidate_record."contactId" IS NOT DISTINCT FROM memory_record."contactId"
        AND candidate_record."sourceContactId" IS NOT DISTINCT FROM memory_record."contactId"
        AND candidate_record."scopeChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"
        AND candidate_record."originChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"
        AND (
          (
            memory_record."sourceChannel" = 'MATRIX'::"RepresentativeChannelKind"
            AND policy_record."matrixRecallEnabled"
          ) OR (
            memory_record."sourceChannel" = 'TELEGRAM'::"RepresentativeChannelKind"
            AND policy_record."telegramRecallEnabled"
          )
        )
        AND "memory_private_channel_disclosure_allows"(
          new_record."representativeId",
          candidate_record."sourceContactId",
          candidate_record."sourceConversationId",
          candidate_record."sourceMessageId",
          memory_record."sourceChannel",
          policy_record."revision",
          'private-channel-memory-v1'
        )
      ) OR (
        memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
        AND policy_record."representativeExperienceEnabled"
      )
    );
END;
$$ LANGUAGE plpgsql;

COMMIT;
