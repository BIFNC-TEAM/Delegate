-- Memory System T1: authoritative PostgreSQL business state.
-- This migration is intentionally additive. It does not copy, approve, or
-- activate any legacy OpenViking or Creator Training record.

BEGIN;

CREATE TYPE "MemoryScope" AS ENUM ('CONTACT_CHANNEL', 'REPRESENTATIVE');

CREATE TYPE "MemoryCategory" AS ENUM (
  'CONTACT_PREFERENCE',
  'CONTACT_GOAL',
  'CONTACT_CONSTRAINT',
  'CONTACT_CONTEXT',
  'REPRESENTATIVE_RESPONSE_PATTERN',
  'REPRESENTATIVE_SERVICE_PATTERN',
  'REPRESENTATIVE_SAFETY_PATTERN',
  'REPRESENTATIVE_ROUTING_PATTERN'
);

CREATE TYPE "MemorySourceKind" AS ENUM (
  'AUDIENCE_MESSAGE',
  'VERIFIED_CONTACT_FIELD',
  'OWNER_VERIFIED_CORRECTION'
);

CREATE TYPE "MemoryCandidateStatus" AS ENUM (
  'EXTRACTED',
  'QUARANTINED',
  'BLOCKED',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED'
);

CREATE TYPE "MemorySafetyClass" AS ENUM (
  'UNCLASSIFIED',
  'LOW_RISK',
  'REVIEW_REQUIRED',
  'SENSITIVE',
  'PROHIBITED'
);

CREATE TYPE "GovernedMemoryStatus" AS ENUM (
  'ACTIVE',
  'SUPPRESSED',
  'SUPERSEDED',
  'EXPIRED',
  'ARCHIVED',
  'DELETE_PENDING',
  'DELETED'
);

CREATE TYPE "MemoryReviewOutcome" AS ENUM (
  'APPROVED',
  'REJECTED',
  'BLOCKED',
  'CORRECTION_REQUESTED'
);

CREATE TYPE "MemoryReviewerRole" AS ENUM ('OWNER', 'ADMIN', 'REVIEWER', 'SYSTEM');
CREATE TYPE "MemoryExpiryAction" AS ENUM ('ARCHIVE', 'DELETE');
CREATE TYPE "MemoryExtractionTrigger" AS ENUM ('MANUAL', 'SHADOW', 'CHANNEL_MESSAGE', 'SCHEDULED');
CREATE TYPE "MemoryExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELED');
CREATE TYPE "MemoryProjectionLane" AS ENUM ('STAGING', 'RECALL');

CREATE TYPE "MemoryProjectionStatus" AS ENUM (
  'DISABLED',
  'QUEUED',
  'PROJECTING',
  'STAGED',
  'ACTIVE',
  'RETRYING',
  'SUPERSEDED',
  'DELETE_PENDING',
  'DELETING',
  'DELETED',
  'FAILED',
  'DELETE_FAILED'
);

CREATE TYPE "MemoryUseRunStatus" AS ENUM ('STARTED', 'COMPLETED', 'DEGRADED', 'FAILED', 'CANCELED');
CREATE TYPE "MemoryUseSourceKind" AS ENUM ('PUBLIC_KNOWLEDGE', 'CONTACT_MEMORY', 'REPRESENTATIVE_EXPERIENCE');
CREATE TYPE "MemoryReconciliationStatus" AS ENUM ('QUEUED', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELED');

CREATE TYPE "MemoryReconciliationIssueKind" AS ENUM (
  'MISSING_REMOTE',
  'ORPHAN_REMOTE',
  'HASH_MISMATCH',
  'STALE_ACTIVE_POINTER',
  'DUPLICATE_REMOTE',
  'FOREIGN_REMOTE',
  'HEALTHY'
);

CREATE TYPE "MemoryReconciliationItemStatus" AS ENUM ('OPEN', 'RETRYING', 'RESOLVED', 'IGNORED', 'FAILED');

CREATE TABLE "RepresentativeMemoryPolicy" (
  "representativeId" TEXT NOT NULL,
  "namespaceKey" TEXT NOT NULL,
  "longTermMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "contactMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "representativeExperienceEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoExtract" BOOLEAN NOT NULL DEFAULT false,
  "webRecallEnabled" BOOLEAN NOT NULL DEFAULT false,
  "webExtractEnabled" BOOLEAN NOT NULL DEFAULT false,
  "matrixRecallEnabled" BOOLEAN NOT NULL DEFAULT false,
  "matrixExtractEnabled" BOOLEAN NOT NULL DEFAULT false,
  "telegramRecallEnabled" BOOLEAN NOT NULL DEFAULT false,
  "telegramExtractEnabled" BOOLEAN NOT NULL DEFAULT false,
  "retentionDays" INTEGER NOT NULL DEFAULT 30,
  "expiryAction" "MemoryExpiryAction" NOT NULL DEFAULT 'ARCHIVE',
  "provider" TEXT NOT NULL DEFAULT 'openviking',
  "managedAgentId" TEXT,
  "managedTargetUri" TEXT,
  "recallLimit" INTEGER NOT NULL DEFAULT 6,
  "recallScoreThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RepresentativeMemoryPolicy_pkey" PRIMARY KEY ("representativeId"),
  CONSTRAINT "RepresentativeMemoryPolicy_namespaceKey_key" UNIQUE ("namespaceKey"),
  CONSTRAINT "MemoryPolicy_text_check" CHECK (
    btrim("namespaceKey") <> ''
    AND btrim("provider") <> ''
    AND ("managedAgentId" IS NULL OR btrim("managedAgentId") <> '')
    AND ("managedTargetUri" IS NULL OR btrim("managedTargetUri") <> '')
  ),
  CONSTRAINT "MemoryPolicy_limits_check" CHECK (
    "retentionDays" BETWEEN 1 AND 3650
    AND "recallLimit" BETWEEN 1 AND 50
    AND "recallScoreThreshold" >= 0
    AND "recallScoreThreshold" <= 1
    AND "revision" >= 0
  ),
  CONSTRAINT "MemoryPolicy_safe_enablement_check" CHECK (
    (NOT "contactMemoryEnabled" OR "longTermMemoryEnabled")
    AND (NOT "representativeExperienceEnabled" OR "longTermMemoryEnabled")
    AND (NOT "autoExtract" OR (
      "longTermMemoryEnabled"
      AND ("contactMemoryEnabled" OR "representativeExperienceEnabled")
    ))
    AND (NOT "webRecallEnabled" OR "longTermMemoryEnabled")
    AND (NOT "matrixRecallEnabled" OR "longTermMemoryEnabled")
    AND (NOT "telegramRecallEnabled" OR "longTermMemoryEnabled")
    AND (NOT "webExtractEnabled" OR ("longTermMemoryEnabled" AND "autoExtract"))
    AND (NOT "matrixExtractEnabled" OR ("longTermMemoryEnabled" AND "autoExtract"))
    AND (NOT "telegramExtractEnabled" OR ("longTermMemoryEnabled" AND "autoExtract"))
  )
);

CREATE TABLE "MemoryExtractionRun" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "contactId" TEXT,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "sourceConversationId" TEXT,
  "sourceMessageId" TEXT,
  "trigger" "MemoryExtractionTrigger" NOT NULL,
  "status" "MemoryExtractionStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "acceptedCount" INTEGER NOT NULL DEFAULT 0,
  "rejectedCount" INTEGER NOT NULL DEFAULT 0,
  "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
  "reasonCounts" JSONB,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryExtractionRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryExtractionRun_rep_idempotency_key" UNIQUE ("representativeId", "idempotencyKey"),
  CONSTRAINT "MemoryExtractionRun_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "MemoryExtractionRun_provenance_key" UNIQUE ("id", "representativeId", "contactId", "sourceConversationId"),
  CONSTRAINT "MemoryExtractionRun_text_check" CHECK (btrim("idempotencyKey") <> ''),
  CONSTRAINT "MemoryExtractionRun_counts_check" CHECK (
    "candidateCount" >= 0
    AND "acceptedCount" >= 0
    AND "rejectedCount" >= 0
    AND "quarantinedCount" >= 0
    AND "acceptedCount" + "rejectedCount" + "quarantinedCount" <= "candidateCount"
    AND "attemptCount" >= 0
  ),
  CONSTRAINT "MemoryExtractionRun_source_check" CHECK (
    (
      "sourceConversationId" IS NULL
      AND "sourceMessageId" IS NULL
      AND "contactId" IS NULL
      AND "trigger" = 'SCHEDULED'::"MemoryExtractionTrigger"
    ) OR (
      "sourceConversationId" IS NOT NULL
      AND "sourceMessageId" IS NOT NULL
      AND "contactId" IS NOT NULL
    )
  ),
  CONSTRAINT "MemoryExtractionRun_lease_check" CHECK (
    ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryExtractionRun_lifecycle_check" CHECK (
    ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("finishedAt" IS NULL OR ("startedAt" IS NOT NULL AND "finishedAt" >= "startedAt"))
    AND (
      "status" NOT IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED')
      OR "finishedAt" IS NOT NULL
    )
  )
);

CREATE TABLE "MemoryCandidate" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "extractionRunId" TEXT,
  "contactId" TEXT,
  "scope" "MemoryScope" NOT NULL,
  "scopeChannel" "RepresentativeChannelKind",
  "originChannel" "RepresentativeChannelKind" NOT NULL,
  "category" "MemoryCategory" NOT NULL,
  "sourceKind" "MemorySourceKind" NOT NULL,
  "safeText" TEXT,
  "summary" TEXT,
  "contentHash" TEXT,
  "contentPurgedAt" TIMESTAMP(3),
  "dedupeKey" TEXT NOT NULL,
  "status" "MemoryCandidateStatus" NOT NULL DEFAULT 'EXTRACTED',
  "safetyClass" "MemorySafetyClass" NOT NULL DEFAULT 'UNCLASSIFIED',
  "safetyReasonCode" TEXT,
  "extractionReasonCode" TEXT NOT NULL,
  "sourceContactId" TEXT NOT NULL,
  "sourceConversationId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "deidentifiedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryCandidate_rep_dedupe_key" UNIQUE ("representativeId", "dedupeKey"),
  CONSTRAINT "MemoryCandidate_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "MemoryCandidate_id_rep_scope_key" UNIQUE ("id", "representativeId", "scope"),
  CONSTRAINT "MemoryCandidate_text_check" CHECK (
    btrim("dedupeKey") <> ''
    AND btrim("extractionReasonCode") <> ''
    AND ("safetyReasonCode" IS NULL OR btrim("safetyReasonCode") <> '')
  ),
  CONSTRAINT "MemoryCandidate_scope_check" CHECK (
    (
      "scope" = 'CONTACT_CHANNEL'::"MemoryScope"
      AND "contactId" IS NOT NULL
      AND "contactId" = "sourceContactId"
      AND "scopeChannel" IS NOT NULL
      AND "scopeChannel" = "originChannel"
      AND "category" IN (
        'CONTACT_PREFERENCE'::"MemoryCategory",
        'CONTACT_GOAL'::"MemoryCategory",
        'CONTACT_CONSTRAINT'::"MemoryCategory",
        'CONTACT_CONTEXT'::"MemoryCategory"
      )
    ) OR (
      "scope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "contactId" IS NULL
      AND "scopeChannel" IS NULL
      AND "category" IN (
        'REPRESENTATIVE_RESPONSE_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_SERVICE_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_SAFETY_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_ROUTING_PATTERN'::"MemoryCategory"
      )
    )
  ),
  CONSTRAINT "MemoryCandidate_payload_check" CHECK (
    (
      "contentPurgedAt" IS NULL
      AND "summary" IS NOT NULL
      AND btrim("summary") <> ''
      AND length("summary") <= 2000
      AND ("safeText" IS NULL OR (btrim("safeText") <> '' AND length("safeText") <= 8000))
    ) OR (
      "contentPurgedAt" IS NOT NULL
      AND "safeText" IS NULL
      AND "summary" IS NULL
    )
  ),
  CONSTRAINT "MemoryCandidate_hash_check" CHECK (
    "contentHash" IS NULL OR "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MemoryCandidate_reviewable_check" CHECK (
    "status" <> 'PENDING_REVIEW'::"MemoryCandidateStatus"
    OR (
      "contentPurgedAt" IS NULL
      AND "safeText" IS NOT NULL
      AND "contentHash" IS NOT NULL
      AND "safetyClass" IN ('LOW_RISK', 'REVIEW_REQUIRED')
    )
  ),
  CONSTRAINT "MemoryCandidate_approval_check" CHECK (
    "status" <> 'APPROVED'::"MemoryCandidateStatus"
    OR (
      "reviewedAt" IS NOT NULL
      AND "contentHash" IS NOT NULL
      AND (
        "contentPurgedAt" IS NOT NULL
        OR ("safeText" IS NOT NULL AND "safetyClass" IN ('LOW_RISK', 'REVIEW_REQUIRED'))
      )
    )
  ),
  CONSTRAINT "MemoryCandidate_deidentification_check" CHECK (
    "scope" <> 'REPRESENTATIVE'::"MemoryScope"
    OR "status" NOT IN ('PENDING_REVIEW', 'APPROVED')
    OR "contentPurgedAt" IS NOT NULL
    OR "deidentifiedAt" IS NOT NULL
  ),
  CONSTRAINT "MemoryCandidate_expiry_check" CHECK (
    "expiresAt" IS NULL OR "expiresAt" > "createdAt"
  )
);

CREATE TABLE "GovernedMemory" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "contactId" TEXT,
  "scope" "MemoryScope" NOT NULL,
  "sourceChannel" "RepresentativeChannelKind",
  "category" "MemoryCategory" NOT NULL,
  "status" "GovernedMemoryStatus" NOT NULL DEFAULT 'SUPPRESSED',
  "currentVersionId" TEXT,
  "recallDisabledAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "deleteRequestedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GovernedMemory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GovernedMemory_currentVersionId_key" UNIQUE ("currentVersionId"),
  CONSTRAINT "GovernedMemory_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "GovernedMemory_id_rep_scope_key" UNIQUE ("id", "representativeId", "scope"),
  CONSTRAINT "GovernedMemory_current_id_key" UNIQUE ("currentVersionId", "id"),
  CONSTRAINT "GovernedMemory_scope_check" CHECK (
    (
      "scope" = 'CONTACT_CHANNEL'::"MemoryScope"
      AND "contactId" IS NOT NULL
      AND "sourceChannel" IS NOT NULL
      AND "category" IN (
        'CONTACT_PREFERENCE'::"MemoryCategory",
        'CONTACT_GOAL'::"MemoryCategory",
        'CONTACT_CONSTRAINT'::"MemoryCategory",
        'CONTACT_CONTEXT'::"MemoryCategory"
      )
    ) OR (
      "scope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "contactId" IS NULL
      AND "sourceChannel" IS NULL
      AND "category" IN (
        'REPRESENTATIVE_RESPONSE_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_SERVICE_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_SAFETY_PATTERN'::"MemoryCategory",
        'REPRESENTATIVE_ROUTING_PATTERN'::"MemoryCategory"
      )
    )
  ),
  CONSTRAINT "GovernedMemory_recall_fence_check" CHECK (
    (
      "status" = 'ACTIVE'::"GovernedMemoryStatus"
      AND "currentVersionId" IS NOT NULL
      AND "recallDisabledAt" IS NULL
      AND "deleteRequestedAt" IS NULL
      AND "deletedAt" IS NULL
    ) OR (
      "status" <> 'ACTIVE'::"GovernedMemoryStatus"
      AND "recallDisabledAt" IS NOT NULL
    )
  ),
  CONSTRAINT "GovernedMemory_lifecycle_check" CHECK (
    ("status" <> 'SUPERSEDED' OR "supersededAt" IS NOT NULL)
    AND ("status" <> 'ARCHIVED' OR "archivedAt" IS NOT NULL)
    AND ("status" <> 'DELETE_PENDING' OR "deleteRequestedAt" IS NOT NULL)
    AND (
      "status" <> 'DELETED'
      OR ("deleteRequestedAt" IS NOT NULL AND "deletedAt" IS NOT NULL)
    )
    AND ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
  )
);

CREATE TABLE "GovernedMemoryVersion" (
  "id" TEXT NOT NULL,
  "memoryId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "scope" "MemoryScope" NOT NULL,
  "sourceCandidateId" TEXT,
  "supersedesVersionId" TEXT,
  "versionNumber" INTEGER NOT NULL,
  "safeText" TEXT,
  "summary" TEXT,
  "contentHash" TEXT NOT NULL,
  "deidentifiedAt" TIMESTAMP(3),
  "deidentificationMethod" TEXT,
  "purgedAt" TIMESTAMP(3),
  "correctionReasonCode" TEXT,
  "createdByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GovernedMemoryVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GovernedMemoryVersion_sourceCandidateId_key" UNIQUE ("sourceCandidateId"),
  CONSTRAINT "GovernedMemoryVersion_source_rep_scope_key" UNIQUE ("sourceCandidateId", "representativeId", "scope"),
  CONSTRAINT "GovernedMemoryVersion_memory_version_key" UNIQUE ("memoryId", "versionNumber"),
  CONSTRAINT "GovernedMemoryVersion_id_memory_key" UNIQUE ("id", "memoryId"),
  CONSTRAINT "GovernedMemoryVersion_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "GovernedMemoryVersion_id_rep_scope_key" UNIQUE ("id", "representativeId", "scope"),
  CONSTRAINT "GovernedMemoryVersion_id_memory_rep_key" UNIQUE ("id", "memoryId", "representativeId"),
  CONSTRAINT "GovernedMemoryVersion_version_check" CHECK ("versionNumber" > 0),
  CONSTRAINT "GovernedMemoryVersion_chain_check" CHECK (
    ("versionNumber" = 1 AND "supersedesVersionId" IS NULL)
    OR ("versionNumber" > 1 AND "supersedesVersionId" IS NOT NULL)
  ),
  CONSTRAINT "GovernedMemoryVersion_payload_check" CHECK (
    (
      "purgedAt" IS NULL
      AND "safeText" IS NOT NULL
      AND btrim("safeText") <> ''
      AND length("safeText") <= 8000
      AND "summary" IS NOT NULL
      AND btrim("summary") <> ''
      AND length("summary") <= 2000
    ) OR (
      "purgedAt" IS NOT NULL
      AND "safeText" IS NULL
      AND "summary" IS NULL
    )
  ),
  CONSTRAINT "GovernedMemoryVersion_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "GovernedMemoryVersion_actor_check" CHECK (
    btrim("createdByActorId") <> ''
    AND ("correctionReasonCode" IS NULL OR btrim("correctionReasonCode") <> '')
  ),
  CONSTRAINT "GovernedMemoryVersion_deidentification_check" CHECK (
    (
      "scope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "deidentifiedAt" IS NOT NULL
      AND "deidentificationMethod" IS NOT NULL
      AND btrim("deidentificationMethod") <> ''
    ) OR (
      "scope" = 'CONTACT_CHANNEL'::"MemoryScope"
      AND (("deidentifiedAt" IS NULL) = ("deidentificationMethod" IS NULL))
    )
  )
);

CREATE TABLE "MemoryReviewDecision" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "candidateId" TEXT,
  "memoryId" TEXT,
  "resultVersionId" TEXT,
  "outcome" "MemoryReviewOutcome" NOT NULL,
  "reviewerRole" "MemoryReviewerRole" NOT NULL,
  "reviewerActorId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryReviewDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryReviewDecision_actor_check" CHECK (
    btrim("reviewerActorId") <> '' AND btrim("reasonCode") <> ''
  ),
  CONSTRAINT "MemoryReviewDecision_target_check" CHECK (
    "candidateId" IS NOT NULL OR "memoryId" IS NOT NULL
  ),
  CONSTRAINT "MemoryReviewDecision_system_approval_check" CHECK (
    NOT (
      "reviewerRole" = 'SYSTEM'::"MemoryReviewerRole"
      AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
    )
  ),
  CONSTRAINT "MemoryReviewDecision_result_check" CHECK (
    (
      "outcome" = 'APPROVED'::"MemoryReviewOutcome"
      AND "candidateId" IS NOT NULL
      AND "memoryId" IS NOT NULL
      AND "resultVersionId" IS NOT NULL
    ) OR (
      "outcome" <> 'APPROVED'::"MemoryReviewOutcome"
      AND (
        "resultVersionId" IS NULL
        OR (
          "outcome" = 'CORRECTION_REQUESTED'::"MemoryReviewOutcome"
          AND "memoryId" IS NOT NULL
        )
      )
    )
  )
);

CREATE TABLE "MemoryProjectionItem" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "memoryId" TEXT NOT NULL,
  "memoryVersionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'openviking',
  "lane" "MemoryProjectionLane" NOT NULL,
  "status" "MemoryProjectionStatus" NOT NULL DEFAULT 'DISABLED',
  "contentHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "remoteObjectId" TEXT,
  "remoteUri" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "projectedAt" TIMESTAMP(3),
  "deleteRequestedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryProjectionItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryProjectionItem_rep_idempotency_key" UNIQUE ("representativeId", "idempotencyKey"),
  CONSTRAINT "MemoryProjectionItem_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "MemoryProjectionItem_id_rep_version_key" UNIQUE ("id", "representativeId", "memoryVersionId"),
  CONSTRAINT "MemoryProjectionItem_provider_lane_version_key" UNIQUE ("provider", "lane", "memoryVersionId"),
  CONSTRAINT "MemoryProjectionItem_text_check" CHECK (
    btrim("provider") <> ''
    AND btrim("idempotencyKey") <> ''
    AND ("remoteObjectId" IS NULL OR btrim("remoteObjectId") <> '')
    AND ("remoteUri" IS NULL OR btrim("remoteUri") <> '')
  ),
  CONSTRAINT "MemoryProjectionItem_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MemoryProjectionItem_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "MemoryProjectionItem_lease_check" CHECK (
    ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryProjectionItem_active_check" CHECK (
    "status" NOT IN (
      'ACTIVE'::"MemoryProjectionStatus",
      'STAGED'::"MemoryProjectionStatus"
    )
    OR (
      "remoteObjectId" IS NOT NULL
      AND "remoteUri" IS NOT NULL
      AND "projectedAt" IS NOT NULL
      AND "deletedAt" IS NULL
    )
  ),
  CONSTRAINT "MemoryProjectionItem_deletion_check" CHECK (
    "status" NOT IN ('DELETE_PENDING', 'DELETING', 'DELETE_FAILED', 'DELETED')
    OR "deleteRequestedAt" IS NOT NULL
  ),
  CONSTRAINT "MemoryProjectionItem_deleted_check" CHECK (
    "status" <> 'DELETED'::"MemoryProjectionStatus" OR "deletedAt" IS NOT NULL
  )
);

CREATE TABLE "MemoryUseRun" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "sourceChannel" "RepresentativeChannelKind" NOT NULL,
  "representativeVersionId" TEXT NOT NULL,
  "inputMessageId" TEXT NOT NULL,
  "outputMessageId" TEXT,
  "generationRunId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "MemoryUseRunStatus" NOT NULL DEFAULT 'STARTED',
  "searchedCount" INTEGER NOT NULL DEFAULT 0,
  "scopePassedCount" INTEGER NOT NULL DEFAULT 0,
  "safetyPassedCount" INTEGER NOT NULL DEFAULT 0,
  "injectedCount" INTEGER NOT NULL DEFAULT 0,
  "displayedCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryUseRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryUseRun_rep_idempotency_key" UNIQUE ("representativeId", "idempotencyKey"),
  CONSTRAINT "MemoryUseRun_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "MemoryUseRun_generation_conversation_key" UNIQUE ("generationRunId", "conversationId"),
  CONSTRAINT "MemoryUseRun_text_check" CHECK (btrim("idempotencyKey") <> ''),
  CONSTRAINT "MemoryUseRun_counts_check" CHECK (
    "searchedCount" >= 0
    AND "scopePassedCount" BETWEEN 0 AND "searchedCount"
    AND "safetyPassedCount" BETWEEN 0 AND "scopePassedCount"
    AND "injectedCount" BETWEEN 0 AND "safetyPassedCount"
    AND "displayedCount" BETWEEN 0 AND "injectedCount"
  ),
  CONSTRAINT "MemoryUseRun_lifecycle_check" CHECK (
    "completedAt" IS NULL OR "completedAt" >= "startedAt"
  ),
  CONSTRAINT "MemoryUseRun_terminal_check" CHECK (
    "status" = 'STARTED'::"MemoryUseRunStatus" OR "completedAt" IS NOT NULL
  )
);

CREATE TABLE "MemoryUseItem" (
  "id" TEXT NOT NULL,
  "useRunId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "sourceKind" "MemoryUseSourceKind" NOT NULL,
  "memoryScope" "MemoryScope",
  "memoryVersionId" TEXT,
  "projectionItemId" TEXT,
  "knowledgeBindingId" TEXT,
  "representativeVersionId" TEXT,
  "displayedCitationId" TEXT,
  "contentHash" TEXT NOT NULL,
  "searchRank" INTEGER,
  "searchScore" DOUBLE PRECISION,
  "searchedAt" TIMESTAMP(3),
  "scopeCheckedAt" TIMESTAMP(3),
  "scopePassedAt" TIMESTAMP(3),
  "safetyCheckedAt" TIMESTAMP(3),
  "safetyPassedAt" TIMESTAMP(3),
  "injectedAt" TIMESTAMP(3),
  "displayedAt" TIMESTAMP(3),
  "rejectionReasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryUseItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryUseItem_displayedCitationId_key" UNIQUE ("displayedCitationId"),
  CONSTRAINT "MemoryUseItem_run_item_key" UNIQUE ("useRunId", "itemKey"),
  CONSTRAINT "MemoryUseItem_text_check" CHECK (
    btrim("itemKey") <> ''
    AND ("rejectionReasonCode" IS NULL OR btrim("rejectionReasonCode") <> '')
  ),
  CONSTRAINT "MemoryUseItem_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MemoryUseItem_score_check" CHECK (
    ("searchRank" IS NULL OR "searchRank" > 0)
    AND ("searchScore" IS NULL OR ("searchScore" >= 0 AND "searchScore" <= 1))
  ),
  CONSTRAINT "MemoryUseItem_source_shape_check" CHECK (
    (
      "sourceKind" = 'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind"
      AND "knowledgeBindingId" IS NOT NULL
      AND "representativeVersionId" IS NOT NULL
      AND "memoryScope" IS NULL
      AND "memoryVersionId" IS NULL
      AND "projectionItemId" IS NULL
    ) OR (
      "sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
      AND "memoryScope" = 'CONTACT_CHANNEL'::"MemoryScope"
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "knowledgeBindingId" IS NULL
      AND "representativeVersionId" IS NULL
    ) OR (
      "sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
      AND "memoryScope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "knowledgeBindingId" IS NULL
      AND "representativeVersionId" IS NULL
    )
  ),
  CONSTRAINT "MemoryUseItem_stage_chain_check" CHECK (
    ("scopeCheckedAt" IS NULL OR "searchedAt" IS NOT NULL)
    AND ("scopePassedAt" IS NULL OR "scopeCheckedAt" IS NOT NULL)
    AND ("safetyCheckedAt" IS NULL OR "scopePassedAt" IS NOT NULL)
    AND ("safetyPassedAt" IS NULL OR "safetyCheckedAt" IS NOT NULL)
    AND ("injectedAt" IS NULL OR "safetyPassedAt" IS NOT NULL)
    AND ("displayedAt" IS NULL OR ("injectedAt" IS NOT NULL AND "displayedCitationId" IS NOT NULL))
    AND ("displayedCitationId" IS NULL OR "displayedAt" IS NOT NULL)
  ),
  CONSTRAINT "MemoryUseItem_stage_time_check" CHECK (
    ("scopeCheckedAt" IS NULL OR "scopeCheckedAt" >= "searchedAt")
    AND ("scopePassedAt" IS NULL OR "scopePassedAt" >= "scopeCheckedAt")
    AND ("safetyCheckedAt" IS NULL OR "safetyCheckedAt" >= "scopePassedAt")
    AND ("safetyPassedAt" IS NULL OR "safetyPassedAt" >= "safetyCheckedAt")
    AND ("injectedAt" IS NULL OR "injectedAt" >= "safetyPassedAt")
    AND ("displayedAt" IS NULL OR "displayedAt" >= "injectedAt")
  )
);

CREATE TABLE "MemoryDeletionProof" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "memoryId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestedByActorId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "recallBlockedAt" TIMESTAMP(3) NOT NULL,
  "localPurgeCompletedAt" TIMESTAMP(3),
  "remotePurgeCompletedAt" TIMESTAMP(3),
  "providerReceiptHash" TEXT,
  "proofHash" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryDeletionProof_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryDeletionProof_memoryId_key" UNIQUE ("memoryId"),
  CONSTRAINT "MemoryDeletionProof_proofHash_key" UNIQUE ("proofHash"),
  CONSTRAINT "MemoryDeletionProof_rep_request_key" UNIQUE ("representativeId", "requestId"),
  CONSTRAINT "MemoryDeletionProof_memory_rep_key" UNIQUE ("memoryId", "representativeId"),
  CONSTRAINT "MemoryDeletionProof_text_check" CHECK (
    btrim("requestId") <> ''
    AND btrim("requestedByActorId") <> ''
    AND btrim("reasonCode") <> ''
  ),
  CONSTRAINT "MemoryDeletionProof_hash_check" CHECK (
    "contentHash" ~ '^[0-9a-f]{64}$'
    AND ("providerReceiptHash" IS NULL OR "providerReceiptHash" ~ '^[0-9a-f]{64}$')
    AND ("proofHash" IS NULL OR "proofHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "MemoryDeletionProof_lifecycle_check" CHECK (
    "recallBlockedAt" <= "createdAt"
    AND ("localPurgeCompletedAt" IS NULL OR "localPurgeCompletedAt" >= "recallBlockedAt")
    AND ("remotePurgeCompletedAt" IS NULL OR "remotePurgeCompletedAt" >= "recallBlockedAt")
    AND (
      "completedAt" IS NULL
      OR (
        "localPurgeCompletedAt" IS NOT NULL
        AND "remotePurgeCompletedAt" IS NOT NULL
        AND "proofHash" IS NOT NULL
        AND "completedAt" >= "localPurgeCompletedAt"
        AND "completedAt" >= "remotePurgeCompletedAt"
      )
    )
  )
);

CREATE TABLE "MemoryReconciliationRun" (
  "id" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'openviking',
  "status" "MemoryReconciliationStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expectedCount" INTEGER NOT NULL DEFAULT 0,
  "observedCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "issueCount" INTEGER NOT NULL DEFAULT 0,
  "resolvedCount" INTEGER NOT NULL DEFAULT 0,
  "cursor" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryReconciliationRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryReconciliationRun_rep_idempotency_key" UNIQUE ("representativeId", "idempotencyKey"),
  CONSTRAINT "MemoryReconciliationRun_id_rep_key" UNIQUE ("id", "representativeId"),
  CONSTRAINT "MemoryReconciliationRun_text_check" CHECK (
    btrim("provider") <> '' AND btrim("idempotencyKey") <> ''
  ),
  CONSTRAINT "MemoryReconciliationRun_counts_check" CHECK (
    "expectedCount" >= 0
    AND "observedCount" >= 0
    AND "matchedCount" >= 0
    AND "issueCount" >= 0
    AND "resolvedCount" BETWEEN 0 AND "issueCount"
    AND "attemptCount" >= 0
  ),
  CONSTRAINT "MemoryReconciliationRun_lease_check" CHECK (
    ("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryReconciliationRun_lifecycle_check" CHECK (
    ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("finishedAt" IS NULL OR ("startedAt" IS NOT NULL AND "finishedAt" >= "startedAt"))
    AND (
      "status" NOT IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED')
      OR "finishedAt" IS NOT NULL
    )
  )
);

CREATE TABLE "MemoryReconciliationItem" (
  "id" TEXT NOT NULL,
  "reconciliationRunId" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL,
  "projectionItemId" TEXT,
  "itemKey" TEXT NOT NULL,
  "issueKind" "MemoryReconciliationIssueKind" NOT NULL,
  "status" "MemoryReconciliationItemStatus" NOT NULL DEFAULT 'OPEN',
  "expectedContentHash" TEXT,
  "observedContentHash" TEXT,
  "remoteObjectIdHash" TEXT,
  "reasonCode" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryReconciliationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryReconciliationItem_run_item_key" UNIQUE ("reconciliationRunId", "itemKey"),
  CONSTRAINT "MemoryReconciliationItem_text_check" CHECK (
    btrim("itemKey") <> ''
    AND ("reasonCode" IS NULL OR btrim("reasonCode") <> '')
  ),
  CONSTRAINT "MemoryReconciliationItem_hash_check" CHECK (
    ("expectedContentHash" IS NULL OR "expectedContentHash" ~ '^[0-9a-f]{64}$')
    AND ("observedContentHash" IS NULL OR "observedContentHash" ~ '^[0-9a-f]{64}$')
    AND ("remoteObjectIdHash" IS NULL OR "remoteObjectIdHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "MemoryReconciliationItem_lifecycle_check" CHECK (
    "attemptCount" >= 0
    AND ("status" NOT IN ('RESOLVED', 'IGNORED') OR "resolvedAt" IS NOT NULL)
  )
);

-- Query and worker indexes.
CREATE INDEX "RepresentativeMemoryPolicy_enabled_updatedAt_idx"
  ON "RepresentativeMemoryPolicy"("longTermMemoryEnabled", "updatedAt");
CREATE INDEX "MemoryExtractionRun_rep_status_created_idx"
  ON "MemoryExtractionRun"("representativeId", "status", "createdAt");
CREATE INDEX "MemoryExtractionRun_contact_channel_idx"
  ON "MemoryExtractionRun"("representativeId", "contactId", "sourceChannel", "createdAt");
CREATE INDEX "MemoryExtractionRun_due_lease_idx"
  ON "MemoryExtractionRun"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "MemoryExtractionRun_sourceMessageId_idx"
  ON "MemoryExtractionRun"("sourceMessageId");
CREATE INDEX "MemoryCandidate_rep_status_created_idx"
  ON "MemoryCandidate"("representativeId", "status", "createdAt");
CREATE INDEX "MemoryCandidate_contact_scope_status_idx"
  ON "MemoryCandidate"("representativeId", "contactId", "scopeChannel", "status", "createdAt");
CREATE INDEX "MemoryCandidate_source_message_idx"
  ON "MemoryCandidate"("sourceConversationId", "sourceMessageId", "createdAt");
CREATE INDEX "MemoryCandidate_extraction_created_idx"
  ON "MemoryCandidate"("extractionRunId", "createdAt");
CREATE INDEX "MemoryCandidate_expires_status_idx"
  ON "MemoryCandidate"("expiresAt", "status");
CREATE INDEX "GovernedMemory_rep_status_updated_idx"
  ON "GovernedMemory"("representativeId", "status", "updatedAt");
CREATE INDEX "GovernedMemory_contact_scope_status_idx"
  ON "GovernedMemory"("representativeId", "contactId", "sourceChannel", "status", "updatedAt");
CREATE INDEX "GovernedMemory_status_recall_expiry_idx"
  ON "GovernedMemory"("status", "recallDisabledAt", "expiresAt");
CREATE INDEX "GovernedMemory_status_deleteRequested_idx"
  ON "GovernedMemory"("status", "deleteRequestedAt");
CREATE INDEX "GovernedMemoryVersion_memory_hash_idx"
  ON "GovernedMemoryVersion"("memoryId", "contentHash");
CREATE INDEX "GovernedMemoryVersion_rep_created_idx"
  ON "GovernedMemoryVersion"("representativeId", "createdAt");
CREATE INDEX "GovernedMemoryVersion_supersedes_idx"
  ON "GovernedMemoryVersion"("supersedesVersionId");
CREATE INDEX "MemoryReviewDecision_rep_created_idx"
  ON "MemoryReviewDecision"("representativeId", "createdAt");
CREATE INDEX "MemoryReviewDecision_candidate_created_idx"
  ON "MemoryReviewDecision"("candidateId", "createdAt");
CREATE INDEX "MemoryReviewDecision_memory_created_idx"
  ON "MemoryReviewDecision"("memoryId", "createdAt");
CREATE INDEX "MemoryReviewDecision_resultVersion_idx"
  ON "MemoryReviewDecision"("resultVersionId");
CREATE UNIQUE INDEX "MemoryReviewDecision_one_terminal_candidate_key"
  ON "MemoryReviewDecision"("candidateId")
  WHERE "candidateId" IS NOT NULL
    AND "outcome" IN (
      'APPROVED'::"MemoryReviewOutcome",
      'REJECTED'::"MemoryReviewOutcome",
      'BLOCKED'::"MemoryReviewOutcome"
    );
CREATE INDEX "MemoryProjectionItem_rep_lane_status_idx"
  ON "MemoryProjectionItem"("representativeId", "lane", "status", "updatedAt");
CREATE INDEX "MemoryProjectionItem_memory_status_idx"
  ON "MemoryProjectionItem"("memoryId", "status", "updatedAt");
CREATE INDEX "MemoryProjectionItem_due_lease_idx"
  ON "MemoryProjectionItem"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "MemoryProjectionItem_status_delete_idx"
  ON "MemoryProjectionItem"("status", "deleteRequestedAt");
CREATE UNIQUE INDEX "MemoryProjectionItem_one_active_memory_key"
  ON "MemoryProjectionItem"("memoryId", "provider", "lane")
  WHERE "status" = 'ACTIVE'::"MemoryProjectionStatus";
CREATE INDEX "MemoryUseRun_rep_created_idx"
  ON "MemoryUseRun"("representativeId", "createdAt");
CREATE INDEX "MemoryUseRun_contact_channel_idx"
  ON "MemoryUseRun"("representativeId", "contactId", "sourceChannel", "createdAt");
CREATE INDEX "MemoryUseRun_conversation_created_idx"
  ON "MemoryUseRun"("conversationId", "createdAt");
CREATE INDEX "MemoryUseRun_rep_version_idx"
  ON "MemoryUseRun"("representativeVersionId");
CREATE INDEX "MemoryUseRun_inputMessage_idx" ON "MemoryUseRun"("inputMessageId");
CREATE INDEX "MemoryUseRun_outputMessage_idx" ON "MemoryUseRun"("outputMessageId");
CREATE INDEX "MemoryUseRun_status_started_idx" ON "MemoryUseRun"("status", "startedAt");
CREATE INDEX "MemoryUseItem_memoryVersion_created_idx"
  ON "MemoryUseItem"("memoryVersionId", "createdAt");
CREATE INDEX "MemoryUseItem_public_knowledge_idx"
  ON "MemoryUseItem"("knowledgeBindingId", "representativeVersionId", "createdAt");
CREATE INDEX "MemoryUseItem_projection_idx" ON "MemoryUseItem"("projectionItemId");
CREATE INDEX "MemoryUseItem_run_injected_idx" ON "MemoryUseItem"("useRunId", "injectedAt");
CREATE INDEX "MemoryUseItem_run_displayed_idx" ON "MemoryUseItem"("useRunId", "displayedAt");
CREATE INDEX "MemoryDeletionProof_rep_created_idx"
  ON "MemoryDeletionProof"("representativeId", "createdAt");
CREATE INDEX "MemoryDeletionProof_completed_created_idx"
  ON "MemoryDeletionProof"("completedAt", "createdAt");
CREATE INDEX "MemoryReconciliationRun_rep_created_idx"
  ON "MemoryReconciliationRun"("representativeId", "createdAt");
CREATE INDEX "MemoryReconciliationRun_due_lease_idx"
  ON "MemoryReconciliationRun"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "MemoryReconciliationItem_rep_status_idx"
  ON "MemoryReconciliationItem"("representativeId", "status", "createdAt");
CREATE INDEX "MemoryReconciliationItem_projection_idx"
  ON "MemoryReconciliationItem"("projectionItemId");
CREATE INDEX "MemoryReconciliationItem_status_available_idx"
  ON "MemoryReconciliationItem"("status", "availableAt");

-- Foreign keys are added after every table and composite key exists.
ALTER TABLE "RepresentativeMemoryPolicy"
  ADD CONSTRAINT "RepresentativeMemoryPolicy_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryExtractionRun"
  ADD CONSTRAINT "MemoryExtractionRun_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryExtractionRun_contact_scope_fkey"
  FOREIGN KEY ("contactId", "representativeId") REFERENCES "Contact"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryExtractionRun_conversation_scope_fkey"
  FOREIGN KEY ("sourceConversationId", "representativeId", "contactId")
  REFERENCES "Conversation"("id", "representativeId", "contactId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryExtractionRun_message_scope_fkey"
  FOREIGN KEY ("sourceMessageId", "sourceConversationId")
  REFERENCES "Message"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryCandidate"
  ADD CONSTRAINT "MemoryCandidate_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryCandidate_extraction_scope_fkey"
  FOREIGN KEY ("extractionRunId", "representativeId", "sourceContactId", "sourceConversationId")
  REFERENCES "MemoryExtractionRun"("id", "representativeId", "contactId", "sourceConversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryCandidate_contact_scope_fkey"
  FOREIGN KEY ("contactId", "representativeId") REFERENCES "Contact"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryCandidate_conversation_scope_fkey"
  FOREIGN KEY ("sourceConversationId", "representativeId", "sourceContactId")
  REFERENCES "Conversation"("id", "representativeId", "contactId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryCandidate_message_scope_fkey"
  FOREIGN KEY ("sourceMessageId", "sourceConversationId")
  REFERENCES "Message"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GovernedMemory"
  ADD CONSTRAINT "GovernedMemory_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GovernedMemory_contact_scope_fkey"
  FOREIGN KEY ("contactId", "representativeId") REFERENCES "Contact"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GovernedMemoryVersion"
  ADD CONSTRAINT "GovernedMemoryVersion_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GovernedMemoryVersion_memory_scope_fkey"
  FOREIGN KEY ("memoryId", "representativeId", "scope")
  REFERENCES "GovernedMemory"("id", "representativeId", "scope")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GovernedMemoryVersion_candidate_scope_fkey"
  FOREIGN KEY ("sourceCandidateId", "representativeId", "scope")
  REFERENCES "MemoryCandidate"("id", "representativeId", "scope")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GovernedMemoryVersion_supersedes_fkey"
  FOREIGN KEY ("supersedesVersionId", "memoryId")
  REFERENCES "GovernedMemoryVersion"("id", "memoryId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GovernedMemory"
  ADD CONSTRAINT "GovernedMemory_currentVersion_fkey"
  FOREIGN KEY ("currentVersionId", "id")
  REFERENCES "GovernedMemoryVersion"("id", "memoryId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryReviewDecision"
  ADD CONSTRAINT "MemoryReviewDecision_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryReviewDecision_candidate_scope_fkey"
  FOREIGN KEY ("candidateId", "representativeId")
  REFERENCES "MemoryCandidate"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryReviewDecision_memory_scope_fkey"
  FOREIGN KEY ("memoryId", "representativeId")
  REFERENCES "GovernedMemory"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryReviewDecision_result_scope_fkey"
  FOREIGN KEY ("resultVersionId", "memoryId", "representativeId")
  REFERENCES "GovernedMemoryVersion"("id", "memoryId", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryProjectionItem"
  ADD CONSTRAINT "MemoryProjectionItem_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryProjectionItem_version_scope_fkey"
  FOREIGN KEY ("memoryVersionId", "memoryId", "representativeId")
  REFERENCES "GovernedMemoryVersion"("id", "memoryId", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryUseRun"
  ADD CONSTRAINT "MemoryUseRun_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_contact_scope_fkey"
  FOREIGN KEY ("contactId", "representativeId") REFERENCES "Contact"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_conversation_scope_fkey"
  FOREIGN KEY ("conversationId", "representativeId", "contactId")
  REFERENCES "Conversation"("id", "representativeId", "contactId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_rep_version_fkey"
  FOREIGN KEY ("representativeVersionId", "representativeId")
  REFERENCES "RepresentativeVersion"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_input_message_fkey"
  FOREIGN KEY ("inputMessageId", "conversationId") REFERENCES "Message"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_output_message_fkey"
  FOREIGN KEY ("outputMessageId", "conversationId") REFERENCES "Message"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseRun_generation_fkey"
  FOREIGN KEY ("generationRunId", "conversationId") REFERENCES "GenerationRun"("id", "conversationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryUseItem"
  ADD CONSTRAINT "MemoryUseItem_run_scope_fkey"
  FOREIGN KEY ("useRunId", "representativeId") REFERENCES "MemoryUseRun"("id", "representativeId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_version_scope_fkey"
  FOREIGN KEY ("memoryVersionId", "representativeId", "memoryScope")
  REFERENCES "GovernedMemoryVersion"("id", "representativeId", "scope")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_projection_scope_fkey"
  FOREIGN KEY ("projectionItemId", "representativeId", "memoryVersionId")
  REFERENCES "MemoryProjectionItem"("id", "representativeId", "memoryVersionId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_knowledge_binding_fkey"
  FOREIGN KEY ("knowledgeBindingId", "representativeId")
  REFERENCES "KnowledgeAssetRepresentative"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_rep_version_fkey"
  FOREIGN KEY ("representativeVersionId", "representativeId")
  REFERENCES "RepresentativeVersion"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryUseItem_citation_fkey"
  FOREIGN KEY ("displayedCitationId") REFERENCES "MessageCitation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryDeletionProof"
  ADD CONSTRAINT "MemoryDeletionProof_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryDeletionProof_memory_scope_fkey"
  FOREIGN KEY ("memoryId", "representativeId") REFERENCES "GovernedMemory"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MemoryReconciliationRun"
  ADD CONSTRAINT "MemoryReconciliationRun_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryReconciliationItem"
  ADD CONSTRAINT "MemoryReconciliationItem_run_scope_fkey"
  FOREIGN KEY ("reconciliationRunId", "representativeId")
  REFERENCES "MemoryReconciliationRun"("id", "representativeId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryReconciliationItem_rep_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MemoryReconciliationItem_projection_scope_fkey"
  FOREIGN KEY ("projectionItemId", "representativeId")
  REFERENCES "MemoryProjectionItem"("id", "representativeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Channel provenance is stored as a legacy string on Conversation. New memory
-- writes fail closed unless that value maps exactly to WEB/MATRIX/TELEGRAM.
CREATE FUNCTION "memory_assert_channel_match"(
  conversation_id TEXT,
  expected_channel "RepresentativeChannelKind",
  constraint_name TEXT
) RETURNS VOID AS $$
DECLARE
  observed_channel TEXT;
BEGIN
  SELECT upper(btrim("sourceChannel"))
    INTO observed_channel
    FROM "Conversation"
   WHERE "id" = conversation_id;

  IF observed_channel IS NULL OR observed_channel <> expected_channel::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = constraint_name,
      MESSAGE = 'memory channel provenance mismatch';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "memory_candidate_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_locked BOOLEAN;
  controlled_purge BOOLEAN;
BEGIN
  PERFORM "memory_assert_channel_match"(
    NEW."sourceConversationId",
    NEW."originChannel",
    'MemoryCandidate_origin_channel_check'
  );

  IF TG_OP = 'UPDATE' THEN
    IF OLD."contentPurgedAt" IS NOT NULL
       AND (
         NEW."contentPurgedAt" IS DISTINCT FROM OLD."contentPurgedAt"
         OR NEW."safeText" IS NOT NULL
         OR NEW."summary" IS NOT NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_purge_irreversible_check',
        MESSAGE = 'purged candidate content cannot be restored or rewritten';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
         (OLD."status" = 'EXTRACTED' AND NEW."status" IN ('QUARANTINED', 'BLOCKED', 'PENDING_REVIEW'))
         OR (OLD."status" = 'PENDING_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED', 'BLOCKED', 'EXPIRED'))
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_state_transition_check',
        MESSAGE = 'invalid memory candidate state transition';
    END IF;

    IF OLD."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
       AND NEW."status" IN ('APPROVED', 'REJECTED', 'BLOCKED')
       AND NOT EXISTS (
         SELECT 1
           FROM "MemoryReviewDecision"
          WHERE "candidateId" = OLD."id"
            AND "representativeId" = OLD."representativeId"
            AND "outcome"::TEXT = NEW."status"::TEXT
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_terminal_decision_check',
        MESSAGE = 'candidate cannot enter a reviewed terminal state without its append-only decision';
    END IF;

    IF OLD."status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
       AND NEW."status" = 'APPROVED'::"MemoryCandidateStatus"
       AND (NEW."reviewedAt" IS NULL OR NEW."contentPurgedAt" IS NOT NULL
         OR NEW."safeText" IS NULL OR NEW."summary" IS NULL OR NEW."contentHash" IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_approval_integrity_check',
        MESSAGE = 'approved candidate must retain its complete reviewed sanitized payload';
    END IF;

    candidate_locked :=
      OLD."status" IN ('BLOCKED', 'APPROVED', 'REJECTED', 'EXPIRED')
      OR EXISTS (
        SELECT 1 FROM "GovernedMemoryVersion"
         WHERE "sourceCandidateId" = OLD."id"
      )
      OR EXISTS (
        SELECT 1 FROM "MemoryReviewDecision"
         WHERE "candidateId" = OLD."id"
           AND "outcome" IN ('APPROVED', 'REJECTED', 'BLOCKED')
      );

    controlled_purge :=
      OLD."contentPurgedAt" IS NULL
      AND NEW."contentPurgedAt" IS NOT NULL
      AND NEW."safeText" IS NULL
      AND NEW."summary" IS NULL
      AND NEW."contentHash" IS NOT DISTINCT FROM OLD."contentHash";

    IF controlled_purge
       AND EXISTS (
         SELECT 1
           FROM "GovernedMemoryVersion" version_record
           JOIN "GovernedMemory" memory_record
             ON memory_record."id" = version_record."memoryId"
          WHERE version_record."sourceCandidateId" = OLD."id"
            AND memory_record."status" NOT IN ('DELETE_PENDING', 'DELETED')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_controlled_purge_check',
        MESSAGE = 'approved candidate content can be purged only after recall is blocked for deletion';
    END IF;

    IF candidate_locked AND (
      NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
      OR NEW."extractionRunId" IS DISTINCT FROM OLD."extractionRunId"
      OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
      OR NEW."scope" IS DISTINCT FROM OLD."scope"
      OR NEW."scopeChannel" IS DISTINCT FROM OLD."scopeChannel"
      OR NEW."originChannel" IS DISTINCT FROM OLD."originChannel"
      OR NEW."category" IS DISTINCT FROM OLD."category"
      OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
      OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
      OR NEW."sourceContactId" IS DISTINCT FROM OLD."sourceContactId"
      OR NEW."sourceConversationId" IS DISTINCT FROM OLD."sourceConversationId"
      OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
      OR NEW."safetyClass" IS DISTINCT FROM OLD."safetyClass"
      OR NEW."safetyReasonCode" IS DISTINCT FROM OLD."safetyReasonCode"
      OR NEW."extractionReasonCode" IS DISTINCT FROM OLD."extractionReasonCode"
      OR NEW."deidentifiedAt" IS DISTINCT FROM OLD."deidentifiedAt"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR (
        NOT controlled_purge
        AND (
          NEW."safeText" IS DISTINCT FROM OLD."safeText"
          OR NEW."summary" IS DISTINCT FROM OLD."summary"
          OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
          OR NEW."contentPurgedAt" IS DISTINCT FROM OLD."contentPurgedAt"
        )
      )
      OR (
        OLD."reviewedAt" IS NOT NULL
        AND NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryCandidate_locked_coordinates_check',
        MESSAGE = 'reviewed or versioned candidate provenance and content are immutable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryCandidate_guard"
  BEFORE INSERT OR UPDATE ON "MemoryCandidate"
  FOR EACH ROW EXECUTE FUNCTION "memory_candidate_guard"();

CREATE FUNCTION "memory_extraction_channel_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."sourceConversationId" IS NOT NULL THEN
    PERFORM "memory_assert_channel_match"(
      NEW."sourceConversationId",
      NEW."sourceChannel",
      'MemoryExtractionRun_source_channel_check'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryExtractionRun_channel_guard"
  BEFORE INSERT OR UPDATE ON "MemoryExtractionRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_extraction_channel_guard"();

CREATE FUNCTION "memory_use_run_channel_guard"() RETURNS TRIGGER AS $$
DECLARE
  pinned_version_status TEXT;
  active_version_id TEXT;
  generation_version_id TEXT;
  check_pinned_version BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM "MemoryUseItem" WHERE "useRunId" = OLD."id")
       AND (
         NEW."id" IS DISTINCT FROM OLD."id"
         OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
         OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
         OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
         OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
         OR NEW."representativeVersionId" IS DISTINCT FROM OLD."representativeVersionId"
         OR NEW."inputMessageId" IS DISTINCT FROM OLD."inputMessageId"
         OR NEW."generationRunId" IS DISTINCT FROM OLD."generationRunId"
         OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_locked_coordinates_check',
        MESSAGE = 'memory use run scope coordinates are immutable after item creation';
    END IF;
    IF OLD."outputMessageId" IS NOT NULL
       AND NEW."outputMessageId" IS DISTINCT FROM OLD."outputMessageId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_output_immutable_check',
        MESSAGE = 'memory use output message cannot be rebound';
    END IF;
  END IF;

  PERFORM "memory_assert_channel_match"(
    NEW."conversationId",
    NEW."sourceChannel",
    'MemoryUseRun_source_channel_check'
  );

  check_pinned_version := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    check_pinned_version :=
      NEW."representativeVersionId" IS DISTINCT FROM OLD."representativeVersionId"
      OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId";
  END IF;

  IF check_pinned_version THEN
    SELECT "status" INTO pinned_version_status
      FROM "RepresentativeVersion"
     WHERE "id" = NEW."representativeVersionId"
       AND "representativeId" = NEW."representativeId";
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
    SELECT "activeVersionId" INTO active_version_id
      FROM "Representative"
     WHERE "id" = NEW."representativeId";
    IF active_version_id IS DISTINCT FROM NEW."representativeVersionId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_active_version_check',
        MESSAGE = 'memory use run must pin the representative active published version';
    END IF;
  END IF;

  IF NEW."generationRunId" IS NOT NULL THEN
    SELECT "representativeVersionId" INTO generation_version_id
      FROM "GenerationRun"
     WHERE "id" = NEW."generationRunId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseRun_generation_fkey',
        MESSAGE = 'memory use generation run does not exist';
    END IF;
    IF generation_version_id IS DISTINCT FROM NEW."representativeVersionId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseRun_generation_version_check',
        MESSAGE = 'memory use run and generation run pinned different representative versions';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseRun_channel_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseRun"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_run_channel_guard"();

-- Candidate and governed business scopes must remain identical. The composite
-- FKs already lock representative + enum scope; this trigger closes the
-- CONTACT_CHANNEL contact/channel binding.
CREATE FUNCTION "governed_memory_version_scope_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_record "MemoryCandidate"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
BEGIN
  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'GovernedMemoryVersion_memory_scope_fkey',
      MESSAGE = 'governed memory does not exist';
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW."purgedAt" IS NULL
     AND EXISTS (
       SELECT 1
         FROM "MemoryDeletionProof"
        WHERE "memoryId" = NEW."memoryId"
          AND "localPurgeCompletedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemoryVersion_after_local_purge_check',
      MESSAGE = 'new memory content cannot be created after local purge completion';
  END IF;

  IF NEW."sourceCandidateId" IS NOT NULL THEN
    SELECT * INTO candidate_record
      FROM "MemoryCandidate"
     WHERE "id" = NEW."sourceCandidateId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'GovernedMemoryVersion_candidate_scope_fkey',
        MESSAGE = 'memory candidate does not exist';
    END IF;

    IF candidate_record."status" NOT IN ('PENDING_REVIEW', 'APPROVED')
       OR candidate_record."contentPurgedAt" IS NOT NULL
       OR candidate_record."safeText" IS NULL
       OR candidate_record."summary" IS NULL
       OR candidate_record."contentHash" IS NULL
       OR candidate_record."safeText" IS DISTINCT FROM NEW."safeText"
       OR candidate_record."summary" IS DISTINCT FROM NEW."summary"
       OR candidate_record."contentHash" IS DISTINCT FROM NEW."contentHash"
       OR candidate_record."category" IS DISTINCT FROM memory_record."category"
       OR candidate_record."scope" IS DISTINCT FROM memory_record."scope"
       OR NEW."scope" IS DISTINCT FROM memory_record."scope" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemoryVersion_candidate_content_check',
        MESSAGE = 'memory version must exactly preserve an approved unpurged candidate';
    END IF;

    IF NEW."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
       AND (
         candidate_record."contactId" IS DISTINCT FROM memory_record."contactId"
         OR candidate_record."scopeChannel" IS DISTINCT FROM memory_record."sourceChannel"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemoryVersion_contact_scope_binding_check',
        MESSAGE = 'candidate and governed contact memory scopes differ';
    END IF;

    IF NEW."scope" = 'REPRESENTATIVE'::"MemoryScope"
       AND (
         candidate_record."contactId" IS NOT NULL
         OR candidate_record."scopeChannel" IS NOT NULL
         OR memory_record."contactId" IS NOT NULL
         OR memory_record."sourceChannel" IS NOT NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemoryVersion_rep_scope_binding_check',
        MESSAGE = 'representative experience contains a contact or channel scope';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GovernedMemoryVersion_scope_guard"
  BEFORE INSERT OR UPDATE OF "sourceCandidateId", "memoryId", "representativeId", "scope"
  ON "GovernedMemoryVersion"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_version_scope_guard"();

-- Versions are immutable except for an irreversible content purge after the
-- business memory has already been recall-blocked for deletion.
CREATE FUNCTION "governed_memory_version_immutable_guard"() RETURNS TRIGGER AS $$
DECLARE
  memory_status "GovernedMemoryStatus";
BEGIN
  IF OLD."purgedAt" IS NULL
     AND NEW."purgedAt" IS NOT NULL
     AND NEW."safeText" IS NULL
     AND NEW."summary" IS NULL
     AND (to_jsonb(NEW) - ARRAY['safeText', 'summary', 'purgedAt'])
         = (to_jsonb(OLD) - ARRAY['safeText', 'summary', 'purgedAt']) THEN
    SELECT "status" INTO memory_status
      FROM "GovernedMemory"
     WHERE "id" = OLD."memoryId";

    IF memory_status IN ('DELETE_PENDING', 'DELETED') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'GovernedMemoryVersion_immutable_check',
    MESSAGE = 'governed memory versions are immutable outside controlled purge';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GovernedMemoryVersion_immutable_guard"
  BEFORE UPDATE ON "GovernedMemoryVersion"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_version_immutable_guard"();

CREATE FUNCTION "memory_review_result_guard"() RETURNS TRIGGER AS $$
DECLARE
  candidate_record "MemoryCandidate"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
BEGIN
  IF NEW."outcome" IN ('APPROVED', 'REJECTED', 'BLOCKED') THEN
    SELECT * INTO candidate_record
      FROM "MemoryCandidate"
     WHERE "id" = NEW."candidateId"
       AND "representativeId" = NEW."representativeId";
    IF NOT FOUND OR candidate_record."status" <> 'PENDING_REVIEW'::"MemoryCandidateStatus" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_status_check',
        MESSAGE = 'terminal review can be recorded only for a pending candidate';
    END IF;
  END IF;

  IF NEW."outcome" = 'APPROVED'::"MemoryReviewOutcome" THEN
    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."resultVersionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryReviewDecision_result_scope_fkey',
        MESSAGE = 'approved memory version does not exist';
    END IF;
    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = NEW."memoryId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryReviewDecision_memory_scope_fkey',
        MESSAGE = 'approved governed memory does not exist';
    END IF;
    IF version_record."sourceCandidateId" IS DISTINCT FROM NEW."candidateId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_candidate_result_check',
        MESSAGE = 'approved candidate does not own the resulting memory version';
    END IF;
    IF candidate_record."contentPurgedAt" IS NOT NULL
       OR version_record."purgedAt" IS NOT NULL
       OR candidate_record."safeText" IS DISTINCT FROM version_record."safeText"
       OR candidate_record."summary" IS DISTINCT FROM version_record."summary"
       OR candidate_record."contentHash" IS DISTINCT FROM version_record."contentHash"
       OR candidate_record."category" IS DISTINCT FROM memory_record."category"
       OR candidate_record."scope" IS DISTINCT FROM version_record."scope"
       OR candidate_record."scope" IS DISTINCT FROM memory_record."scope" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_content_integrity_check',
        MESSAGE = 'approved candidate, version, and memory content coordinates differ';
    END IF;
    IF version_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
       AND NEW."reviewerActorId" = version_record."createdByActorId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryReviewDecision_independent_review_check',
        MESSAGE = 'representative experience requires an independent reviewer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryReviewDecision_result_guard"
  BEFORE INSERT OR UPDATE ON "MemoryReviewDecision"
  FOR EACH ROW EXECUTE FUNCTION "memory_review_result_guard"();

CREATE FUNCTION "memory_review_append_only_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'MemoryReviewDecision_append_only_check',
    MESSAGE = 'memory review decisions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryReviewDecision_append_only_guard"
  BEFORE UPDATE OR DELETE ON "MemoryReviewDecision"
  FOR EACH ROW EXECUTE FUNCTION "memory_review_append_only_guard"();

CREATE FUNCTION "governed_memory_coordinates_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "GovernedMemoryVersion" WHERE "memoryId" = OLD."id"
  ) AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
    OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
    OR NEW."category" IS DISTINCT FROM OLD."category"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_locked_coordinates_check',
      MESSAGE = 'versioned memory scope coordinates are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GovernedMemory_coordinates_guard"
  BEFORE UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_coordinates_guard"();

CREATE FUNCTION "governed_memory_lifecycle_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."status" <> 'SUPPRESSED'::"GovernedMemoryStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_initial_state_check',
      MESSAGE = 'new governed memory must start suppressed';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUPPRESSED', 'SUPERSEDED', 'EXPIRED', 'ARCHIVED'))
    OR (OLD."status" = 'SUPPRESSED' AND NEW."status" IN ('ACTIVE', 'EXPIRED', 'ARCHIVED', 'DELETE_PENDING'))
    OR (OLD."status" IN ('SUPERSEDED', 'EXPIRED') AND NEW."status" IN ('ARCHIVED', 'DELETE_PENDING'))
    OR (OLD."status" = 'ARCHIVED' AND NEW."status" IN ('SUPPRESSED', 'DELETE_PENDING'))
    OR (OLD."status" = 'DELETE_PENDING' AND NEW."status" = 'DELETED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_state_transition_check',
      MESSAGE = 'invalid governed memory state transition';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."status" IN ('DELETE_PENDING', 'DELETED')
     AND (
       NEW."currentVersionId" IS DISTINCT FROM OLD."currentVersionId"
       OR NEW."recallDisabledAt" IS DISTINCT FROM OLD."recallDisabledAt"
       OR NEW."deleteRequestedAt" IS DISTINCT FROM OLD."deleteRequestedAt"
       OR (
         OLD."status" = 'DELETED'::"GovernedMemoryStatus"
         AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_deletion_coordinates_check',
      MESSAGE = 'deletion identity and recall fence are immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
     AND NEW."status" = 'DELETED'::"GovernedMemoryStatus"
     AND NOT EXISTS (
       SELECT 1
         FROM "MemoryDeletionProof"
        WHERE "memoryId" = NEW."id"
          AND "representativeId" = NEW."representativeId"
          AND "localPurgeCompletedAt" IS NOT NULL
          AND "remotePurgeCompletedAt" IS NOT NULL
          AND "proofHash" IS NOT NULL
          AND "completedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'GovernedMemory_deleted_proof_check',
      MESSAGE = 'governed memory cannot be deleted before its proof is complete';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GovernedMemory_lifecycle_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_lifecycle_guard"();

CREATE FUNCTION "governed_memory_active_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_candidate_id TEXT;
  version_purged_at TIMESTAMP(3);
BEGIN
  IF NEW."status" = 'ACTIVE'::"GovernedMemoryStatus" THEN
    SELECT "sourceCandidateId", "purgedAt"
      INTO version_candidate_id, version_purged_at
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."currentVersionId"
       AND "memoryId" = NEW."id";
    IF NOT FOUND OR version_purged_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "MemoryCandidate"
       WHERE "id" = version_candidate_id
         AND "representativeId" = NEW."representativeId"
         AND "status" = 'APPROVED'::"MemoryCandidateStatus"
         AND "contentPurgedAt" IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemory_active_version_check',
        MESSAGE = 'active memory requires its current unpurged version';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM "MemoryReviewDecision"
       WHERE "resultVersionId" = NEW."currentVersionId"
         AND "candidateId" = version_candidate_id
         AND "memoryId" = NEW."id"
         AND "representativeId" = NEW."representativeId"
         AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GovernedMemory_approved_version_check',
        MESSAGE = 'active memory requires an approved current version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GovernedMemory_active_guard"
  BEFORE INSERT OR UPDATE ON "GovernedMemory"
  FOR EACH ROW EXECUTE FUNCTION "governed_memory_active_guard"();

CREATE FUNCTION "memory_projection_coordinates_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
     OR NEW."memoryId" IS DISTINCT FROM OLD."memoryId"
     OR NEW."memoryVersionId" IS DISTINCT FROM OLD."memoryVersionId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."lane" IS DISTINCT FROM OLD."lane"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_locked_coordinates_check',
      MESSAGE = 'memory projection coordinates are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryProjectionItem_coordinates_guard"
  BEFORE UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_coordinates_guard"();

CREATE FUNCTION "memory_projection_state_guard"() RETURNS TRIGGER AS $$
DECLARE
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
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

  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DISABLED' AND NEW."status" IN ('QUEUED', 'DELETE_PENDING'))
    OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('PROJECTING', 'RETRYING', 'FAILED', 'DELETE_PENDING', 'DISABLED'))
    OR (OLD."status" = 'PROJECTING' AND NEW."status" IN ('STAGED', 'ACTIVE', 'RETRYING', 'FAILED', 'DELETE_PENDING'))
    OR (OLD."status" = 'RETRYING' AND NEW."status" IN ('PROJECTING', 'FAILED', 'DELETE_PENDING'))
    OR (OLD."status" = 'STAGED' AND NEW."status" IN ('QUEUED', 'SUPERSEDED', 'DELETE_PENDING'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUPERSEDED', 'DELETE_PENDING'))
    OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'DELETE_PENDING')
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('QUEUED', 'RETRYING', 'DELETE_PENDING'))
    OR (OLD."status" = 'DELETE_PENDING' AND NEW."status" IN ('DELETING', 'DELETE_FAILED', 'DELETED'))
    OR (OLD."status" = 'DELETING' AND NEW."status" IN ('DELETED', 'DELETE_FAILED'))
    OR (OLD."status" = 'DELETE_FAILED' AND NEW."status" IN ('DELETE_PENDING', 'DELETING', 'DELETED'))
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

CREATE TRIGGER "MemoryProjectionItem_state_guard"
  BEFORE INSERT OR UPDATE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_state_guard"();

CREATE FUNCTION "memory_projection_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'MemoryProjectionItem_tombstone_required_check',
    MESSAGE = 'memory projections are append-only and must retain a DELETED tombstone';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryProjectionItem_delete_guard"
  BEFORE DELETE ON "MemoryProjectionItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_projection_delete_guard"();

-- Use items are checked again at the business boundary. A contact memory must
-- match the question's representative, contact, and source channel. A
-- representative experience must be deidentified and have no contact/channel.
-- Injection additionally requires the current active version and active RECALL
-- projection. Public knowledge must come from an enabled, reviewed binding and
-- the published representative version pinned by the use run.
CREATE FUNCTION "memory_use_item_scope_guard"() RETURNS TRIGGER AS $$
DECLARE
  run_record "MemoryUseRun"%ROWTYPE;
  version_record "GovernedMemoryVersion"%ROWTYPE;
  memory_record "GovernedMemory"%ROWTYPE;
  projection_record "MemoryProjectionItem"%ROWTYPE;
  binding_record "KnowledgeAssetRepresentative"%ROWTYPE;
  asset_record "KnowledgeAsset"%ROWTYPE;
  representative_version_status TEXT;
  representative_version_snapshot JSONB;
  active_version_id TEXT;
  snapshot_pin_matches BOOLEAN;
  citation_message_id TEXT;
  injection_transition BOOLEAN;
BEGIN
  injection_transition := NEW."injectedAt" IS NOT NULL AND TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    injection_transition := NEW."injectedAt" IS NOT NULL AND OLD."injectedAt" IS NULL;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."useRunId" IS DISTINCT FROM OLD."useRunId"
       OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
       OR NEW."itemKey" IS DISTINCT FROM OLD."itemKey"
       OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
       OR NEW."memoryScope" IS DISTINCT FROM OLD."memoryScope"
       OR NEW."memoryVersionId" IS DISTINCT FROM OLD."memoryVersionId"
       OR NEW."projectionItemId" IS DISTINCT FROM OLD."projectionItemId"
       OR NEW."knowledgeBindingId" IS DISTINCT FROM OLD."knowledgeBindingId"
       OR NEW."representativeVersionId" IS DISTINCT FROM OLD."representativeVersionId"
       OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
       OR (OLD."displayedCitationId" IS NOT NULL AND NEW."displayedCitationId" IS DISTINCT FROM OLD."displayedCitationId")
       OR (OLD."searchedAt" IS NOT NULL AND NEW."searchedAt" IS DISTINCT FROM OLD."searchedAt")
       OR (OLD."scopeCheckedAt" IS NOT NULL AND NEW."scopeCheckedAt" IS DISTINCT FROM OLD."scopeCheckedAt")
       OR (OLD."scopePassedAt" IS NOT NULL AND NEW."scopePassedAt" IS DISTINCT FROM OLD."scopePassedAt")
       OR (OLD."safetyCheckedAt" IS NOT NULL AND NEW."safetyCheckedAt" IS DISTINCT FROM OLD."safetyCheckedAt")
       OR (OLD."safetyPassedAt" IS NOT NULL AND NEW."safetyPassedAt" IS DISTINCT FROM OLD."safetyPassedAt")
       OR (OLD."injectedAt" IS NOT NULL AND NEW."injectedAt" IS DISTINCT FROM OLD."injectedAt")
       OR (OLD."displayedAt" IS NOT NULL AND NEW."displayedAt" IS DISTINCT FROM OLD."displayedAt") THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_append_only_stages_check',
        MESSAGE = 'memory use source identity and completed stages are immutable';
    END IF;
  END IF;

  SELECT * INTO run_record
    FROM "MemoryUseRun"
   WHERE "id" = NEW."useRunId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'MemoryUseItem_run_scope_fkey',
      MESSAGE = 'memory use run does not exist';
  END IF;

  IF TG_OP = 'INSERT' OR injection_transition THEN
    SELECT "activeVersionId" INTO active_version_id
      FROM "Representative"
     WHERE "id" = run_record."representativeId";
    IF active_version_id IS DISTINCT FROM run_record."representativeVersionId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_active_version_check',
        MESSAGE = 'memory use item belongs to a stale representative version';
    END IF;
  END IF;

  IF NEW."sourceKind" IN ('CONTACT_MEMORY', 'REPRESENTATIVE_EXPERIENCE') THEN
    SELECT * INTO version_record
      FROM "GovernedMemoryVersion"
     WHERE "id" = NEW."memoryVersionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_version_scope_fkey',
        MESSAGE = 'memory use version does not exist';
    END IF;

    SELECT * INTO memory_record
      FROM "GovernedMemory"
     WHERE "id" = version_record."memoryId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'GovernedMemoryVersion_memory_scope_fkey',
        MESSAGE = 'memory use business memory does not exist';
    END IF;

    SELECT * INTO projection_record
      FROM "MemoryProjectionItem"
     WHERE "id" = NEW."projectionItemId";
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

    IF injection_transition
       AND (
         memory_record."status" <> 'ACTIVE'::"GovernedMemoryStatus"
         OR memory_record."recallDisabledAt" IS NOT NULL
         OR memory_record."currentVersionId" IS DISTINCT FROM version_record."id"
         OR version_record."purgedAt" IS NOT NULL
         OR (memory_record."expiresAt" IS NOT NULL AND memory_record."expiresAt" <= NEW."injectedAt")
         OR projection_record."status" <> 'ACTIVE'::"MemoryProjectionStatus"
         OR projection_record."lane" <> 'RECALL'::"MemoryProjectionLane"
         OR projection_record."contentHash" <> version_record."contentHash"
         OR NOT EXISTS (
           SELECT 1 FROM "MemoryCandidate"
            WHERE "id" = version_record."sourceCandidateId"
              AND "representativeId" = run_record."representativeId"
              AND "status" = 'APPROVED'::"MemoryCandidateStatus"
              AND "contentPurgedAt" IS NULL
         )
         OR NOT EXISTS (
           SELECT 1
             FROM "MemoryReviewDecision"
            WHERE "resultVersionId" = version_record."id"
              AND "candidateId" = version_record."sourceCandidateId"
              AND "memoryId" = memory_record."id"
              AND "representativeId" = run_record."representativeId"
              AND "outcome" = 'APPROVED'::"MemoryReviewOutcome"
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_injection_allowlist_check',
        MESSAGE = 'memory was not active, current, and recall-projected at injection';
    END IF;
  ELSE
    SELECT * INTO binding_record
      FROM "KnowledgeAssetRepresentative"
     WHERE "id" = NEW."knowledgeBindingId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_knowledge_binding_fkey',
        MESSAGE = 'memory use knowledge binding does not exist';
    END IF;
    SELECT "status", "snapshot"::JSONB
      INTO representative_version_status, representative_version_snapshot
      FROM "RepresentativeVersion"
     WHERE "id" = NEW."representativeVersionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_rep_version_fkey',
        MESSAGE = 'memory use representative version does not exist';
    END IF;

    SELECT * INTO asset_record
      FROM "KnowledgeAsset"
     WHERE "id" = binding_record."assetId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_knowledge_asset_fkey',
        MESSAGE = 'memory use knowledge asset does not exist';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
          COALESCE(representative_version_snapshot -> 'knowledgeAssets', '[]'::JSONB)
        ) AS pin
       WHERE pin ->> 'assetId' = binding_record."assetId"
         AND pin ->> 'checksum' = asset_record."checksum"
         AND (pin ->> 'processingVersion') ~ '^[0-9]+$'
         AND (pin ->> 'processingVersion')::INTEGER = asset_record."processingVersion"
    ) INTO snapshot_pin_matches;

    IF binding_record."representativeId" <> run_record."representativeId"
       OR NEW."representativeVersionId" IS DISTINCT FROM run_record."representativeVersionId"
       OR representative_version_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_published_knowledge_check',
        MESSAGE = 'public knowledge was not bound to the use run published representative version';
    END IF;

    IF asset_record."status" <> 'READY'::"KnowledgeAssetStatus"
       OR asset_record."archivedAt" IS NOT NULL
       OR asset_record."checksum" IS NULL
       OR NEW."contentHash" IS DISTINCT FROM asset_record."checksum"
       OR snapshot_pin_matches IS NOT TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_knowledge_snapshot_check',
        MESSAGE = 'public knowledge is not ready and byte-pinned by the active published snapshot';
    END IF;

    IF injection_transition
       AND (
         binding_record."enabled" IS NOT TRUE
         OR binding_record."reviewStatus" <> 'APPROVED'::"KnowledgeAssetReviewStatus"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_knowledge_injection_check',
        MESSAGE = 'public knowledge binding was not enabled and approved at injection';
    END IF;
  END IF;

  IF NEW."displayedAt" IS NOT NULL THEN
    SELECT "messageId" INTO citation_message_id
      FROM "MessageCitation"
     WHERE "id" = NEW."displayedCitationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'MemoryUseItem_citation_fkey',
        MESSAGE = 'displayed citation does not exist';
    END IF;
    IF run_record."outputMessageId" IS NULL
       OR citation_message_id IS DISTINCT FROM run_record."outputMessageId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_displayed_source_check',
        MESSAGE = 'displayed source is not attached to the run output message';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryUseItem_scope_guard"
  BEFORE INSERT OR UPDATE ON "MemoryUseItem"
  FOR EACH ROW EXECUTE FUNCTION "memory_use_item_scope_guard"();

CREATE FUNCTION "memory_deletion_proof_guard"() RETURNS TRIGGER AS $$
DECLARE
  memory_record "GovernedMemory"%ROWTYPE;
  local_purge_transition BOOLEAN;
  remote_purge_transition BOOLEAN;
  completed_transition BOOLEAN;
BEGIN
  local_purge_transition := NEW."localPurgeCompletedAt" IS NOT NULL AND TG_OP = 'INSERT';
  remote_purge_transition := NEW."remotePurgeCompletedAt" IS NOT NULL AND TG_OP = 'INSERT';
  completed_transition := NEW."completedAt" IS NOT NULL AND TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."representativeId" IS DISTINCT FROM OLD."representativeId"
       OR NEW."memoryId" IS DISTINCT FROM OLD."memoryId"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."requestedByActorId" IS DISTINCT FROM OLD."requestedByActorId"
       OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
       OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
       OR NEW."recallBlockedAt" IS DISTINCT FROM OLD."recallBlockedAt"
       OR (OLD."localPurgeCompletedAt" IS NOT NULL AND NEW."localPurgeCompletedAt" IS DISTINCT FROM OLD."localPurgeCompletedAt")
       OR (OLD."remotePurgeCompletedAt" IS NOT NULL AND NEW."remotePurgeCompletedAt" IS DISTINCT FROM OLD."remotePurgeCompletedAt")
       OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
       OR (OLD."providerReceiptHash" IS NOT NULL AND NEW."providerReceiptHash" IS DISTINCT FROM OLD."providerReceiptHash")
       OR (OLD."proofHash" IS NOT NULL AND NEW."proofHash" IS DISTINCT FROM OLD."proofHash")
       OR (OLD."completedAt" IS NOT NULL AND to_jsonb(NEW) - 'updatedAt' <> to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_irreversible_check',
        MESSAGE = 'memory deletion proof identity and completed stages are immutable';
    END IF;
    local_purge_transition :=
      NEW."localPurgeCompletedAt" IS NOT NULL
      AND OLD."localPurgeCompletedAt" IS NULL;
    remote_purge_transition :=
      NEW."remotePurgeCompletedAt" IS NOT NULL
      AND OLD."remotePurgeCompletedAt" IS NULL;
    completed_transition :=
      NEW."completedAt" IS NOT NULL
      AND OLD."completedAt" IS NULL;
  END IF;

  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId"
     AND "representativeId" = NEW."representativeId";
  IF NOT FOUND OR memory_record."status" <> 'DELETE_PENDING'::"GovernedMemoryStatus" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_memory_blocked_check',
      MESSAGE = 'deletion proof changes require a recall-blocked pending memory';
  END IF;

  IF TG_OP = 'INSERT' AND (
    memory_record."recallDisabledAt" IS NULL
    OR memory_record."recallDisabledAt" > NEW."recallBlockedAt"
    OR NOT EXISTS (
      SELECT 1 FROM "GovernedMemoryVersion"
       WHERE "id" = memory_record."currentVersionId"
         AND "memoryId" = memory_record."id"
         AND "contentHash" = NEW."contentHash"
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_identity_check',
      MESSAGE = 'deletion proof must identify the blocked current memory content';
  END IF;

  IF local_purge_transition OR completed_transition THEN
    IF EXISTS (
      SELECT 1
        FROM "GovernedMemoryVersion" version_record
        LEFT JOIN "MemoryCandidate" candidate_record
          ON candidate_record."id" = version_record."sourceCandidateId"
       WHERE version_record."memoryId" = NEW."memoryId"
         AND (
           version_record."purgedAt" IS NULL
           OR version_record."safeText" IS NOT NULL
           OR version_record."summary" IS NOT NULL
           OR (
             candidate_record."id" IS NOT NULL
             AND (
               candidate_record."contentPurgedAt" IS NULL
               OR candidate_record."safeText" IS NOT NULL
               OR candidate_record."summary" IS NOT NULL
             )
           )
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_content_purged_check',
        MESSAGE = 'local purge cannot complete while memory content remains';
    END IF;
  END IF;

  IF remote_purge_transition OR completed_transition THEN
    IF EXISTS (
      SELECT 1 FROM "MemoryProjectionItem"
       WHERE "memoryId" = NEW."memoryId"
         AND "status" <> 'DELETED'::"MemoryProjectionStatus"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryDeletionProof_remote_purged_check',
        MESSAGE = 'remote purge cannot complete while a projection remains';
    END IF;
  END IF;

  IF completed_transition AND (
    NEW."localPurgeCompletedAt" IS NULL
    OR NEW."remotePurgeCompletedAt" IS NULL
    OR NEW."proofHash" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryDeletionProof_completion_check',
      MESSAGE = 'completed deletion proof requires local and remote purge evidence';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryDeletionProof_guard"
  BEFORE INSERT OR UPDATE ON "MemoryDeletionProof"
  FOR EACH ROW EXECUTE FUNCTION "memory_deletion_proof_guard"();

CREATE FUNCTION "memory_deletion_proof_delete_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'MemoryDeletionProof_append_only_check',
    MESSAGE = 'memory deletion proofs are append-only and cannot be removed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MemoryDeletionProof_delete_guard"
  BEFORE DELETE ON "MemoryDeletionProof"
  FOR EACH ROW EXECUTE FUNCTION "memory_deletion_proof_delete_guard"();

COMMIT;
