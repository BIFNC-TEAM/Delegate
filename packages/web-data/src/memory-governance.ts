import { createHash } from "node:crypto";

import {
  GovernedMemoryStatus,
  MemoryCandidateStatus,
  MemoryCategory,
  MemoryCleanupStatus,
  MemoryExtractionStatus,
  MemoryProjectionLane,
  MemoryProjectionStatus,
  MemoryPolicyDecisionOutcome,
  MemorySafetyClass,
  MemoryScope,
  MemorySourceKind,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";
import {
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceVersionUri,
  buildGovernedSharedContactMemoryVersionUri,
} from "@delegate/openviking";

import {
  classifyMemoryCandidate,
  resolveContactMemorySharingEligibility,
} from "./memory-extraction";
import {
  lockAndResolveExactMessageIdentityEvidence,
  type ExactMessageIdentityEvidence,
} from "./contact-memory-source-evidence";
import {
  contactChannelMemoryForgetCutoffReasonCode,
  isContactChannelMemorySourceAfterForgetBoundary,
  loadLatestContactChannelMemoryForgetBoundary,
  lockContactChannelMemoryCoordinate,
} from "./memory-forget-boundary";

type MemoryGovernanceTransaction = Prisma.TransactionClient;

const automaticMemoryPolicyVersion = "automatic-memory-policy-v1";
const automaticMemoryExtractorVersion = "closed-structured-v2";
const contactSharedDeidentificationMethod =
  "closed-structured-contact-shared-v1";

export type AutomaticMemoryPolicyInput = {
  candidateId: string;
  sourceHash: string;
  confidence?: number;
  policyVersion?: string;
  extractorVersion?: string;
  sharedSourceEvidence?: ExactMessageIdentityEvidence;
};

export type AutomaticMemoryPolicyResult = {
  candidateId: string;
  outcome: MemoryPolicyDecisionOutcome;
  memoryId: string | null;
  memoryVersionId: string | null;
  replayed: boolean;
};

export type MemoryGovernanceErrorCode =
  | "memory_invalid_input"
  | "memory_not_found"
  | "memory_state_conflict"
  | "memory_candidate_not_ready"
  | "memory_safety_rejected";

export class MemoryGovernanceError extends Error {
  constructor(
    readonly code: MemoryGovernanceErrorCode,
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "MemoryGovernanceError";
  }
}

const maximumTextIdentifierLength = 191;
const memoryProjectionContractVersion = "v1";
const contactReplyPreferenceSemanticKey = "contact-preference:communication";
const contactReplyPreferenceForgetReasonCode =
  "contact_forget_reply_preference";
const contactChannelMemoryForgetReasonCode =
  "contact_forget_all_channel_memory";
const contactChannelMemoryForgetCommands = new Set([
  "/delete_memory",
  "/forget",
  "delete my memory",
  "forget my memory",
  "删除我的记忆",
]);
const automaticMemoryPolicySelect = {
  provider: true,
  namespaceKey: true,
  revision: true,
  longTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: true,
  representativeExperienceEnabled: true,
  webRecallEnabled: true,
  matrixRecallEnabled: true,
  telegramRecallEnabled: true,
} as const;

/**
 * Applies the server-owned automatic policy inside the extraction transaction.
 * Historical human review rows remain audit-only. Every active memory is
 * authorized exclusively by an immutable MemoryPolicyDecision.
 */
export async function applyAutomaticMemoryPolicyInTransaction(
  tx: MemoryGovernanceTransaction,
  input: AutomaticMemoryPolicyInput,
  occurredAt = new Date(),
): Promise<AutomaticMemoryPolicyResult> {
  const candidateId = requiredText(input.candidateId, "candidateId");
  const sourceHash = requiredSha256(input.sourceHash, "sourceHash");
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1.");
  }
  const policyVersion = requiredPolicyToken(
    input.policyVersion ?? automaticMemoryPolicyVersion,
    "policyVersion",
  );
  const extractorVersion = requiredPolicyToken(
    input.extractorVersion ?? automaticMemoryExtractorVersion,
    "extractorVersion",
  );

  await lockCandidate(tx, candidateId, null);
  const candidate = await tx.memoryCandidate.findUnique({
    where: { id: candidateId },
    include: sourceCandidateInclude,
  });
  if (!candidate) throw notFound();

  const replay = await tx.memoryPolicyDecision.findUnique({
    where: { candidateId: candidate.id },
    select: {
      outcome: true,
      memoryId: true,
      resultVersionId: true,
    },
  });
  if (replay) {
    return {
      candidateId: candidate.id,
      outcome: replay.outcome,
      memoryId: replay.memoryId,
      memoryVersionId: replay.resultVersionId,
      replayed: true,
    };
  }

  assertAutomaticCandidateReady(candidate, occurredAt);
  assertFreshAutomaticSafety(candidate);
  if (!candidate.semanticKey) {
    throw stateConflict("Automatic memory candidate has no semantic key.");
  }

  let policy = await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: candidate.representativeId },
    select: automaticMemoryPolicySelect,
  });
  let sharedSourceEvidence: ExactMessageIdentityEvidence | null = null;
  if (candidate.scope === MemoryScope.CONTACT_SHARED) {
    if (!candidate.audienceIdentityId) {
      return finishAutomaticCandidateWithoutActivation(tx, {
        candidate,
        occurredAt,
        sourceHash,
        outputHash: candidate.contentHash,
        confidence,
        policyRevision: policy?.revision ?? 0,
        policyVersion,
        extractorVersion,
        outcome: MemoryPolicyDecisionOutcome.SKIPPED,
        reasonCode: "automatic_shared_identity_missing",
      });
    }
    sharedSourceEvidence =
      await lockAndResolveExactMessageIdentityEvidence(tx, {
        representativeId: candidate.representativeId,
        contactId: candidate.sourceContactId,
        conversationId: candidate.sourceConversationId,
        messageId: candidate.sourceMessageId,
        sourceChannel: candidate.originChannel,
      });
    if (
      !sharedSourceEvidence
      || sharedSourceEvidence.canonicalAudienceIdentityId
        !== candidate.audienceIdentityId
      || (
        input.sharedSourceEvidence
        && (
          input.sharedSourceEvidence.identityLinkId
            !== sharedSourceEvidence.identityLinkId
          || input.sharedSourceEvidence.identityConnectionProofId
            !== sharedSourceEvidence.identityConnectionProofId
        )
      )
    ) {
      return finishAutomaticCandidateWithoutActivation(tx, {
        candidate,
        occurredAt,
        sourceHash,
        outputHash: candidate.contentHash,
        confidence,
        policyRevision: policy?.revision ?? 0,
        policyVersion,
        extractorVersion,
        outcome: MemoryPolicyDecisionOutcome.SKIPPED,
        reasonCode: "automatic_shared_source_evidence_invalid",
      });
    }
    await lockContactSharedMemoryCoordinate(tx, {
      representativeId: candidate.representativeId,
      audienceIdentityId: candidate.audienceIdentityId,
    });
    policy = await tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: candidate.representativeId },
      select: automaticMemoryPolicySelect,
    });
  }
  await lockContactChannelMemoryCoordinate(tx, {
    representativeId: candidate.representativeId,
    contactId: candidate.sourceContactId,
    sourceChannel: candidate.originChannel,
  });
  const forgetBoundary = await loadLatestContactChannelMemoryForgetBoundary(
    tx,
    {
      representativeId: candidate.representativeId,
      contactId: candidate.sourceContactId,
      sourceChannel: candidate.originChannel,
    },
  );
  if (!isContactChannelMemorySourceAfterForgetBoundary(forgetBoundary, {
    contactChannelMemoryEpoch:
      candidate.extractionRun?.contactChannelMemoryEpoch ?? 0,
    memoryIngressOrdinal: candidate.sourceMessage.memoryIngressOrdinal,
  })) {
    return finishAutomaticCandidateWithoutActivation(tx, {
      candidate,
      occurredAt,
      sourceHash,
      outputHash: candidate.contentHash,
      confidence,
      policyRevision: policy?.revision ?? 0,
      policyVersion,
      extractorVersion,
      outcome: MemoryPolicyDecisionOutcome.SKIPPED,
      reasonCode: contactChannelMemoryForgetCutoffReasonCode,
    });
  }
  if (candidate.scope === MemoryScope.CONTACT_SHARED) {
    const sharingEligibility = await resolveContactMemorySharingEligibility(
      tx,
      {
        representativeId: candidate.representativeId,
        contactId: candidate.sourceContactId,
        sourceChannel: candidate.originChannel,
        policy: policy
          ? {
              contactMemoryCrossChannelEnabled:
                policy.contactMemoryCrossChannelEnabled,
              revision: policy.revision,
            }
          : null,
        sourceEvidence: sharedSourceEvidence,
      },
    );
    if (
      !sharingEligibility.eligible
      || sharingEligibility.audienceIdentityId
        !== candidate.audienceIdentityId
    ) {
      return finishAutomaticCandidateWithoutActivation(tx, {
        candidate,
        occurredAt,
        sourceHash,
        outputHash: candidate.contentHash,
        confidence,
        policyRevision: policy?.revision ?? 0,
        policyVersion,
        extractorVersion,
        outcome: MemoryPolicyDecisionOutcome.SKIPPED,
        reasonCode: sharingEligibility.eligible
          ? "automatic_shared_identity_changed"
          : `automatic_${sharingEligibility.reasonCode}`,
      });
    }
  }
  if (!policy || !policyAllowsCandidate(policy, candidate)) {
    return finishAutomaticCandidateWithoutActivation(tx, {
      candidate,
      occurredAt,
      sourceHash,
      outputHash: candidate.contentHash,
      confidence,
      policyRevision: policy?.revision ?? 0,
      policyVersion,
      extractorVersion,
      outcome: MemoryPolicyDecisionOutcome.SKIPPED,
      reasonCode: "automatic_policy_disabled",
    });
  }
  let memory = await tx.governedMemory.findFirst({
    where: automaticMemoryCoordinates(candidate),
    include: {
      currentVersion: {
        select: { id: true, versionNumber: true, contentHash: true },
      },
    },
  });
  if (memory) {
    await lockMemory(tx, memory.id, candidate.representativeId);
    memory = await tx.governedMemory.findFirst({
      where: {
        id: memory.id,
        representativeId: candidate.representativeId,
      },
      include: {
        currentVersion: {
          select: { id: true, versionNumber: true, contentHash: true },
        },
      },
    });
  }

  if (
    memory?.status === GovernedMemoryStatus.ACTIVE
    && memory.currentVersion?.contentHash === candidate.contentHash
  ) {
    const decision = await createAutomaticPolicyDecision(tx, {
      candidate,
      memoryId: memory.id,
      resultVersionId: memory.currentVersion.id,
      outcome: MemoryPolicyDecisionOutcome.UNCHANGED,
      policyRevision: policy.revision,
      policyVersion,
      extractorVersion,
      sourceHash,
      outputHash: candidate.contentHash,
      confidence,
      reasonCode: "automatic_duplicate_confirmation",
    });
    await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status: MemoryCandidateStatus.APPROVED,
        reviewedAt: occurredAt,
      },
    });
    return {
      candidateId: candidate.id,
      outcome: decision.outcome,
      memoryId: memory.id,
      memoryVersionId: memory.currentVersion.id,
      replayed: false,
    };
  }

  if (
    memory
    && !new Set<GovernedMemoryStatus>([
      GovernedMemoryStatus.ACTIVE,
      GovernedMemoryStatus.SUPPRESSED,
    ]).has(memory.status)
  ) {
    return finishAutomaticCandidateWithoutActivation(tx, {
      candidate,
      occurredAt,
      sourceHash,
      outputHash: candidate.contentHash,
      confidence,
      policyRevision: policy.revision,
      policyVersion,
      extractorVersion,
      outcome: MemoryPolicyDecisionOutcome.SKIPPED,
      reasonCode: "automatic_memory_tombstone_present",
    });
  }

  const supersedesVersionId = memory?.currentVersion?.id ?? null;
  const versionNumber = (memory?.currentVersion?.versionNumber ?? 0) + 1;
  if (!memory) {
    memory = await tx.governedMemory.create({
      data: {
        representativeId: candidate.representativeId,
        contactId: candidate.contactId,
        audienceIdentityId: candidate.audienceIdentityId,
        scope: candidate.scope,
        sourceChannel: candidate.scopeChannel,
        category: candidate.category,
        semanticKey: candidate.semanticKey,
        status: GovernedMemoryStatus.SUPPRESSED,
        expiresAt: candidate.expiresAt,
        recallDisabledAt: occurredAt,
        suppressedAt: occurredAt,
      },
      include: {
        currentVersion: {
          select: { id: true, versionNumber: true, contentHash: true },
        },
      },
    });
  }

  const version = await tx.governedMemoryVersion.create({
    data: {
      memoryId: memory.id,
      representativeId: candidate.representativeId,
      scope: candidate.scope,
      sourceCandidateId: candidate.id,
      supersedesVersionId,
      versionNumber,
      safeText: candidate.safeText,
      summary: candidate.summary,
      contentHash: candidate.contentHash!,
      deidentifiedAt: candidate.deidentifiedAt,
      deidentificationMethod:
        candidate.scope === MemoryScope.REPRESENTATIVE
          ? "closed-pattern-v2"
          : candidate.scope === MemoryScope.CONTACT_SHARED
            ? contactSharedDeidentificationMethod
            : null,
      correctionReasonCode:
        supersedesVersionId === null ? null : "automatic_policy_update",
      createdByActorId: `system:memory-policy:${candidate.id}`,
    },
  });
  const outcome = supersedesVersionId
    ? MemoryPolicyDecisionOutcome.UPDATED
    : MemoryPolicyDecisionOutcome.ACTIVATED;
  const decision = await createAutomaticPolicyDecision(tx, {
    candidate,
    memoryId: memory.id,
    resultVersionId: version.id,
    outcome,
    policyRevision: policy.revision,
    policyVersion,
    extractorVersion,
    sourceHash,
    outputHash: version.contentHash,
    confidence,
    reasonCode: supersedesVersionId
      ? "automatic_semantic_update"
      : "automatic_low_risk_activation",
  });
  await tx.memoryCandidate.update({
    where: { id: candidate.id },
    data: {
      status: MemoryCandidateStatus.APPROVED,
      reviewedAt: occurredAt,
    },
  });

  if (supersedesVersionId) {
    await supersedePriorProjection(
      tx,
      memory.id,
      supersedesVersionId,
      occurredAt,
    );
  }
  await tx.governedMemory.update({
    where: { id: memory.id },
    data: {
      status: GovernedMemoryStatus.ACTIVE,
      currentVersionId: version.id,
      recallDisabledAt: null,
      suppressedAt: null,
      expiresAt: candidate.expiresAt ?? memory.expiresAt,
    },
  });
  await tx.memoryProjectionItem.create({
    data: {
      representativeId: candidate.representativeId,
      memoryId: memory.id,
      memoryVersionId: version.id,
      provider: policy.provider,
      lane: MemoryProjectionLane.RECALL,
      status: MemoryProjectionStatus.QUEUED,
      contentHash: version.contentHash,
      remoteUri: buildCanonicalMemoryProjectionUri({
        namespaceKey: policy.namespaceKey,
        candidate,
        memoryId: memory.id,
        memoryVersionId: version.id,
      }),
      idempotencyKey: projectionIdempotencyKey(
        policy.provider,
        version.id,
        version.contentHash,
      ),
    },
  });
  return {
    candidateId: candidate.id,
    outcome: decision.outcome,
    memoryId: memory.id,
    memoryVersionId: version.id,
    replayed: false,
  };
}

export async function recordAutomaticMarkerPolicyDecisionInTransaction(
  tx: MemoryGovernanceTransaction,
  input: AutomaticMemoryPolicyInput,
): Promise<AutomaticMemoryPolicyResult> {
  const candidate = await tx.memoryCandidate.findUnique({
    where: { id: requiredText(input.candidateId, "candidateId") },
  });
  if (!candidate) throw notFound();
  const existing = await tx.memoryPolicyDecision.findUnique({
    where: { candidateId: candidate.id },
  });
  if (existing) {
    return {
      candidateId: candidate.id,
      outcome: existing.outcome,
      memoryId: existing.memoryId,
      memoryVersionId: existing.resultVersionId,
      replayed: true,
    };
  }
  const policy = await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: candidate.representativeId },
    select: { revision: true },
  });
  const outcome = candidate.status === MemoryCandidateStatus.BLOCKED
    ? MemoryPolicyDecisionOutcome.BLOCKED
    : MemoryPolicyDecisionOutcome.QUARANTINED;
  const decision = await createAutomaticPolicyDecision(tx, {
    candidate,
    memoryId: null,
    resultVersionId: null,
    outcome,
    policyRevision: policy?.revision ?? 0,
    policyVersion: requiredPolicyToken(
      input.policyVersion ?? automaticMemoryPolicyVersion,
      "policyVersion",
    ),
    extractorVersion: requiredPolicyToken(
      input.extractorVersion ?? automaticMemoryExtractorVersion,
      "extractorVersion",
    ),
    sourceHash: requiredSha256(input.sourceHash, "sourceHash"),
    outputHash: null,
    confidence: input.confidence ?? 1,
    reasonCode: candidate.safetyReasonCode ?? "automatic_safety_fail_closed",
  });
  return {
    candidateId: candidate.id,
    outcome: decision.outcome,
    memoryId: null,
    memoryVersionId: null,
    replayed: false,
  };
}

export async function recordRepresentativeEvidencePolicyDecisionInTransaction(
  tx: MemoryGovernanceTransaction,
  input: AutomaticMemoryPolicyInput,
): Promise<AutomaticMemoryPolicyResult> {
  const candidateId = requiredText(input.candidateId, "candidateId");
  await lockCandidate(tx, candidateId, null);
  const candidate = await tx.memoryCandidate.findUnique({
    where: { id: candidateId },
    include: sourceCandidateInclude,
  });
  if (!candidate) throw notFound();
  const existing = await tx.memoryPolicyDecision.findUnique({
    where: { candidateId: candidate.id },
  });
  if (existing) {
    return {
      candidateId: candidate.id,
      outcome: existing.outcome,
      memoryId: existing.memoryId,
      memoryVersionId: existing.resultVersionId,
      replayed: true,
    };
  }
  if (
    candidate.status !== MemoryCandidateStatus.EXTRACTED
    || candidate.scope !== MemoryScope.REPRESENTATIVE
    || candidate.safetyClass !== MemorySafetyClass.LOW_RISK
    || !candidate.deidentifiedAt
    || !candidate.semanticKey
    || !candidate.contentHash
  ) {
    throw stateConflict("Representative evidence is not a low-risk deidentified pattern.");
  }
  assertFreshAutomaticSafety(candidate);
  const policy = await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: candidate.representativeId },
    select: { revision: true },
  });
  const decision = await createAutomaticPolicyDecision(tx, {
    candidate,
    memoryId: null,
    resultVersionId: null,
    outcome: MemoryPolicyDecisionOutcome.EVIDENCE_RECORDED,
    policyRevision: policy?.revision ?? 0,
    policyVersion: requiredPolicyToken(
      input.policyVersion ?? automaticMemoryPolicyVersion,
      "policyVersion",
    ),
    extractorVersion: requiredPolicyToken(
      input.extractorVersion ?? automaticMemoryExtractorVersion,
      "extractorVersion",
    ),
    sourceHash: requiredSha256(input.sourceHash, "sourceHash"),
    outputHash: candidate.contentHash,
    confidence: input.confidence ?? 1,
    reasonCode: "representative_pattern_evidence_recorded",
  });
  return {
    candidateId: candidate.id,
    outcome: decision.outcome,
    memoryId: null,
    memoryVersionId: null,
    replayed: false,
  };
}

/**
 * Fences every shared Contact Memory for one canonical identity immediately,
 * then queues idempotent provider cleanup. The caller supplies only the
 * representative + canonical identity scope, never a memory ID or URI.
 */
export async function requestAutomaticContactSharedMemoryDeletionInTransaction(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    audienceIdentityId: string;
    requestId: string;
    requestedByActorId: string;
    reasonCode: string;
    occurredAt: Date;
  },
): Promise<{
  matchedCount: number;
  queuedCount: number;
  replayedCount: number;
  memoryIds: string[];
}> {
  const representativeId = requiredText(
    input.representativeId,
    "representativeId",
  );
  const audienceIdentityId = requiredText(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const requestId = requiredText(input.requestId, "requestId");
  const requestedByActorId = requiredText(
    input.requestedByActorId,
    "requestedByActorId",
  );
  const reasonCode = requiredPolicyToken(input.reasonCode, "reasonCode");
  if (
    !(input.occurredAt instanceof Date)
    || Number.isNaN(input.occurredAt.getTime())
  ) {
    throw invalidInput("occurredAt must be a valid date.");
  }

  await lockContactSharedMemoryCoordinate(tx, {
    representativeId,
    audienceIdentityId,
  });
  await tx.memoryCandidate.updateMany({
    where: {
      representativeId,
      audienceIdentityId,
      scope: MemoryScope.CONTACT_SHARED,
      status: MemoryCandidateStatus.PENDING_REVIEW,
    },
    data: {
      status: MemoryCandidateStatus.EXPIRED,
      safeText: null,
      summary: null,
      contentPurgedAt: input.occurredAt,
      reviewedAt: input.occurredAt,
    },
  });
  const matches = await tx.governedMemory.findMany({
    where: {
      representativeId,
      audienceIdentityId,
      scope: MemoryScope.CONTACT_SHARED,
      status: { not: GovernedMemoryStatus.DELETED },
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const memoryIds: string[] = [];
  let queuedCount = 0;
  let replayedCount = 0;

  for (const match of matches) {
    await lockMemory(tx, match.id, representativeId);
    let memory = await tx.governedMemory.findFirst({
      where: {
        id: match.id,
        representativeId,
        audienceIdentityId,
        scope: MemoryScope.CONTACT_SHARED,
      },
      include: {
        currentVersion: { select: { id: true, contentHash: true } },
        deletionProof: { select: { id: true } },
      },
    });
    if (!memory || memory.status === GovernedMemoryStatus.DELETED) continue;
    memoryIds.push(memory.id);
    if (memory.deletionProof) {
      replayedCount += 1;
      continue;
    }
    if (!memory.currentVersion) {
      throw stateConflict("Shared Contact Memory has no current version.");
    }
    const currentContentHash = memory.currentVersion.contentHash;

    await lockPendingCorrectionCandidates(tx, memory.id, representativeId);
    await tx.memoryCandidate.updateMany({
      where: {
        representativeId,
        correctionMemoryId: memory.id,
        status: MemoryCandidateStatus.PENDING_REVIEW,
      },
      data: {
        status: MemoryCandidateStatus.EXPIRED,
        safeText: null,
        summary: null,
        contentPurgedAt: input.occurredAt,
        reviewedAt: input.occurredAt,
      },
    });

    if (memory.status === GovernedMemoryStatus.ACTIVE) {
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: input.occurredAt,
          suppressedAt: input.occurredAt,
        },
        include: {
          currentVersion: { select: { id: true, contentHash: true } },
          deletionProof: { select: { id: true } },
        },
      });
    }
    if (!new Set<GovernedMemoryStatus>([
      GovernedMemoryStatus.SUPPRESSED,
      GovernedMemoryStatus.SUPERSEDED,
      GovernedMemoryStatus.EXPIRED,
      GovernedMemoryStatus.ARCHIVED,
      GovernedMemoryStatus.DELETE_PENDING,
    ]).has(memory.status)) {
      throw stateConflict(
        "Shared Contact Memory cannot enter deletion from its current state.",
      );
    }
    const recallBlockedAt = memory.recallDisabledAt ?? input.occurredAt;
    await tx.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: GovernedMemoryStatus.DELETE_PENDING,
        recallDisabledAt: recallBlockedAt,
        deleteRequestedAt: input.occurredAt,
      },
    });
    await queueMemoryProjectionDeletion(
      tx,
      memory.id,
      input.occurredAt,
    );
    const requestDigest = sha256(JSON.stringify([
      "shared-contact-memory-delete-v1",
      representativeId,
      audienceIdentityId,
      requestId,
      memory.id,
    ]));
    await tx.memoryDeletionProof.create({
      data: {
        representativeId,
        memoryId: memory.id,
        requestId: `shared-contact-delete:${requestDigest}`,
        requestedByActorId,
        reasonCode,
        contentHash: currentContentHash,
        recallBlockedAt,
        cleanupStatus: MemoryCleanupStatus.QUEUED,
        availableAt: input.occurredAt,
      },
    });
    queuedCount += 1;
  }

  return {
    matchedCount: memoryIds.length,
    queuedCount,
    replayedCount,
    memoryIds,
  };
}

/**
 * Executes the one P0 contact-facing forget command. The target coordinates
 * are server-owned and intentionally cannot be supplied by a model or caller:
 * current representative + contact + channel + reply-preference semantic key.
 */
export async function requestAutomaticContactReplyPreferenceDeletionInTransaction(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    contactId: string;
    sourceChannel: RepresentativeChannelKind;
    sourceMessageId: string;
    sourceHash: string;
    occurredAt: Date;
  },
): Promise<{ matched: boolean; memoryId: string | null; replayed: boolean }> {
  const representativeId = requiredText(
    input.representativeId,
    "representativeId",
  );
  const contactId = requiredText(input.contactId, "contactId");
  const sourceMessageId = requiredText(input.sourceMessageId, "sourceMessageId");
  requiredSha256(input.sourceHash, "sourceHash");
  const matches = await tx.governedMemory.findMany({
    where: {
      representativeId,
      contactId,
      scope: MemoryScope.CONTACT_CHANNEL,
      sourceChannel: input.sourceChannel,
      semanticKey: contactReplyPreferenceSemanticKey,
      status: {
        notIn: [
          GovernedMemoryStatus.DELETE_PENDING,
          GovernedMemoryStatus.DELETED,
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true },
  });
  if (matches.length === 0) {
    return { matched: false, memoryId: null, replayed: false };
  }
  if (matches.length !== 1) {
    throw stateConflict(
      "Reply-preference forget command resolved to ambiguous memory coordinates.",
    );
  }

  await lockMemory(tx, matches[0]!.id, representativeId);
  let memory = await tx.governedMemory.findFirst({
    where: {
      id: matches[0]!.id,
      representativeId,
      contactId,
      scope: MemoryScope.CONTACT_CHANNEL,
      sourceChannel: input.sourceChannel,
      semanticKey: contactReplyPreferenceSemanticKey,
    },
    include: {
      currentVersion: { select: { id: true, contentHash: true } },
      deletionProof: { select: { id: true } },
    },
  });
  if (!memory?.currentVersion) {
    throw stateConflict("Reply-preference memory has no current version.");
  }
  const currentContentHash = memory.currentVersion.contentHash;
  if (
    memory.status === GovernedMemoryStatus.DELETE_PENDING
    || memory.status === GovernedMemoryStatus.DELETED
    || memory.deletionProof
  ) {
    return { matched: true, memoryId: memory.id, replayed: true };
  }

  await lockPendingCorrectionCandidates(tx, memory.id, representativeId);
  const pendingCorrections = await tx.memoryCandidate.findMany({
    where: {
      representativeId,
      correctionMemoryId: memory.id,
      status: MemoryCandidateStatus.PENDING_REVIEW,
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const pendingCorrection of pendingCorrections) {
    // Historical Owner correction requests are audit-only. Expire and purge
    // them directly; never mint an automatic-policy authority for manual data.
    await tx.memoryCandidate.update({
      where: { id: pendingCorrection.id },
      data: {
        status: MemoryCandidateStatus.EXPIRED,
        safeText: null,
        summary: null,
        contentPurgedAt: input.occurredAt,
      },
    });
  }

  if (memory.status === GovernedMemoryStatus.ACTIVE) {
    memory = await tx.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: GovernedMemoryStatus.SUPPRESSED,
        recallDisabledAt: input.occurredAt,
        suppressedAt: input.occurredAt,
      },
      include: {
        currentVersion: { select: { id: true, contentHash: true } },
        deletionProof: { select: { id: true } },
      },
    });
  }
  if (!new Set<GovernedMemoryStatus>([
    GovernedMemoryStatus.SUPPRESSED,
    GovernedMemoryStatus.SUPERSEDED,
    GovernedMemoryStatus.EXPIRED,
    GovernedMemoryStatus.ARCHIVED,
  ]).has(memory.status)) {
    throw stateConflict(
      "Reply-preference memory cannot enter deletion from its current state.",
    );
  }
  await tx.governedMemory.update({
    where: { id: memory.id },
    data: {
      status: GovernedMemoryStatus.DELETE_PENDING,
      recallDisabledAt: memory.recallDisabledAt ?? input.occurredAt,
      deleteRequestedAt: input.occurredAt,
    },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId: memory.id,
      status: MemoryProjectionStatus.PROJECTING,
    },
    data: { deleteRequestedAt: input.occurredAt },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId: memory.id,
      status: {
        in: [
          MemoryProjectionStatus.DISABLED,
          MemoryProjectionStatus.QUEUED,
          MemoryProjectionStatus.RETRYING,
          MemoryProjectionStatus.STAGED,
          MemoryProjectionStatus.ACTIVE,
          MemoryProjectionStatus.SUPERSEDED,
          MemoryProjectionStatus.FAILED,
          MemoryProjectionStatus.DELETE_FAILED,
        ],
      },
    },
    data: {
      status: MemoryProjectionStatus.DELETE_PENDING,
      deleteRequestedAt: input.occurredAt,
      availableAt: input.occurredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
  await tx.memoryDeletionProof.create({
    data: {
      representativeId,
      memoryId: memory.id,
      requestId: `contact-forget:${sourceMessageId}`,
      requestedByActorId: `system:contact:${contactId}`,
      reasonCode: contactReplyPreferenceForgetReasonCode,
      contentHash: currentContentHash,
      recallBlockedAt: memory.recallDisabledAt ?? input.occurredAt,
      cleanupStatus: MemoryCleanupStatus.QUEUED,
      availableAt: input.occurredAt,
    },
  });
  return { matched: true, memoryId: memory.id, replayed: false };
}

/**
 * Immediately disables recall for every Contact Memory owned by the current
 * representative + contact + channel, then queues provider cleanup. The
 * caller cannot supply a memory ID, URI, namespace, or another contact's
 * coordinates. This control path intentionally does not depend on extraction
 * or recall being enabled.
 */
export async function requestAutomaticContactChannelMemoryDeletionInTransaction(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    contactId: string;
    sourceChannel: RepresentativeChannelKind;
    sourceMessageId: string;
    sourceHash: string;
    occurredAt: Date;
  },
): Promise<{
  matchedCount: number;
  queuedCount: number;
  replayedCount: number;
  memoryIds: string[];
}> {
  const representativeId = requiredText(
    input.representativeId,
    "representativeId",
  );
  const contactId = requiredText(input.contactId, "contactId");
  const sourceMessageId = requiredText(input.sourceMessageId, "sourceMessageId");
  const sourceHash = requiredSha256(input.sourceHash, "sourceHash");
  await lockContactChannelMemoryCoordinate(tx, {
    representativeId,
    contactId,
    sourceChannel: input.sourceChannel,
  });
  const forgetBoundary = await createContactChannelMemoryForgetBoundary(
    tx,
    {
      representativeId,
      contactId,
      sourceChannel: input.sourceChannel,
      sourceMessageId,
      sourceHash,
      occurredAt: input.occurredAt,
    },
  );
  await invalidatePreForgetContactChannelMemoryWork(tx, {
    representativeId,
    contactId,
    sourceChannel: input.sourceChannel,
    sourceMessageId,
    forgetEpoch: forgetBoundary.epoch,
    occurredAt: input.occurredAt,
  });
  const matches = await tx.governedMemory.findMany({
    where: {
      representativeId,
      contactId,
      scope: MemoryScope.CONTACT_CHANNEL,
      sourceChannel: input.sourceChannel,
      status: { not: GovernedMemoryStatus.DELETED },
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  let queuedCount = 0;
  let replayedCount = 0;
  const memoryIds: string[] = [];

  for (const match of matches) {
    await lockMemory(tx, match.id, representativeId);
    let memory = await tx.governedMemory.findFirst({
      where: {
        id: match.id,
        representativeId,
        contactId,
        scope: MemoryScope.CONTACT_CHANNEL,
        sourceChannel: input.sourceChannel,
      },
      include: {
        currentVersion: { select: { id: true, contentHash: true } },
        deletionProof: { select: { id: true } },
      },
    });
    if (!memory || memory.status === GovernedMemoryStatus.DELETED) continue;
    memoryIds.push(memory.id);
    if (
      memory.status === GovernedMemoryStatus.DELETE_PENDING
      || memory.deletionProof
    ) {
      replayedCount += 1;
      continue;
    }
    if (!memory.currentVersion) {
      throw stateConflict("Contact memory has no current version.");
    }
    const currentContentHash = memory.currentVersion.contentHash;

    await lockPendingCorrectionCandidates(tx, memory.id, representativeId);
    await tx.memoryCandidate.updateMany({
      where: {
        representativeId,
        correctionMemoryId: memory.id,
        status: MemoryCandidateStatus.PENDING_REVIEW,
      },
      data: {
        status: MemoryCandidateStatus.EXPIRED,
        safeText: null,
        summary: null,
        contentPurgedAt: input.occurredAt,
      },
    });

    if (memory.status === GovernedMemoryStatus.ACTIVE) {
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: input.occurredAt,
          suppressedAt: input.occurredAt,
        },
        include: {
          currentVersion: { select: { id: true, contentHash: true } },
          deletionProof: { select: { id: true } },
        },
      });
    }
    if (!new Set<GovernedMemoryStatus>([
      GovernedMemoryStatus.SUPPRESSED,
      GovernedMemoryStatus.SUPERSEDED,
      GovernedMemoryStatus.EXPIRED,
      GovernedMemoryStatus.ARCHIVED,
    ]).has(memory.status)) {
      throw stateConflict(
        "Contact memory cannot enter deletion from its current state.",
      );
    }
    const recallBlockedAt = memory.recallDisabledAt ?? input.occurredAt;
    await tx.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: GovernedMemoryStatus.DELETE_PENDING,
        recallDisabledAt: recallBlockedAt,
        deleteRequestedAt: input.occurredAt,
      },
    });
    await tx.memoryProjectionItem.updateMany({
      where: {
        memoryId: memory.id,
        status: MemoryProjectionStatus.PROJECTING,
      },
      data: { deleteRequestedAt: input.occurredAt },
    });
    await tx.memoryProjectionItem.updateMany({
      where: {
        memoryId: memory.id,
        status: {
          in: [
            MemoryProjectionStatus.DISABLED,
            MemoryProjectionStatus.QUEUED,
            MemoryProjectionStatus.RETRYING,
            MemoryProjectionStatus.STAGED,
            MemoryProjectionStatus.ACTIVE,
            MemoryProjectionStatus.SUPERSEDED,
            MemoryProjectionStatus.FAILED,
            MemoryProjectionStatus.DELETE_FAILED,
          ],
        },
      },
      data: {
        status: MemoryProjectionStatus.DELETE_PENDING,
        deleteRequestedAt: input.occurredAt,
        availableAt: input.occurredAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    const requestDigest = createHash("sha256")
      .update(JSON.stringify([
        "contact-forget-all-v1",
        representativeId,
        contactId,
        input.sourceChannel,
        sourceMessageId,
        sourceHash,
        memory.id,
      ]))
      .digest("hex");
    await tx.memoryDeletionProof.create({
      data: {
        representativeId,
        memoryId: memory.id,
        requestId: `contact-forget-all:${requestDigest}`,
        requestedByActorId: `system:contact:${contactId}`,
        reasonCode: contactChannelMemoryForgetReasonCode,
        contentHash: currentContentHash,
        recallBlockedAt,
        cleanupStatus: MemoryCleanupStatus.QUEUED,
        availableAt: input.occurredAt,
      },
    });
    queuedCount += 1;
  }

  return {
    matchedCount: memoryIds.length,
    queuedCount,
    replayedCount,
    memoryIds,
  };
}

async function createContactChannelMemoryForgetBoundary(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    contactId: string;
    sourceChannel: RepresentativeChannelKind;
    sourceMessageId: string;
    sourceHash: string;
    occurredAt: Date;
  },
) {
  const boundaryStore = (
    tx as unknown as Record<string, unknown>
  )["contactChannelMemoryForgetBoundary"] as
    | { findUnique?: unknown }
    | undefined;
  if (typeof boundaryStore?.findUnique !== "function") {
    return { epoch: 0 };
  }
  const replay = await tx.contactChannelMemoryForgetBoundary.findUnique({
    where: { sourceMessageId: input.sourceMessageId },
  });
  if (replay) {
    if (
      replay.representativeId !== input.representativeId
      || replay.contactId !== input.contactId
      || replay.sourceChannel !== input.sourceChannel
    ) {
      throw stateConflict("Forget request source message crossed memory scope.");
    }
    return replay;
  }
  const source = await tx.message.findFirst({
    where: {
      id: input.sourceMessageId,
      senderType: MessageSenderType.AUDIENCE,
      contentType: MessageContentType.TEXT,
      conversation: {
        representativeId: input.representativeId,
        contactId: input.contactId,
      },
    },
    select: {
      id: true,
      conversationId: true,
      text: true,
      ingressSequence: true,
      memoryIngressOrdinal: true,
      conversation: { select: { sourceChannel: true } },
    },
  });
  if (
    !source
    || !source.memoryIngressOrdinal
    || source.conversation.sourceChannel?.trim().toUpperCase()
      !== input.sourceChannel
    || !isAuthoritativeContactChannelForgetCommand(source.text)
    || (
      input.sourceChannel === RepresentativeChannelKind.WEB
        ? source.ingressSequence !== null
        : !source.ingressSequence
    )
  ) {
    throw stateConflict("Forget request source message is not authoritative.");
  }
  const current = await loadLatestContactChannelMemoryForgetBoundary(tx, input);
  if (
    current
    && source.memoryIngressOrdinal <= current.cutoffMemoryIngressOrdinal
  ) {
    throw stateConflict("Forget request predates the current memory boundary.");
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify([
      "contact-channel-memory-forget-v1",
      input.representativeId,
      input.contactId,
      input.sourceChannel,
      source.id,
      source.conversationId,
      source.memoryIngressOrdinal.toString(),
      source.ingressSequence,
      input.sourceHash,
    ]))
    .digest("hex");
  return tx.contactChannelMemoryForgetBoundary.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel: input.sourceChannel,
      epoch: (current?.epoch ?? 0) + 1,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.id,
      cutoffMemoryIngressOrdinal: source.memoryIngressOrdinal,
      cutoffIngressSequence: source.ingressSequence,
      requestHash,
      createdAt: input.occurredAt,
    },
  });
}

function isAuthoritativeContactChannelForgetCommand(text: string | null) {
  if (!text?.trim()) return false;
  const normalized = text
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[。.!！?？]\s*$/u, "")
    .trim();
  return contactChannelMemoryForgetCommands.has(normalized);
}

async function invalidatePreForgetContactChannelMemoryWork(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    contactId: string;
    sourceChannel: RepresentativeChannelKind;
    sourceMessageId: string;
    forgetEpoch: number;
    occurredAt: Date;
  },
) {
  const stores = tx as unknown as Record<string, unknown>;
  if (
    typeof (stores["memoryExtractionRun"] as { updateMany?: unknown } | undefined)
      ?.updateMany !== "function"
    || typeof (stores["memoryCandidate"] as { findMany?: unknown } | undefined)
      ?.findMany !== "function"
  ) return;
  await tx.memoryExtractionRun.updateMany({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel: input.sourceChannel,
      sourceMessageId: { not: input.sourceMessageId },
      contactChannelMemoryEpoch: { lt: input.forgetEpoch },
      status: MemoryExtractionStatus.QUEUED,
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: input.occurredAt,
      finishedAt: input.occurredAt,
      errorCode: contactChannelMemoryForgetCutoffReasonCode,
    },
  });
  await tx.memoryExtractionRun.updateMany({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel: input.sourceChannel,
      sourceMessageId: { not: input.sourceMessageId },
      contactChannelMemoryEpoch: { lt: input.forgetEpoch },
      status: MemoryExtractionStatus.RUNNING,
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: input.occurredAt,
      errorCode: contactChannelMemoryForgetCutoffReasonCode,
    },
  });
  const candidates = await tx.memoryCandidate.findMany({
    where: {
      representativeId: input.representativeId,
      sourceMessageId: { not: input.sourceMessageId },
      contentPurgedAt: null,
      status: {
        in: [
          MemoryCandidateStatus.EXTRACTED,
          MemoryCandidateStatus.PENDING_REVIEW,
        ],
      },
      version: null,
      extractionRun: {
        is: {
          contactId: input.contactId,
          sourceChannel: input.sourceChannel,
          contactChannelMemoryEpoch: { lt: input.forgetEpoch },
        },
      },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      status: true,
      policyDecision: { select: { id: true } },
    },
  });
  for (const candidate of candidates) {
    await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status: candidate.status === MemoryCandidateStatus.PENDING_REVIEW
          ? MemoryCandidateStatus.EXPIRED
          : MemoryCandidateStatus.BLOCKED,
        safeText: null,
        summary: null,
        contentPurgedAt: input.occurredAt,
        ...(candidate.policyDecision
          ? {}
          : {
              safetyClass: MemorySafetyClass.PROHIBITED,
              safetyReasonCode: contactChannelMemoryForgetCutoffReasonCode,
            }),
      },
    });
  }
}

const sourceCandidateInclude = {
  sourceMessage: {
    select: {
      id: true,
      conversationId: true,
      senderType: true,
      contentType: true,
      text: true,
      deliveryStatus: true,
      memoryIngressOrdinal: true,
      editedAt: true,
      redactedAt: true,
      conversation: {
        select: {
          representativeId: true,
          contactId: true,
          sourceChannel: true,
        },
      },
    },
  },
  extractionRun: {
    select: { contactChannelMemoryEpoch: true },
  },
} as const;

type AutomaticMemoryCandidate = Prisma.MemoryCandidateGetPayload<{
  include: typeof sourceCandidateInclude;
}>;

function assertAutomaticCandidateReady(
  candidate: AutomaticMemoryCandidate,
  occurredAt: Date,
) {
  if (candidate.status !== MemoryCandidateStatus.PENDING_REVIEW) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_ready",
      "Memory candidate is no longer ready for automatic policy evaluation.",
      409,
    );
  }
  if (candidate.expiresAt && candidate.expiresAt <= occurredAt) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_ready",
      "Expired memory candidate cannot be activated automatically.",
      409,
    );
  }
  if (
    !candidate.safeText
    || !candidate.summary
    || !candidate.contentHash
    || candidate.contentPurgedAt
    || !new Set<MemorySafetyClass>([
      MemorySafetyClass.LOW_RISK,
      MemorySafetyClass.REVIEW_REQUIRED,
    ]).has(candidate.safetyClass)
    || (
      new Set<MemoryScope>([
        MemoryScope.REPRESENTATIVE,
        MemoryScope.CONTACT_SHARED,
      ]).has(candidate.scope)
      && !candidate.deidentifiedAt
    )
  ) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_ready",
      "Memory candidate no longer has a complete safe automatic-policy payload.",
      409,
    );
  }
}

function assertFreshAutomaticSafety(
  candidate: AutomaticMemoryCandidate,
) {
  assertValidSourceMessage(candidate, true);
  if (!candidate.safeText || !candidate.summary) {
    throw safetyRejected();
  }
  if (sha256(candidate.safeText) !== candidate.contentHash) {
    throw safetyRejected();
  }

  const sourceClassification = classifyMemoryCandidate({
    text: candidate.sourceMessage.text,
    senderType: candidate.sourceMessage.senderType,
    contentType: candidate.sourceMessage.contentType,
    scope: candidate.scope,
  });
  if (sourceClassification.kind !== "reviewable") throw safetyRejected();

  // Automatic policy writes accept only classifier-derived audience
  // candidates. Historical OWNER_VERIFIED_CORRECTION rows remain audit-only
  // and cannot create or authorize active versions.
  if (candidate.sourceKind !== MemorySourceKind.AUDIENCE_MESSAGE) {
    throw safetyRejected();
  }

  const classification = sourceClassification;
  if (
    classification.kind !== "reviewable"
    || classification.category !== candidate.category
    || classification.safeText !== candidate.safeText
    || classification.summary !== candidate.summary
    || sha256(classification.safeText) !== candidate.contentHash
    || (
      candidate.scope === MemoryScope.REPRESENTATIVE
      && !classification.deidentified
    )
  ) {
    throw safetyRejected();
  }
}

function assertValidSourceMessage(
  candidate: {
    representativeId: string;
    sourceContactId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    originChannel: RepresentativeChannelKind;
    sourceMessage: {
      id: string;
      conversationId: string;
      senderType: MessageSenderType;
      contentType: MessageContentType;
      text: string | null;
      deliveryStatus: MessageDeliveryStatus;
      editedAt: Date | null;
      redactedAt: Date | null;
      conversation: {
        representativeId: string;
        contactId: string;
        sourceChannel: string | null;
      };
    };
  },
  requireFreshClassification: boolean,
) {
  const source = candidate.sourceMessage;
  if (
    source.id !== candidate.sourceMessageId
    || source.conversationId !== candidate.sourceConversationId
    || source.senderType !== MessageSenderType.AUDIENCE
    || source.contentType !== MessageContentType.TEXT
    || !source.text?.trim()
    || source.editedAt
    || source.redactedAt
    || source.deliveryStatus === MessageDeliveryStatus.EDITED
    || source.deliveryStatus === MessageDeliveryStatus.REDACTED
    || source.conversation.representativeId !== candidate.representativeId
    || source.conversation.contactId !== candidate.sourceContactId
    || parseRepresentativeChannel(source.conversation.sourceChannel)
      !== candidate.originChannel
  ) {
    throw safetyRejected();
  }
  if (requireFreshClassification) return;
  const classification = classifyMemoryCandidate({
    text: source.text,
    senderType: source.senderType,
    contentType: source.contentType,
    scope: MemoryScope.CONTACT_CHANNEL,
  });
  if (classification.kind === "marker") throw safetyRejected();
}

function policyAllowsCandidate(
  policy: {
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
    contactMemoryCrossChannelEnabled?: boolean;
    representativeExperienceEnabled: boolean;
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  } | null,
  candidate: {
    scope: MemoryScope;
    audienceIdentityId?: string | null;
    scopeChannel: RepresentativeChannelKind | null;
  },
) {
  if (!policy?.longTermMemoryEnabled) return false;
  if (candidate.scope === MemoryScope.REPRESENTATIVE) {
    return policy.representativeExperienceEnabled;
  }
  if (candidate.scope === MemoryScope.CONTACT_SHARED) {
    return Boolean(
      policy.contactMemoryEnabled
      && policy.contactMemoryCrossChannelEnabled
      && candidate.audienceIdentityId
      && !candidate.scopeChannel,
    );
  }
  if (!policy.contactMemoryEnabled || !candidate.scopeChannel) return false;
  if (candidate.scopeChannel === RepresentativeChannelKind.WEB) {
    return policy.webRecallEnabled;
  }
  if (candidate.scopeChannel === RepresentativeChannelKind.MATRIX) {
    return policy.matrixRecallEnabled;
  }
  return policy.telegramRecallEnabled;
}

function automaticMemoryCoordinates(candidate: {
  representativeId: string;
  contactId: string | null;
  audienceIdentityId: string | null;
  scope: MemoryScope;
  scopeChannel: RepresentativeChannelKind | null;
  category: MemoryCategory;
  semanticKey: string | null;
}) {
  const coordinates = {
    representativeId: candidate.representativeId,
    contactId: candidate.contactId,
    audienceIdentityId: candidate.audienceIdentityId,
    scope: candidate.scope,
    sourceChannel: candidate.scopeChannel,
    category: candidate.category,
    semanticKey: candidate.semanticKey,
  };
  return candidate.scope === MemoryScope.CONTACT_SHARED
    ? {
        ...coordinates,
        status: {
          in: [
            GovernedMemoryStatus.ACTIVE,
            GovernedMemoryStatus.SUPPRESSED,
          ],
        },
      }
    : coordinates;
}

async function finishAutomaticCandidateWithoutActivation(
  tx: MemoryGovernanceTransaction,
  input: {
    candidate: AutomaticMemoryCandidate & {
      semanticKey: string | null;
    };
    occurredAt: Date;
    sourceHash: string;
    outputHash: string | null;
    confidence: number;
    policyRevision: number;
    policyVersion: string;
    extractorVersion: string;
    outcome: typeof MemoryPolicyDecisionOutcome.SKIPPED;
    reasonCode: string;
  },
): Promise<AutomaticMemoryPolicyResult> {
  const decision = await createAutomaticPolicyDecision(tx, {
    candidate: input.candidate,
    memoryId: null,
    resultVersionId: null,
    outcome: input.outcome,
    policyRevision: input.policyRevision,
    policyVersion: input.policyVersion,
    extractorVersion: input.extractorVersion,
    sourceHash: input.sourceHash,
    outputHash: input.outputHash,
    confidence: input.confidence,
    reasonCode: input.reasonCode,
  });
  await tx.memoryCandidate.update({
    where: { id: input.candidate.id },
    data: {
      status: MemoryCandidateStatus.REJECTED,
      reviewedAt: input.occurredAt,
      safeText: null,
      summary: null,
      contentPurgedAt: input.occurredAt,
    },
  });
  return {
    candidateId: input.candidate.id,
    outcome: decision.outcome,
    memoryId: null,
    memoryVersionId: null,
    replayed: false,
  };
}

async function createAutomaticPolicyDecision(
  tx: MemoryGovernanceTransaction,
  input: {
    candidate: {
      id: string;
      representativeId: string;
      contentHash: string | null;
      semanticKey?: string | null;
    };
    memoryId: string | null;
    resultVersionId: string | null;
    outcome: MemoryPolicyDecisionOutcome;
    policyRevision: number;
    policyVersion: string;
    extractorVersion: string;
    sourceHash: string;
    outputHash: string | null;
    confidence: number;
    reasonCode: string;
  },
) {
  const decisionHash = sha256(JSON.stringify({
    representativeId: input.candidate.representativeId,
    candidateId: input.candidate.id,
    semanticKey: input.candidate.semanticKey ?? null,
    memoryId: input.memoryId,
    resultVersionId: input.resultVersionId,
    outcome: input.outcome,
    policyRevision: input.policyRevision,
    policyVersion: input.policyVersion,
    extractorVersion: input.extractorVersion,
    sourceHash: input.sourceHash,
    outputHash: input.outputHash,
    confidence: input.confidence,
    reasonCode: input.reasonCode,
  }));
  return tx.memoryPolicyDecision.create({
    data: {
      representativeId: input.candidate.representativeId,
      candidateId: input.candidate.id,
      memoryId: input.memoryId,
      resultVersionId: input.resultVersionId,
      outcome: input.outcome,
      policyRevision: input.policyRevision,
      policyVersion: input.policyVersion,
      extractorVersion: input.extractorVersion,
      sourceHash: input.sourceHash,
      outputHash: input.outputHash,
      confidence: input.confidence,
      reasonCode: input.reasonCode,
      decisionHash,
    },
  });
}

async function supersedePriorProjection(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  memoryVersionId: string,
  occurredAt: Date,
) {
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId,
      memoryVersionId,
      status: {
        in: [MemoryProjectionStatus.ACTIVE, MemoryProjectionStatus.STAGED],
      },
    },
    data: { status: MemoryProjectionStatus.SUPERSEDED },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId,
      memoryVersionId,
      status: MemoryProjectionStatus.PROJECTING,
    },
    data: { deleteRequestedAt: occurredAt },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId,
      memoryVersionId,
      status: {
        in: [
          MemoryProjectionStatus.DISABLED,
          MemoryProjectionStatus.QUEUED,
          MemoryProjectionStatus.RETRYING,
          MemoryProjectionStatus.FAILED,
        ],
      },
    },
    data: {
      status: MemoryProjectionStatus.DELETE_PENDING,
      deleteRequestedAt: occurredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
}

function buildCanonicalMemoryProjectionUri(input: {
  namespaceKey: string;
  candidate: {
    scope: MemoryScope;
    contactId: string | null;
    audienceIdentityId: string | null;
    scopeChannel: RepresentativeChannelKind | null;
  };
  memoryId: string;
  memoryVersionId: string;
}) {
  if (input.candidate.scope === MemoryScope.REPRESENTATIVE) {
    return buildGovernedRepresentativeExperienceVersionUri({
      namespaceKey: input.namespaceKey,
      memoryId: input.memoryId,
      memoryVersionId: input.memoryVersionId,
    });
  }
  if (input.candidate.scope === MemoryScope.CONTACT_SHARED) {
    if (!input.candidate.audienceIdentityId || input.candidate.scopeChannel) {
      throw stateConflict(
        "Shared Contact Memory projection coordinates are incomplete.",
      );
    }
    return buildGovernedSharedContactMemoryVersionUri({
      namespaceKey: input.namespaceKey,
      audienceIdentityId: input.candidate.audienceIdentityId,
      memoryId: input.memoryId,
      memoryVersionId: input.memoryVersionId,
    });
  }
  if (!input.candidate.contactId || !input.candidate.scopeChannel) {
    throw stateConflict("Contact memory projection coordinates are incomplete.");
  }
  return buildGovernedContactChannelMemoryVersionUri({
    namespaceKey: input.namespaceKey,
    contactId: input.candidate.contactId,
    channel: input.candidate.scopeChannel.toLowerCase() as
      | "web"
      | "matrix"
      | "telegram",
    memoryId: input.memoryId,
    memoryVersionId: input.memoryVersionId,
  });
}

async function lockCandidate(
  tx: MemoryGovernanceTransaction,
  candidateId: string,
  representativeId: string | null,
) {
  if (!representativeId) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "MemoryCandidate"
      WHERE "id" = ${candidateId}
      FOR UPDATE
    `);
    return;
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryCandidate"
    WHERE "id" = ${candidateId} AND "representativeId" = ${representativeId}
    FOR UPDATE
  `);
}

async function lockMemory(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  representativeId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "GovernedMemory"
    WHERE "id" = ${memoryId} AND "representativeId" = ${representativeId}
    FOR UPDATE
  `);
}

/**
 * Canonical lock for all shared Contact Memory mutations. Callers must take
 * this lock before reading current consent or mutating a shared memory row.
 */
export async function lockContactSharedMemoryCoordinate(
  tx: MemoryGovernanceTransaction,
  input: {
    representativeId: string;
    audienceIdentityId: string;
  },
) {
  const representativeId = requiredText(
    input.representativeId,
    "representativeId",
  );
  const audienceIdentityId = requiredText(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  await tx.$queryRaw(Prisma.sql`
    SELECT "representativeId" FROM "RepresentativeMemoryPolicy"
    WHERE "representativeId" = ${representativeId}
    FOR SHARE
  `);
  const lockKey = [
    "contact-shared-memory-v1",
    representativeId,
    audienceIdentityId,
  ].join(":");
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "AudienceIdentity"
    WHERE "id" = ${audienceIdentityId}
    FOR UPDATE
  `);
}

async function queueMemoryProjectionDeletion(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  occurredAt: Date,
) {
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId,
      status: MemoryProjectionStatus.PROJECTING,
    },
    data: { deleteRequestedAt: occurredAt },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId,
      status: {
        in: [
          MemoryProjectionStatus.DISABLED,
          MemoryProjectionStatus.QUEUED,
          MemoryProjectionStatus.RETRYING,
          MemoryProjectionStatus.STAGED,
          MemoryProjectionStatus.ACTIVE,
          MemoryProjectionStatus.SUPERSEDED,
          MemoryProjectionStatus.FAILED,
          MemoryProjectionStatus.DELETE_FAILED,
        ],
      },
    },
    data: {
      status: MemoryProjectionStatus.DELETE_PENDING,
      deleteRequestedAt: occurredAt,
      availableAt: occurredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
}

async function lockPendingCorrectionCandidates(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  representativeId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryCandidate"
    WHERE "correctionMemoryId" = ${memoryId}
      AND "representativeId" = ${representativeId}
      AND "status" = 'PENDING_REVIEW'::"MemoryCandidateStatus"
    ORDER BY "id"
    FOR UPDATE
  `);
}

function requiredText(
  value: unknown,
  field: string,
  maximumLength = maximumTextIdentifierLength,
) {
  if (typeof value !== "string") throw invalidInput(`${field} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw invalidInput(`${field} must contain 1-${maximumLength} characters.`);
  }
  return normalized;
}

function requiredSha256(value: unknown, field: string) {
  const normalized = requiredText(value, field, 64);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw invalidInput(`${field} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function requiredPolicyToken(value: unknown, field: string) {
  const normalized = requiredText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw invalidInput(`${field} contains unsupported characters.`);
  }
  return normalized;
}

function projectionIdempotencyKey(
  provider: string,
  versionId: string,
  contentHash: string,
) {
  return [
    "memory-projection",
    memoryProjectionContractVersion,
    provider,
    MemoryProjectionLane.RECALL,
    versionId,
    contentHash,
  ].join(":");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRepresentativeChannel(value: string | null) {
  const normalized = value?.trim().toUpperCase();
  if (normalized === RepresentativeChannelKind.WEB) {
    return RepresentativeChannelKind.WEB;
  }
  if (normalized === RepresentativeChannelKind.MATRIX) {
    return RepresentativeChannelKind.MATRIX;
  }
  if (normalized === RepresentativeChannelKind.TELEGRAM) {
    return RepresentativeChannelKind.TELEGRAM;
  }
  return null;
}

function invalidInput(message: string) {
  return new MemoryGovernanceError("memory_invalid_input", message, 400);
}

function notFound() {
  return new MemoryGovernanceError(
    "memory_not_found",
    "Memory resource not found.",
    404,
  );
}

function stateConflict(message: string) {
  return new MemoryGovernanceError("memory_state_conflict", message, 409);
}

function safetyRejected() {
  return new MemoryGovernanceError(
    "memory_safety_rejected",
    "The memory no longer passes the current source and safety checks.",
    409,
  );
}
