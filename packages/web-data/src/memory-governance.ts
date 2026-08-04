import { createHash } from "node:crypto";

import {
  EventType,
  GovernedMemoryStatus,
  MemoryCandidateStatus,
  MemoryCategory,
  MemoryCleanupStatus,
  MemoryProjectionLane,
  MemoryProjectionStatus,
  MemoryReviewOutcome,
  MemoryReviewerRole,
  MemorySafetyClass,
  MemoryScope,
  MemorySourceKind,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
  type OrganizationMemberRole,
  type PrismaClient,
} from "@prisma/client";
import {
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceVersionUri,
} from "@delegate/openviking";

import { classifyMemoryCandidate } from "./memory-extraction";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

type MemoryGovernanceTransaction = Prisma.TransactionClient;

export type MemoryGovernanceCommandMetadata = {
  actorOwnerId: string;
  representativeSlug: string;
  requestId: string;
  idempotencyKey: string;
  expectedUpdatedAt: string;
  reasonCode: string;
  note?: string;
};

export type ContactMemoryPreferenceField =
  | "reply_length"
  | "reply_language"
  | "reply_format"
  | "reply_tone";

export type RepresentativeMemoryPatternCode =
  | "response_format_preference"
  | "service_goal_confirmation"
  | "safety_constraint_confirmation";

export type MemoryGovernanceMutationResult = {
  replayed: boolean;
  representativeId: string;
  action: MemoryGovernanceAction;
  candidateId?: string;
  memoryId?: string;
  memoryVersionId?: string;
  deletionProofId?: string;
  status: string;
  memoryStatus?: string;
  updatedAt: string;
};

export type OperatorConversationMemoryContext = {
  representativeId: string;
  conversationId: string;
  contactId: string;
  sourceChannel: "web" | "matrix" | "telegram";
  items: Array<{
    kind: "contact_memory" | "representative_experience";
    category: string;
    summary: string;
  }>;
};

export type MemoryGovernanceOptions = {
  client?: PrismaClient;
  now?: () => Date;
};

export type MemoryGovernanceErrorCode =
  | "memory_invalid_input"
  | "memory_not_found"
  | "memory_forbidden"
  | "memory_version_conflict"
  | "memory_idempotency_conflict"
  | "memory_state_conflict"
  | "memory_candidate_not_reviewable"
  | "memory_safety_rejected"
  | "memory_independent_review_required"
  | "memory_cleanup_lease_active"
  | "memory_write_conflict";

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

type MemoryGovernanceAction =
  | "approve_candidate"
  | "reject_candidate"
  | "block_candidate"
  | "request_correction"
  | "suppress_memory"
  | "archive_memory"
  | "restore_memory"
  | "request_deletion"
  | "retry_cleanup";

type ResolvedMemoryActor = {
  actorOwnerId: string;
  representativeId: string;
  representativeOwnerId: string;
  role: "OWNER" | "ADMIN" | "REVIEWER" | "OPERATOR";
  reviewerRole: MemoryReviewerRole | null;
};

type ValidatedCommand = {
  actorOwnerId: string;
  representativeSlug: string;
  requestId: string;
  idempotencyKey: string;
  expectedUpdatedAt: Date;
  reasonCode: string;
  note: string | null;
};

const maximumTextIdentifierLength = 191;
const maximumOpaqueTokenLength = 191;
const maximumReasonCodeLength = 128;
const maximumNoteLength = 500;
const memoryProjectionContractVersion = "v1";
const deletionCorrectionReasonCode = "memory_deletion_requested";
const opaqueTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u;
const reasonCodePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const contactPreferenceValues = {
  reply_length: new Set(["concise", "detailed"]),
  reply_language: new Set(["zh", "en"]),
  reply_format: new Set([
    "bullets",
    "numbered_list",
    "steps",
    "markdown",
    "plain_text",
  ]),
  reply_tone: new Set(["formal", "friendly", "direct", "casual"]),
} satisfies Record<ContactMemoryPreferenceField, ReadonlySet<string>>;

const representativePatterns: Record<
  RepresentativeMemoryPatternCode,
  {
    category: MemoryCategory;
    safeText: string;
    summary: string;
    extractionReasonCode: string;
  }
> = {
  response_format_preference: {
    category: MemoryCategory.REPRESENTATIVE_RESPONSE_PATTERN,
    safeText:
      "Response pattern: adapt the reply format to an explicitly stated communication preference.",
    summary: "Adapt response format to an explicit communication preference.",
    extractionReasonCode: "deidentified_response_pattern",
  },
  service_goal_confirmation: {
    category: MemoryCategory.REPRESENTATIVE_SERVICE_PATTERN,
    safeText: "Service pattern: confirm the stated goal before proposing next steps.",
    summary: "Confirm the goal before proposing next steps.",
    extractionReasonCode: "deidentified_service_pattern",
  },
  safety_constraint_confirmation: {
    category: MemoryCategory.REPRESENTATIVE_SAFETY_PATTERN,
    safeText:
      "Safety pattern: confirm an explicitly stated constraint before taking action.",
    summary: "Confirm explicit constraints before action.",
    extractionReasonCode: "deidentified_safety_pattern",
  },
};

export async function approveMemoryCandidate(
  input: MemoryGovernanceCommandMetadata & { candidateId: string },
  options: MemoryGovernanceOptions = {},
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const candidateId = requiredText(input.candidateId, "candidateId");
  const requestHash = hashRequest([
    "approve_candidate",
    command,
    candidateId,
  ]);

  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertReviewActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      EventType.MEMORY_CANDIDATE_APPROVED,
      requestHash,
    );
    if (replay) return replay;

    // Correction governance always locks the memory aggregate before its
    // candidate. Deletion and restore use the same order, so a pending
    // correction cannot race either operation into a deadlock-prone split
    // decision.
    const candidateCoordinates = await tx.memoryCandidate.findFirst({
      where: { id: candidateId, representativeId: actor.representativeId },
      select: {
        sourceKind: true,
        correctionMemoryId: true,
      },
    });
    if (
      candidateCoordinates?.sourceKind
        === MemorySourceKind.OWNER_VERIFIED_CORRECTION
      && candidateCoordinates.correctionMemoryId
    ) {
      await lockMemory(
        tx,
        candidateCoordinates.correctionMemoryId,
        actor.representativeId,
      );
    }
    await lockCandidate(tx, candidateId, actor.representativeId);
    const candidate = await loadCandidateForReview(
      tx,
      candidateId,
      actor.representativeId,
    );
    assertExpectedUpdatedAt(candidate.updatedAt, command.expectedUpdatedAt);
    assertPendingReviewCandidate(candidate, occurredAt);
    assertFreshApprovalSafety(candidate);

    const policy = await tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: actor.representativeId },
      select: {
        provider: true,
        namespaceKey: true,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: true,
        webRecallEnabled: true,
        matrixRecallEnabled: true,
        telegramRecallEnabled: true,
      },
    });
    if (!policy || !policyAllowsCandidate(policy, candidate)) {
      throw stateConflict("Memory policy does not allow this candidate to become active.");
    }

    let memory;
    let versionNumber = 1;
    let supersedesVersionId: string | null = null;
    let versionCreatedByActorId = candidate.extractionRunId
      ? `system:memory-extraction:${candidate.extractionRunId}`
      : `system:memory-candidate:${candidate.id}`;

    if (candidate.sourceKind === MemorySourceKind.OWNER_VERIFIED_CORRECTION) {
      if (!candidate.correctionMemoryId || !candidate.correctionBaseVersionId) {
        throw stateConflict("Correction coordinates are incomplete.");
      }
      memory = await tx.governedMemory.findFirst({
        where: {
          id: candidate.correctionMemoryId,
          representativeId: actor.representativeId,
        },
        include: {
          currentVersion: { select: { id: true, versionNumber: true } },
        },
      });
      if (
        !memory
        || memory.status !== GovernedMemoryStatus.SUPPRESSED
        || memory.currentVersionId !== candidate.correctionBaseVersionId
        || !memory.currentVersion
      ) {
        throw stateConflict("The correction base is no longer current.");
      }
      const correctionRequest = await tx.memoryReviewDecision.findFirst({
        where: {
          representativeId: actor.representativeId,
          candidateId: candidate.id,
          memoryId: memory.id,
          outcome: MemoryReviewOutcome.CORRECTION_REQUESTED,
        },
        orderBy: { createdAt: "asc" },
        select: { reviewerActorId: true },
      });
      if (!correctionRequest) {
        throw stateConflict("The correction was not requested through governance.");
      }
      if (
        candidate.scope === MemoryScope.REPRESENTATIVE
        && correctionRequest.reviewerActorId === actor.actorOwnerId
      ) {
        throw new MemoryGovernanceError(
          "memory_independent_review_required",
          "Representative experience corrections require a different reviewer.",
          409,
        );
      }
      versionNumber = memory.currentVersion.versionNumber + 1;
      supersedesVersionId = memory.currentVersion.id;
      versionCreatedByActorId = correctionRequest.reviewerActorId;
    } else {
      memory = await tx.governedMemory.create({
        data: {
          representativeId: actor.representativeId,
          contactId: candidate.contactId,
          scope: candidate.scope,
          sourceChannel: candidate.scopeChannel,
          category: candidate.category,
          status: GovernedMemoryStatus.SUPPRESSED,
          expiresAt: candidate.expiresAt,
          recallDisabledAt: occurredAt,
          suppressedAt: occurredAt,
        },
      });
    }

    const version = await tx.governedMemoryVersion.create({
      data: {
        memoryId: memory.id,
        representativeId: actor.representativeId,
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
            ? "closed-pattern-v1"
            : null,
        correctionReasonCode:
          supersedesVersionId === null ? null : command.reasonCode,
        createdByActorId: versionCreatedByActorId,
      },
    });

    await tx.memoryReviewDecision.create({
      data: {
        representativeId: actor.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        resultVersionId: version.id,
        outcome: MemoryReviewOutcome.APPROVED,
        reviewerRole: actor.reviewerRole!,
        reviewerActorId: actor.actorOwnerId,
        reasonCode: command.reasonCode,
        note: command.note,
      },
    });
    await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status: MemoryCandidateStatus.APPROVED,
        reviewedAt: occurredAt,
      },
    });

    if (supersedesVersionId) {
      await tx.memoryProjectionItem.updateMany({
        where: {
          memoryId: memory.id,
          memoryVersionId: supersedesVersionId,
          status: {
            in: [MemoryProjectionStatus.ACTIVE, MemoryProjectionStatus.STAGED],
          },
        },
        data: { status: MemoryProjectionStatus.SUPERSEDED },
      });
      await tx.memoryProjectionItem.updateMany({
        where: {
          memoryId: memory.id,
          memoryVersionId: supersedesVersionId,
          status: MemoryProjectionStatus.PROJECTING,
        },
        data: {
          // Preserve the active writer lease. T5 will drain the in-flight
          // exact write and then delete it; clearing the lease here could let
          // a late provider response recreate data after cleanup proof.
          deleteRequestedAt: occurredAt,
        },
      });
      await tx.memoryProjectionItem.updateMany({
        where: {
          memoryId: memory.id,
          memoryVersionId: supersedesVersionId,
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

    const activeMemory = await tx.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: GovernedMemoryStatus.ACTIVE,
        currentVersionId: version.id,
        recallDisabledAt: null,
        expiresAt: candidate.expiresAt ?? memory.expiresAt,
      },
      select: { id: true, status: true, updatedAt: true },
    });
    await tx.memoryProjectionItem.create({
      data: {
        representativeId: actor.representativeId,
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

    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action: "approve_candidate",
      candidateId: candidate.id,
      memoryId: memory.id,
      memoryVersionId: version.id,
      status: MemoryCandidateStatus.APPROVED,
      memoryStatus: activeMemory.status,
      updatedAt: activeMemory.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: EventType.MEMORY_CANDIDATE_APPROVED,
      result,
    });
    return result;
  });
}

export async function rejectMemoryCandidate(
  input: MemoryGovernanceCommandMetadata & { candidateId: string },
  options: MemoryGovernanceOptions = {},
) {
  return reviewCandidateTerminal(
    input,
    {
      action: "reject_candidate",
      eventType: EventType.MEMORY_CANDIDATE_REJECTED,
      outcome: MemoryReviewOutcome.REJECTED,
      status: MemoryCandidateStatus.REJECTED,
    },
    options,
  );
}

export async function blockMemoryCandidate(
  input: MemoryGovernanceCommandMetadata & { candidateId: string },
  options: MemoryGovernanceOptions = {},
) {
  return reviewCandidateTerminal(
    input,
    {
      action: "block_candidate",
      eventType: EventType.MEMORY_CANDIDATE_BLOCKED,
      outcome: MemoryReviewOutcome.BLOCKED,
      status: MemoryCandidateStatus.BLOCKED,
    },
    options,
  );
}

export async function requestMemoryCorrection(
  input: MemoryGovernanceCommandMetadata & {
    memoryId: string;
    preferenceField?: ContactMemoryPreferenceField;
    preferenceValue?: string;
    representativePatternCode?: RepresentativeMemoryPatternCode;
  },
  options: MemoryGovernanceOptions = {},
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const memoryId = requiredText(input.memoryId, "memoryId");
  const correctionRequest = validateCorrectionRequest(input);
  const requestHash = hashRequest([
    "request_correction",
    command,
    memoryId,
    correctionRequest,
  ]);

  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertFullGovernanceActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      EventType.MEMORY_CORRECTION_REQUESTED,
      requestHash,
    );
    if (replay) return replay;

    await lockMemory(tx, memoryId, actor.representativeId);
    const memory = await loadMemoryForCorrection(
      tx,
      memoryId,
      actor.representativeId,
    );
    assertExpectedUpdatedAt(memory.updatedAt, command.expectedUpdatedAt);
    if (
      (
        memory.status !== GovernedMemoryStatus.ACTIVE
        && memory.status !== GovernedMemoryStatus.SUPPRESSED
      )
      || !memory.currentVersion
      || !memory.currentVersion.sourceCandidate
    ) {
      throw stateConflict("Only current active or suppressed memory can be corrected.");
    }
    if (
      memory.currentVersion.sourceCandidate.status
      !== MemoryCandidateStatus.APPROVED
    ) {
      throw stateConflict("The current memory version is no longer approved.");
    }
    if (memory.expiresAt && memory.expiresAt <= occurredAt) {
      throw stateConflict("Expired memory cannot be corrected.");
    }
    assertValidSourceMessage(
      memory.currentVersion.sourceCandidate,
      false,
    );

    const corrected = buildCorrectionPayload(memory, correctionRequest);
    let memoryUpdatedAt = memory.updatedAt;
    if (memory.status === GovernedMemoryStatus.ACTIVE) {
      const suppressed = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: occurredAt,
          suppressedAt: occurredAt,
        },
        select: { updatedAt: true },
      });
      memoryUpdatedAt = suppressed.updatedAt;
    }

    const candidate = await tx.memoryCandidate.create({
      data: {
        representativeId: actor.representativeId,
        extractionRunId: null,
        contactId: memory.contactId,
        scope: memory.scope,
        scopeChannel: memory.sourceChannel,
        originChannel: memory.currentVersion.sourceCandidate.originChannel,
        category: memory.category,
        sourceKind: MemorySourceKind.OWNER_VERIFIED_CORRECTION,
        safeText: corrected.safeText,
        summary: corrected.summary,
        contentHash: sha256(corrected.safeText),
        dedupeKey: `correction:${memory.id}:${memory.currentVersion.id}:${sha256(
          corrected.safeText,
        )}`,
        status: MemoryCandidateStatus.PENDING_REVIEW,
        safetyClass: MemorySafetyClass.LOW_RISK,
        extractionReasonCode: corrected.extractionReasonCode,
        sourceContactId:
          memory.currentVersion.sourceCandidate.sourceContactId,
        sourceConversationId:
          memory.currentVersion.sourceCandidate.sourceConversationId,
        sourceMessageId: memory.currentVersion.sourceCandidate.sourceMessageId,
        correctionMemoryId: memory.id,
        correctionBaseVersionId: memory.currentVersion.id,
        deidentifiedAt:
          memory.scope === MemoryScope.REPRESENTATIVE ? occurredAt : null,
        expiresAt: memory.expiresAt,
      },
    });
    await tx.memoryReviewDecision.create({
      data: {
        representativeId: actor.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        outcome: MemoryReviewOutcome.CORRECTION_REQUESTED,
        reviewerRole: actor.reviewerRole!,
        reviewerActorId: actor.actorOwnerId,
        reasonCode: command.reasonCode,
        note: command.note,
      },
    });

    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action: "request_correction",
      candidateId: candidate.id,
      memoryId: memory.id,
      memoryVersionId: memory.currentVersion.id,
      status: MemoryCandidateStatus.PENDING_REVIEW,
      memoryStatus: GovernedMemoryStatus.SUPPRESSED,
      updatedAt: candidate.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: EventType.MEMORY_CORRECTION_REQUESTED,
      result,
      extraPayload: { memoryUpdatedAt: memoryUpdatedAt.toISOString() },
    });
    return result;
  });
}

export async function suppressGovernedMemory(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  options: MemoryGovernanceOptions = {},
) {
  return changeMemoryStatus(
    input,
    "suppress_memory",
    options,
  );
}

export async function archiveGovernedMemory(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  options: MemoryGovernanceOptions = {},
) {
  return changeMemoryStatus(input, "archive_memory", options);
}

export async function restoreGovernedMemory(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  options: MemoryGovernanceOptions = {},
) {
  return changeMemoryStatus(input, "restore_memory", options);
}

export async function requestGovernedMemoryDeletion(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  options: MemoryGovernanceOptions = {},
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const memoryId = requiredText(input.memoryId, "memoryId");
  const requestHash = hashRequest(["request_deletion", command, memoryId]);

  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertFullGovernanceActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      EventType.MEMORY_DELETION_REQUESTED,
      requestHash,
    );
    if (replay) return replay;

    await lockMemory(tx, memoryId, actor.representativeId);
    let memory = await tx.governedMemory.findFirst({
      where: { id: memoryId, representativeId: actor.representativeId },
      include: { currentVersion: { select: { id: true, contentHash: true } } },
    });
    if (!memory) throw notFound();
    assertExpectedUpdatedAt(memory.updatedAt, command.expectedUpdatedAt);
    if (
      memory.status === GovernedMemoryStatus.DELETE_PENDING
      || memory.status === GovernedMemoryStatus.DELETED
      || !memory.currentVersion
    ) {
      throw stateConflict("Memory is already deleting, deleted, or has no current version.");
    }

    await lockPendingCorrectionCandidates(
      tx,
      memory.id,
      actor.representativeId,
    );
    const pendingCorrections = await tx.memoryCandidate.findMany({
      where: {
        representativeId: actor.representativeId,
        correctionMemoryId: memory.id,
        status: MemoryCandidateStatus.PENDING_REVIEW,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    if (memory.status === GovernedMemoryStatus.ACTIVE) {
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: occurredAt,
          suppressedAt: occurredAt,
        },
        include: { currentVersion: { select: { id: true, contentHash: true } } },
      });
    }

    // A deletion supersedes every unapproved correction. Record an explicit
    // terminal review outcome, then purge the candidate body before the
    // deletion proof is allowed to exist.
    for (const pendingCorrection of pendingCorrections) {
      await tx.memoryReviewDecision.create({
        data: {
          representativeId: actor.representativeId,
          candidateId: pendingCorrection.id,
          memoryId: memory.id,
          outcome: MemoryReviewOutcome.BLOCKED,
          reviewerRole: actor.reviewerRole!,
          reviewerActorId: actor.actorOwnerId,
          reasonCode: deletionCorrectionReasonCode,
          note: null,
        },
      });
      await tx.memoryCandidate.update({
        where: { id: pendingCorrection.id },
        data: {
          status: MemoryCandidateStatus.BLOCKED,
          reviewedAt: occurredAt,
          safeText: null,
          summary: null,
          contentPurgedAt: occurredAt,
        },
      });
    }

    if (!new Set<GovernedMemoryStatus>([
      GovernedMemoryStatus.SUPPRESSED,
      GovernedMemoryStatus.SUPERSEDED,
      GovernedMemoryStatus.EXPIRED,
      GovernedMemoryStatus.ARCHIVED,
    ]).has(memory.status)) {
      throw stateConflict("Memory cannot enter deletion from its current state.");
    }

    const deletePending = await tx.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: GovernedMemoryStatus.DELETE_PENDING,
        recallDisabledAt: memory.recallDisabledAt ?? occurredAt,
        deleteRequestedAt: occurredAt,
      },
      select: { id: true, status: true, updatedAt: true },
    });
    await tx.memoryProjectionItem.updateMany({
      where: {
        memoryId: memory.id,
        status: MemoryProjectionStatus.PROJECTING,
      },
      data: { deleteRequestedAt: occurredAt },
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
        deleteRequestedAt: occurredAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    const proof = await tx.memoryDeletionProof.create({
      data: {
        representativeId: actor.representativeId,
        memoryId: memory.id,
        requestId: command.requestId,
        requestedByActorId: actor.actorOwnerId,
        reasonCode: command.reasonCode,
        contentHash: memory.currentVersion!.contentHash,
        recallBlockedAt: memory.recallDisabledAt ?? occurredAt,
        cleanupStatus: MemoryCleanupStatus.QUEUED,
        availableAt: occurredAt,
      },
    });

    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action: "request_deletion",
      memoryId: memory.id,
      memoryVersionId: memory.currentVersion!.id,
      deletionProofId: proof.id,
      status: proof.cleanupStatus,
      memoryStatus: deletePending.status,
      updatedAt: deletePending.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: EventType.MEMORY_DELETION_REQUESTED,
      result,
      extraPayload: {
        terminatedCorrectionCandidateCount: pendingCorrections.length,
      },
    });
    return result;
  });
}

export async function retryGovernedMemoryCleanup(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  options: MemoryGovernanceOptions = {},
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const memoryId = requiredText(input.memoryId, "memoryId");
  const requestHash = hashRequest(["retry_cleanup", command, memoryId]);

  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertFullGovernanceActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      EventType.MEMORY_CLEANUP_RETRY_REQUESTED,
      requestHash,
    );
    if (replay) return replay;

    await lockDeletionProof(tx, memoryId, actor.representativeId);
    const proof = await tx.memoryDeletionProof.findFirst({
      where: { memoryId, representativeId: actor.representativeId },
      include: { memory: { select: { status: true } } },
    });
    if (!proof) throw notFound();
    assertExpectedUpdatedAt(proof.updatedAt, command.expectedUpdatedAt);
    if (
      proof.memory.status !== GovernedMemoryStatus.DELETE_PENDING
    ) {
      throw stateConflict("Only pending memory deletion cleanup can be retried.");
    }
    if (proof.cleanupStatus === MemoryCleanupStatus.RUNNING) {
      if (!proof.leaseExpiresAt || proof.leaseExpiresAt > occurredAt) {
        throw new MemoryGovernanceError(
          "memory_cleanup_lease_active",
          "A healthy cleanup worker lease is still active.",
          409,
        );
      }
      await tx.memoryDeletionProof.update({
        where: { id: proof.id },
        data: {
          cleanupStatus: MemoryCleanupStatus.FAILED,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "cleanup_lease_expired",
        },
      });
    } else if (proof.cleanupStatus === MemoryCleanupStatus.RETRYING) {
      const retrying = await tx.memoryDeletionProof.update({
        where: { id: proof.id },
        data: { availableAt: occurredAt },
        select: { id: true, cleanupStatus: true, updatedAt: true },
      });
      const result: MemoryGovernanceMutationResult = {
        replayed: false,
        representativeId: actor.representativeId,
        action: "retry_cleanup",
        memoryId,
        deletionProofId: retrying.id,
        status: retrying.cleanupStatus,
        memoryStatus: GovernedMemoryStatus.DELETE_PENDING,
        updatedAt: retrying.updatedAt.toISOString(),
      };
      await createGovernanceAudit(tx, {
        actor,
        command,
        requestHash,
        type: EventType.MEMORY_CLEANUP_RETRY_REQUESTED,
        result,
      });
      return result;
    } else if (proof.cleanupStatus !== MemoryCleanupStatus.FAILED) {
      throw stateConflict("Cleanup is not failed or awaiting retry.");
    }
    const queued = await tx.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: MemoryCleanupStatus.QUEUED,
        availableAt: occurredAt,
        lastErrorCode: null,
      },
      select: { id: true, cleanupStatus: true, updatedAt: true },
    });

    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action: "retry_cleanup",
      memoryId,
      deletionProofId: queued.id,
      status: queued.cleanupStatus,
      memoryStatus: GovernedMemoryStatus.DELETE_PENDING,
      updatedAt: queued.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: EventType.MEMORY_CLEANUP_RETRY_REQUESTED,
      result,
    });
    return result;
  });
}

export async function getOperatorConversationMemoryContext(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    conversationId: string;
  },
  options: Pick<MemoryGovernanceOptions, "client" | "now"> = {},
): Promise<OperatorConversationMemoryContext> {
  const actorOwnerId = requiredText(input.actorOwnerId, "actorOwnerId");
  const representativeSlug = requiredText(
    input.representativeSlug,
    "representativeSlug",
  );
  const conversationId = requiredText(input.conversationId, "conversationId");
  const client = options.client ?? prisma;
  const now = (options.now ?? (() => new Date()))();
  return runWithPrismaWriteConflictRetry(() => client.$transaction(
    async (tx) => {
      const actor = await resolveMemoryActor(
        tx,
        actorOwnerId,
        representativeSlug,
      );
      if (actor.role === "REVIEWER") {
        throw forbidden("Reviewers do not receive Inbox memory context.");
      }

      if (actor.role === "OPERATOR") {
        await lockOperatorConversationAccess(
          tx,
          conversationId,
          actor.representativeId,
          actor.actorOwnerId,
        );
      }

      const conversation = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          representativeId: actor.representativeId,
          ...(actor.role === "OPERATOR"
            ? {
                assignedOperatorId: actor.actorOwnerId,
                assignments: {
                  some: {
                    operatorId: actor.actorOwnerId,
                    status: "ACTIVE" as const,
                  },
                },
              }
            : {}),
        },
        select: {
          id: true,
          contactId: true,
          sourceChannel: true,
        },
      });
      if (!conversation) throw notFound();
      const sourceChannel = parseRepresentativeChannel(
        conversation.sourceChannel,
      );
      if (!sourceChannel) throw notFound();

      const policy = await tx.representativeMemoryPolicy.findUnique({
        where: { representativeId: actor.representativeId },
      });
      const channelRecallEnabled = sourceChannel
          === RepresentativeChannelKind.WEB
        ? policy?.webRecallEnabled
        : sourceChannel === RepresentativeChannelKind.MATRIX
          ? policy?.matrixRecallEnabled
          : policy?.telegramRecallEnabled;

      let items: OperatorConversationMemoryContext["items"] = [];
      if (policy?.longTermMemoryEnabled && channelRecallEnabled) {
        const memories = await tx.governedMemory.findMany({
          where: {
            representativeId: actor.representativeId,
            status: GovernedMemoryStatus.ACTIVE,
            recallDisabledAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            AND: [
              {
                OR: [
                  {
                    scope: MemoryScope.CONTACT_CHANNEL,
                    contactId: conversation.contactId,
                    sourceChannel,
                  },
                  {
                    scope: MemoryScope.REPRESENTATIVE,
                    contactId: null,
                    sourceChannel: null,
                  },
                ],
              },
            ],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 20,
          select: {
            scope: true,
            category: true,
            currentVersion: { select: { summary: true, purgedAt: true } },
          },
        });
        items = memories.flatMap((memory) => {
          if (
            (memory.scope === MemoryScope.CONTACT_CHANNEL
              && !policy.contactMemoryEnabled)
            || (memory.scope === MemoryScope.REPRESENTATIVE
              && !policy.representativeExperienceEnabled)
          ) {
            return [];
          }
          const summary = memory.currentVersion?.purgedAt
            ? null
            : memory.currentVersion?.summary?.trim();
          return summary
            ? [{
                kind:
                  memory.scope === MemoryScope.CONTACT_CHANNEL
                    ? "contact_memory" as const
                    : "representative_experience" as const,
                category: memory.category,
                summary,
              }]
            : [];
        });
      }

      if (actor.role === "OPERATOR") {
        const stillAssigned = await tx.conversation.findFirst({
          where: {
            id: conversation.id,
            representativeId: actor.representativeId,
            assignedOperatorId: actor.actorOwnerId,
            assignments: {
              some: {
                operatorId: actor.actorOwnerId,
                status: "ACTIVE",
              },
            },
          },
          select: { id: true },
        });
        if (!stillAssigned) throw notFound();
      }

      return {
        representativeId: actor.representativeId,
        conversationId,
        contactId: conversation.contactId,
        sourceChannel: sourceChannel.toLowerCase() as
          | "web"
          | "matrix"
          | "telegram",
        items,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

async function reviewCandidateTerminal(
  input: MemoryGovernanceCommandMetadata & { candidateId: string },
  transition: {
    action: "reject_candidate" | "block_candidate";
    eventType:
      | typeof EventType.MEMORY_CANDIDATE_REJECTED
      | typeof EventType.MEMORY_CANDIDATE_BLOCKED;
    outcome:
      | typeof MemoryReviewOutcome.REJECTED
      | typeof MemoryReviewOutcome.BLOCKED;
    status:
      | typeof MemoryCandidateStatus.REJECTED
      | typeof MemoryCandidateStatus.BLOCKED;
  },
  options: MemoryGovernanceOptions,
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const candidateId = requiredText(input.candidateId, "candidateId");
  const requestHash = hashRequest([transition.action, command, candidateId]);
  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertReviewActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      transition.eventType,
      requestHash,
    );
    if (replay) return replay;

    await lockCandidate(tx, candidateId, actor.representativeId);
    const candidate = await tx.memoryCandidate.findFirst({
      where: { id: candidateId, representativeId: actor.representativeId },
    });
    if (!candidate) throw notFound();
    assertExpectedUpdatedAt(candidate.updatedAt, command.expectedUpdatedAt);
    if (candidate.status !== MemoryCandidateStatus.PENDING_REVIEW) {
      throw new MemoryGovernanceError(
        "memory_candidate_not_reviewable",
        "Memory candidate is no longer pending review.",
        409,
      );
    }
    await tx.memoryReviewDecision.create({
      data: {
        representativeId: actor.representativeId,
        candidateId: candidate.id,
        outcome: transition.outcome,
        reviewerRole: actor.reviewerRole!,
        reviewerActorId: actor.actorOwnerId,
        reasonCode: command.reasonCode,
        note: command.note,
      },
    });
    const terminal = await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status: transition.status,
        reviewedAt: occurredAt,
        safeText: null,
        summary: null,
        contentPurgedAt: occurredAt,
      },
      select: { id: true, status: true, updatedAt: true },
    });
    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action: transition.action,
      candidateId: terminal.id,
      status: terminal.status,
      updatedAt: terminal.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: transition.eventType,
      result,
    });
    return result;
  });
}

async function changeMemoryStatus(
  input: MemoryGovernanceCommandMetadata & { memoryId: string },
  action: "suppress_memory" | "archive_memory" | "restore_memory",
  options: MemoryGovernanceOptions,
): Promise<MemoryGovernanceMutationResult> {
  const command = validateCommand(input);
  const memoryId = requiredText(input.memoryId, "memoryId");
  const requestHash = hashRequest([action, command, memoryId]);
  return runGovernanceTransaction(options, async (tx, occurredAt) => {
    const actor = await resolveMemoryActor(
      tx,
      command.actorOwnerId,
      command.representativeSlug,
    );
    assertFullGovernanceActor(actor);
    const replay = await findMutationReplay(
      tx,
      actor,
      command.idempotencyKey,
      EventType.MEMORY_STATUS_CHANGED,
      requestHash,
    );
    if (replay) return replay;

    await lockMemory(tx, memoryId, actor.representativeId);
    let memory = await tx.governedMemory.findFirst({
      where: { id: memoryId, representativeId: actor.representativeId },
      include: {
        currentVersion: {
          include: { sourceCandidate: { include: sourceCandidateInclude } },
        },
      },
    });
    if (!memory) throw notFound();
    assertExpectedUpdatedAt(memory.updatedAt, command.expectedUpdatedAt);
    if (
      memory.status === GovernedMemoryStatus.DELETE_PENDING
      || memory.status === GovernedMemoryStatus.DELETED
    ) {
      throw stateConflict("Deleting or deleted memory cannot change status.");
    }

    if (action === "suppress_memory") {
      if (memory.status !== GovernedMemoryStatus.ACTIVE) {
        throw stateConflict("Only active memory can be suppressed.");
      }
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: occurredAt,
          suppressedAt: occurredAt,
        },
        include: {
          currentVersion: {
            include: { sourceCandidate: { include: sourceCandidateInclude } },
          },
        },
      });
    } else if (action === "archive_memory") {
      if (!new Set<GovernedMemoryStatus>([
        GovernedMemoryStatus.ACTIVE,
        GovernedMemoryStatus.SUPPRESSED,
        GovernedMemoryStatus.SUPERSEDED,
        GovernedMemoryStatus.EXPIRED,
      ]).has(memory.status)) {
        throw stateConflict("Memory cannot be archived from its current state.");
      }
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.ARCHIVED,
          recallDisabledAt: memory.recallDisabledAt ?? occurredAt,
          archivedAt: occurredAt,
        },
        include: {
          currentVersion: {
            include: { sourceCandidate: { include: sourceCandidateInclude } },
          },
        },
      });
    } else {
      if (
        (
          memory.status !== GovernedMemoryStatus.SUPPRESSED
          && memory.status !== GovernedMemoryStatus.ARCHIVED
        )
        || !memory.currentVersion?.sourceCandidate
      ) {
        throw stateConflict("Only suppressed or archived current memory can be restored.");
      }
      await lockPendingCorrectionCandidates(
        tx,
        memory.id,
        actor.representativeId,
      );
      const pendingCorrection = await tx.memoryCandidate.findFirst({
        where: {
          representativeId: actor.representativeId,
          correctionMemoryId: memory.id,
          status: MemoryCandidateStatus.PENDING_REVIEW,
        },
        select: { id: true },
      });
      if (pendingCorrection) {
        throw stateConflict(
          "Memory cannot be restored while a correction is pending review.",
        );
      }
      if (
        memory.currentVersion.sourceCandidate.status
        !== MemoryCandidateStatus.APPROVED
      ) {
        throw stateConflict("The current memory version is no longer approved.");
      }
      assertFreshApprovalSafety(memory.currentVersion.sourceCandidate);
      if (memory.status === GovernedMemoryStatus.ARCHIVED) {
        memory = await tx.governedMemory.update({
          where: { id: memory.id },
          data: {
            status: GovernedMemoryStatus.SUPPRESSED,
            recallDisabledAt: memory.recallDisabledAt ?? occurredAt,
            suppressedAt: occurredAt,
          },
          include: {
            currentVersion: {
              include: { sourceCandidate: { include: sourceCandidateInclude } },
            },
          },
        });
      }
      memory = await tx.governedMemory.update({
        where: { id: memory.id },
        data: {
          status: GovernedMemoryStatus.ACTIVE,
          recallDisabledAt: null,
        },
        include: {
          currentVersion: {
            include: { sourceCandidate: { include: sourceCandidateInclude } },
          },
        },
      });
    }

    const result: MemoryGovernanceMutationResult = {
      replayed: false,
      representativeId: actor.representativeId,
      action,
      memoryId: memory.id,
      ...(memory.currentVersionId
        ? { memoryVersionId: memory.currentVersionId }
        : {}),
      status: memory.status,
      memoryStatus: memory.status,
      updatedAt: memory.updatedAt.toISOString(),
    };
    await createGovernanceAudit(tx, {
      actor,
      command,
      requestHash,
      type: EventType.MEMORY_STATUS_CHANGED,
      result,
    });
    return result;
  });
}

async function runGovernanceTransaction<T>(
  options: MemoryGovernanceOptions,
  operation: (
    tx: MemoryGovernanceTransaction,
    occurredAt: Date,
  ) => Promise<T>,
): Promise<T> {
  const client = options.client ?? prisma;
  try {
    return await runWithPrismaWriteConflictRetry(
      () => client.$transaction(
        (tx) => operation(tx, (options.now ?? (() => new Date()))()),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
      { additionalRetryableCodes: ["P2002"] },
    );
  } catch (error) {
    if (error instanceof MemoryGovernanceError) throw error;
    const code = prismaErrorCode(error);
    if (code === "P2034") {
      throw new MemoryGovernanceError(
        "memory_write_conflict",
        "The memory changed concurrently. Retry with its latest version.",
        409,
      );
    }
    if (code === "P2002" || code === "P2004" || code === "P2010") {
      throw stateConflict("The memory governance request conflicts with current state.");
    }
    if (code === "P2025") throw notFound();
    throw error;
  }
}

async function resolveMemoryActor(
  tx: MemoryGovernanceTransaction,
  actorOwnerId: string,
  representativeSlug: string,
): Promise<ResolvedMemoryActor> {
  const representative = await tx.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      ownerId: true,
      owner: { select: { organizationId: true } },
    },
  });
  if (!representative) throw notFound();
  if (representative.ownerId === actorOwnerId) {
    return {
      actorOwnerId,
      representativeId: representative.id,
      representativeOwnerId: representative.ownerId,
      role: "OWNER",
      reviewerRole: MemoryReviewerRole.OWNER,
    };
  }
  const actor = await tx.owner.findUnique({
    where: { id: actorOwnerId },
    select: {
      organizationId: true,
      organizationMember: {
        select: { organizationId: true, role: true },
      },
    },
  });
  const organizationId = representative.owner.organizationId;
  if (
    !organizationId
    || actor?.organizationId !== organizationId
    || actor.organizationMember?.organizationId !== organizationId
  ) {
    throw notFound();
  }
  return actorFromOrganizationRole(
    actorOwnerId,
    representative.id,
    representative.ownerId,
    actor.organizationMember.role,
  );
}

function actorFromOrganizationRole(
  actorOwnerId: string,
  representativeId: string,
  representativeOwnerId: string,
  role: OrganizationMemberRole,
): ResolvedMemoryActor {
  if (role === "OWNER") {
    return {
      actorOwnerId,
      representativeId,
      representativeOwnerId,
      role: "OWNER",
      reviewerRole: MemoryReviewerRole.OWNER,
    };
  }
  if (role === "ADMIN") {
    return {
      actorOwnerId,
      representativeId,
      representativeOwnerId,
      role: "ADMIN",
      reviewerRole: MemoryReviewerRole.ADMIN,
    };
  }
  if (role === "APPROVER") {
    return {
      actorOwnerId,
      representativeId,
      representativeOwnerId,
      role: "REVIEWER",
      reviewerRole: MemoryReviewerRole.REVIEWER,
    };
  }
  return {
    actorOwnerId,
    representativeId,
    representativeOwnerId,
    role: "OPERATOR",
    reviewerRole: null,
  };
}

function assertReviewActor(actor: ResolvedMemoryActor) {
  if (!actor.reviewerRole || actor.role === "OPERATOR") {
    throw forbidden("This role cannot review memory candidates.");
  }
}

function assertFullGovernanceActor(actor: ResolvedMemoryActor) {
  if (actor.role !== "OWNER" && actor.role !== "ADMIN") {
    throw forbidden("This role cannot manage governed memory.");
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
} as const;

async function loadCandidateForReview(
  tx: MemoryGovernanceTransaction,
  candidateId: string,
  representativeId: string,
) {
  const candidate = await tx.memoryCandidate.findFirst({
    where: { id: candidateId, representativeId },
    include: sourceCandidateInclude,
  });
  if (!candidate) throw notFound();
  return candidate;
}

async function loadMemoryForCorrection(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  representativeId: string,
) {
  const memory = await tx.governedMemory.findFirst({
    where: { id: memoryId, representativeId },
    include: {
      currentVersion: {
        include: { sourceCandidate: { include: sourceCandidateInclude } },
      },
    },
  });
  if (!memory) throw notFound();
  return memory;
}

function assertPendingReviewCandidate(
  candidate: Awaited<ReturnType<typeof loadCandidateForReview>>,
  occurredAt: Date,
) {
  if (candidate.status !== MemoryCandidateStatus.PENDING_REVIEW) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_reviewable",
      "Memory candidate is no longer pending review.",
      409,
    );
  }
  if (candidate.expiresAt && candidate.expiresAt <= occurredAt) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_reviewable",
      "Expired memory candidate cannot be approved.",
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
      candidate.scope === MemoryScope.REPRESENTATIVE
      && !candidate.deidentifiedAt
    )
  ) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_reviewable",
      "Memory candidate no longer has a complete safe review payload.",
      409,
    );
  }
}

function assertFreshApprovalSafety(
  candidate: Awaited<ReturnType<typeof loadCandidateForReview>>,
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

  if (candidate.sourceKind === MemorySourceKind.OWNER_VERIFIED_CORRECTION) {
    if (candidate.scope === MemoryScope.CONTACT_CHANNEL) {
      if (
        candidate.category !== MemoryCategory.CONTACT_PREFERENCE
        || !parseCanonicalContactPreference(candidate.safeText)
        || candidate.summary !== candidate.safeText
      ) {
        throw safetyRejected();
      }
    } else if (!matchesRepresentativePattern(candidate)) {
      throw safetyRejected();
    }
    return;
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

function validateCorrectionRequest(input: {
  preferenceField?: ContactMemoryPreferenceField;
  preferenceValue?: string;
  representativePatternCode?: RepresentativeMemoryPatternCode;
}) {
  const hasPreference = input.preferenceField !== undefined
    || input.preferenceValue !== undefined;
  const hasPattern = input.representativePatternCode !== undefined;
  if (hasPreference === hasPattern) {
    throw invalidInput(
      "Provide either preferenceField/preferenceValue or representativePatternCode.",
    );
  }
  if (hasPattern) {
    const code = requiredText(
      input.representativePatternCode,
      "representativePatternCode",
      maximumReasonCodeLength,
    ) as RepresentativeMemoryPatternCode;
    if (!(code in representativePatterns)) {
      throw invalidInput("Unsupported representativePatternCode.");
    }
    return { kind: "representative" as const, code };
  }
  const field = input.preferenceField;
  if (!field || !(field in contactPreferenceValues)) {
    throw invalidInput("Unsupported preferenceField.");
  }
  const value = requiredText(
    input.preferenceValue,
    "preferenceValue",
    32,
  ).toLowerCase();
  if (!contactPreferenceValues[field].has(value)) {
    throw invalidInput("Unsupported preferenceValue for preferenceField.");
  }
  return { kind: "contact" as const, field, value };
}

function buildCorrectionPayload(
  memory: Awaited<ReturnType<typeof loadMemoryForCorrection>>,
  request: ReturnType<typeof validateCorrectionRequest>,
) {
  if (request.kind === "contact") {
    if (
      memory.scope !== MemoryScope.CONTACT_CHANNEL
      || memory.category !== MemoryCategory.CONTACT_PREFERENCE
      || !memory.currentVersion?.safeText
    ) {
      throw new MemoryGovernanceError(
        "memory_candidate_not_reviewable",
        "P0 corrections support only canonical contact preferences.",
        409,
      );
    }
    const existing = parseCanonicalContactPreference(memory.currentVersion.safeText);
    if (!existing || !(request.field in existing)) {
      throw new MemoryGovernanceError(
        "memory_candidate_not_reviewable",
        "A correction may only change an existing canonical preference field.",
        409,
      );
    }
    const corrected = { ...existing, [request.field]: request.value };
    const safeText = serializeCanonicalContactPreference(corrected);
    if (!safeText) throw safetyRejected();
    if (safeText === memory.currentVersion.safeText) {
      throw stateConflict("The correction does not change the current memory.");
    }
    return {
      safeText,
      summary: safeText,
      extractionReasonCode: "owner_verified_contact_preference_correction",
    };
  }

  if (memory.scope !== MemoryScope.REPRESENTATIVE) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_reviewable",
      "Representative pattern correction requires representative experience.",
      409,
    );
  }
  const pattern = representativePatterns[request.code];
  if (pattern.category !== memory.category) {
    throw new MemoryGovernanceError(
      "memory_candidate_not_reviewable",
      "The controlled pattern does not match this memory category.",
      409,
    );
  }
  return pattern;
}

function parseCanonicalContactPreference(safeText: string) {
  if (!safeText.startsWith("Preference: ")) return null;
  const entries = safeText.slice("Preference: ".length).split("; ");
  if (entries.length < 1 || entries.length > 2) return null;
  const result: Partial<Record<ContactMemoryPreferenceField, string>> = {};
  for (const entry of entries) {
    const [field, value, ...tail] = entry.split("=");
    if (
      tail.length
      || !field
      || !value
      || !(field in contactPreferenceValues)
      || !contactPreferenceValues[field as ContactMemoryPreferenceField].has(value)
      || result[field as ContactMemoryPreferenceField] !== undefined
    ) {
      return null;
    }
    result[field as ContactMemoryPreferenceField] = value;
  }
  return serializeCanonicalContactPreference(result) === safeText ? result : null;
}

function serializeCanonicalContactPreference(
  preference: Partial<Record<ContactMemoryPreferenceField, string>>,
) {
  const fields = Object.keys(preference) as ContactMemoryPreferenceField[];
  if (fields.length === 1) {
    const field = fields[0]!;
    const value = preference[field]!;
    return contactPreferenceValues[field].has(value)
      ? `Preference: ${field}=${value}`
      : null;
  }
  if (
    fields.length === 2
    && preference.reply_length === "concise"
    && ["zh", "en"].includes(preference.reply_language ?? "")
    && fields.every((field) =>
      field === "reply_length" || field === "reply_language")
  ) {
    return `Preference: reply_length=concise; reply_language=${preference.reply_language}`;
  }
  return null;
}

function matchesRepresentativePattern(candidate: {
  category: MemoryCategory;
  safeText: string | null;
  summary: string | null;
}) {
  return Object.values(representativePatterns).some(
    (pattern) => pattern.category === candidate.category
      && pattern.safeText === candidate.safeText
      && pattern.summary === candidate.summary,
  );
}

function policyAllowsCandidate(
  policy: {
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
    representativeExperienceEnabled: boolean;
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  } | null,
  candidate: {
    scope: MemoryScope;
    scopeChannel: RepresentativeChannelKind | null;
  },
) {
  if (!policy?.longTermMemoryEnabled) return false;
  if (candidate.scope === MemoryScope.REPRESENTATIVE) {
    return policy.representativeExperienceEnabled;
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

function buildCanonicalMemoryProjectionUri(input: {
  namespaceKey: string;
  candidate: {
    scope: MemoryScope;
    contactId: string | null;
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

async function findMutationReplay(
  tx: MemoryGovernanceTransaction,
  actor: ResolvedMemoryActor,
  idempotencyKey: string,
  type: EventType,
  requestHash: string,
) {
  const audit = await tx.eventAudit.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId: actor.actorOwnerId,
        idempotencyKey,
      },
    },
    select: { type: true, requestHash: true, payload: true },
  });
  if (!audit) return null;
  if (audit.type !== type || audit.requestHash !== requestHash) {
    throw new MemoryGovernanceError(
      "memory_idempotency_conflict",
      "This idempotency key belongs to a different memory request.",
      409,
    );
  }
  const result = parseAuditResult(audit.payload);
  if (!result || result.representativeId !== actor.representativeId) {
    throw new MemoryGovernanceError(
      "memory_idempotency_conflict",
      "The memory request replay record is invalid.",
      409,
    );
  }
  return { ...result, replayed: true };
}

async function createGovernanceAudit(
  tx: MemoryGovernanceTransaction,
  input: {
    actor: ResolvedMemoryActor;
    command: ValidatedCommand;
    requestHash: string;
    type: EventType;
    result: MemoryGovernanceMutationResult;
    extraPayload?: Record<string, string | number>;
  },
) {
  await tx.eventAudit.create({
    data: {
      ownerId: input.actor.actorOwnerId,
      representativeId: input.actor.representativeId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: input.requestHash,
      type: input.type,
      payload: {
        requestId: input.command.requestId,
        actorRole: input.actor.role,
        reasonCode: input.command.reasonCode,
        result: auditResult(input.result),
        ...input.extraPayload,
      },
    },
  });
}

function auditResult(result: MemoryGovernanceMutationResult) {
  return {
    representativeId: result.representativeId,
    action: result.action,
    candidateId: result.candidateId ?? null,
    memoryId: result.memoryId ?? null,
    memoryVersionId: result.memoryVersionId ?? null,
    deletionProofId: result.deletionProofId ?? null,
    status: result.status,
    memoryStatus: result.memoryStatus ?? null,
    updatedAt: result.updatedAt,
  };
}

function parseAuditResult(payload: Prisma.JsonValue) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const result = payload.result;
  if (!result || Array.isArray(result) || typeof result !== "object") return null;
  if (
    typeof result.representativeId !== "string"
    || typeof result.action !== "string"
    || typeof result.status !== "string"
    || typeof result.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    replayed: true,
    representativeId: result.representativeId,
    action: result.action as MemoryGovernanceAction,
    ...(typeof result.candidateId === "string"
      ? { candidateId: result.candidateId }
      : {}),
    ...(typeof result.memoryId === "string" ? { memoryId: result.memoryId } : {}),
    ...(typeof result.memoryVersionId === "string"
      ? { memoryVersionId: result.memoryVersionId }
      : {}),
    ...(typeof result.deletionProofId === "string"
      ? { deletionProofId: result.deletionProofId }
      : {}),
    status: result.status,
    ...(typeof result.memoryStatus === "string"
      ? { memoryStatus: result.memoryStatus }
      : {}),
    updatedAt: result.updatedAt,
  } satisfies MemoryGovernanceMutationResult;
}

async function lockCandidate(
  tx: MemoryGovernanceTransaction,
  candidateId: string,
  representativeId: string,
) {
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

async function lockOperatorConversationAccess(
  tx: MemoryGovernanceTransaction,
  conversationId: string,
  representativeId: string,
  actorOwnerId: string,
) {
  // Handoff writers release/transfer the assignment before changing the
  // Conversation pointer. Taking share locks in that same order prevents a
  // getter/writer deadlock and keeps authorization true until commit.
  const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "ConversationAssignment"
    WHERE "conversationId" = ${conversationId}
      AND "operatorId" = ${actorOwnerId}
      AND "status" = 'ACTIVE'::"ConversationAssignmentStatus"
    ORDER BY "id"
    FOR SHARE
  `);
  if (assignments.length === 0) throw notFound();

  const conversations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Conversation"
    WHERE "id" = ${conversationId}
      AND "representativeId" = ${representativeId}
      AND "assignedOperatorId" = ${actorOwnerId}
    FOR SHARE
  `);
  if (conversations.length === 0) throw notFound();
}

async function lockDeletionProof(
  tx: MemoryGovernanceTransaction,
  memoryId: string,
  representativeId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryDeletionProof"
    WHERE "memoryId" = ${memoryId} AND "representativeId" = ${representativeId}
    FOR UPDATE
  `);
}

function validateCommand(input: MemoryGovernanceCommandMetadata): ValidatedCommand {
  return {
    actorOwnerId: requiredText(input.actorOwnerId, "actorOwnerId"),
    representativeSlug: requiredText(
      input.representativeSlug,
      "representativeSlug",
    ),
    requestId: requiredOpaqueToken(input.requestId, "requestId"),
    idempotencyKey: requiredOpaqueToken(
      input.idempotencyKey,
      "idempotencyKey",
    ),
    expectedUpdatedAt: requiredTimestamp(input.expectedUpdatedAt),
    reasonCode: requiredReasonCode(input.reasonCode),
    note: optionalNote(input.note),
  };
}

function requiredOpaqueToken(value: unknown, field: string) {
  if (typeof value !== "string" || !opaqueTokenPattern.test(value)) {
    throw invalidInput(
      `${field} must be an opaque ASCII token containing 1-${maximumOpaqueTokenLength} characters.`,
    );
  }
  return value;
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

function requiredTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidInput("expectedUpdatedAt is required.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidInput("expectedUpdatedAt must be a valid timestamp.");
  }
  return parsed;
}

function requiredReasonCode(value: unknown) {
  const normalized = requiredText(value, "reasonCode", maximumReasonCodeLength);
  if (!reasonCodePattern.test(normalized)) {
    throw invalidInput("reasonCode contains unsupported characters.");
  }
  return normalized;
}

function optionalNote(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidInput("note must be text.");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximumNoteLength) {
    throw invalidInput(`note cannot exceed ${maximumNoteLength} characters.`);
  }
  return normalized;
}

function assertExpectedUpdatedAt(actual: Date, expected: Date) {
  if (actual.getTime() !== expected.getTime()) {
    throw new MemoryGovernanceError(
      "memory_version_conflict",
      "The memory changed since it was loaded.",
      409,
    );
  }
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

function hashRequest(parts: unknown[]) {
  return sha256(JSON.stringify(parts, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  }));
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

function forbidden(message: string) {
  return new MemoryGovernanceError("memory_forbidden", message, 403);
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

function prismaErrorCode(error: unknown) {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}
