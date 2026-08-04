import { createHash } from "node:crypto";

import {
  GovernedMemoryStatus,
  MemoryCandidateStatus,
  MemoryProjectionLane,
  MemoryProjectionStatus,
  MemoryReviewOutcome,
  MemoryReviewerRole,
  MemorySafetyClass,
  MemoryScope,
  MemoryUseRunStatus,
  MemoryUseSourceKind,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

type MemoryUseTransaction = Prisma.TransactionClient;

const maximumOpaqueIdLength = 191;
const maximumSearchHits = 100;
const maximumUnmappedCandidates = 10_000;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u;

export const memoryUseDegradationReasonCodes = [
  "memory_recall_provider_unavailable",
  "memory_recall_partial",
  "memory_recall_source_changed",
  "memory_context_budget_excluded",
] as const;

export const memoryUseFailureReasonCodes = [
  "memory_generation_failed",
  "memory_ledger_failed",
  "memory_output_invalid",
] as const;

export const memoryUseCancellationReasonCodes = [
  "memory_generation_canceled",
  "memory_handoff_canceled",
] as const;

export type MemoryUseDegradationReasonCode =
  (typeof memoryUseDegradationReasonCodes)[number];
export type MemoryUseFailureReasonCode =
  (typeof memoryUseFailureReasonCodes)[number];
export type MemoryUseCancellationReasonCode =
  (typeof memoryUseCancellationReasonCodes)[number];

const degradationReasonCodeSet = new Set<string>(memoryUseDegradationReasonCodes);
const failureReasonCodeSet = new Set<string>(memoryUseFailureReasonCodes);
const cancellationReasonCodeSet = new Set<string>(memoryUseCancellationReasonCodes);

const terminalRunStatuses = new Set<MemoryUseRunStatus>([
  MemoryUseRunStatus.COMPLETED,
  MemoryUseRunStatus.DEGRADED,
  MemoryUseRunStatus.FAILED,
  MemoryUseRunStatus.CANCELED,
]);

export type MemoryUseExecutionOptions = {
  client?: PrismaClient;
  now?: () => Date;
};

export type MemoryUseExecutionErrorCode =
  | "memory_use_invalid_input"
  | "memory_use_generation_not_found"
  | "memory_use_run_not_found"
  | "memory_use_scope_conflict"
  | "memory_use_state_conflict"
  | "memory_use_output_not_ready"
  | "memory_use_source_rejected";

export class MemoryUseExecutionError extends Error {
  constructor(
    readonly code: MemoryUseExecutionErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "MemoryUseExecutionError";
  }
}

export type MemoryUseRunSnapshot = {
  id: string;
  generationRunId: string;
  representativeId: string;
  conversationId: string;
  contactId: string;
  sourceChannel: RepresentativeChannelKind;
  representativeVersionId: string;
  inputMessageId: string;
  outputMessageId: string | null;
  status: MemoryUseRunStatus;
  reasonCode: string | null;
  searchedCount: number;
  scopePassedCount: number;
  safetyPassedCount: number;
  injectedCount: number;
  citedCount: number;
  displayedCount: number;
  unmappedCandidateCount: number;
  startedAt: Date;
  completedAt: Date | null;
};

export type StartOrReuseMemoryUseRunInput = {
  generationRunId: string;
  sourceChannel: RepresentativeChannelKind | "web" | "matrix" | "telegram";
};

export type GovernedMemorySearchHit = {
  sourceKind:
    | typeof MemoryUseSourceKind.CONTACT_MEMORY
    | typeof MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE;
  projectionItemId: string;
  searchRank?: number;
  searchScore?: number;
};

export type PublicKnowledgeSearchHit = {
  sourceKind: typeof MemoryUseSourceKind.PUBLIC_KNOWLEDGE;
  publicKnowledgeProjectionId: string;
  searchRank?: number;
  searchScore?: number;
};

export type MemoryUseSearchHit =
  | GovernedMemorySearchHit
  | PublicKnowledgeSearchHit;

export type RecordMemoryUseSearchHitsInput = {
  useRunId: string;
  hits: MemoryUseSearchHit[];
  /**
   * Absolute cumulative count observed by the caller, not a delta. Keeping
   * this value monotonic makes a retried search batch idempotent without ever
   * persisting an unknown source identifier.
   */
  observedUnmappedCandidateCount?: number;
};

export type RecordMemoryUseSearchHitsResult = {
  run: MemoryUseRunSnapshot;
  /** Server-internal mapping coordinates; never expose through public DTOs. */
  eligibleItems: Array<
    | {
        memoryUseItemId: string;
        sourceKind:
          | typeof MemoryUseSourceKind.CONTACT_MEMORY
          | typeof MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE;
        projectionItemId: string;
      }
    | {
        memoryUseItemId: string;
        sourceKind: typeof MemoryUseSourceKind.PUBLIC_KNOWLEDGE;
        publicKnowledgeProjectionId: string;
      }
  >;
  anonymousRejectedCount: number;
};

export type FinalizeMemoryUseGenerationInput = {
  useRunId: string;
  outputMessageId: string;
  injectedItemIds: string[];
  citedItemIds: string[];
};

export type FinalizeMemoryUseGenerationResult = {
  run: MemoryUseRunSnapshot;
  deliveryReadyCitations: Array<{
    memoryUseItemId: string;
    sourceKind: MemoryUseSourceKind;
  }>;
};

export type MarkMemoryUseItemsDisplayedInput = {
  useRunId: string;
  displayedItemIds: string[];
};

export async function startOrReuseMemoryUseRun(
  input: StartOrReuseMemoryUseRunInput,
  options: MemoryUseExecutionOptions = {},
): Promise<{ replayed: boolean; run: MemoryUseRunSnapshot }> {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      startOrReuseMemoryUseRunInTransaction(tx, input, options.now?.() ?? new Date()),
    ),
  );
}

export async function startOrReuseMemoryUseRunInTransaction(
  tx: MemoryUseTransaction,
  input: StartOrReuseMemoryUseRunInput,
  occurredAt = new Date(),
): Promise<{ replayed: boolean; run: MemoryUseRunSnapshot }> {
  const generationRunId = requiredOpaqueId(input.generationRunId, "generationRunId");
  const sourceChannel = normalizeSourceChannel(input.sourceChannel);

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${generationRunId}))`;
  const generation = await tx.generationRun.findUnique({
    where: { id: generationRunId },
    select: {
      id: true,
      conversationId: true,
      inputMessageId: true,
      representativeVersionId: true,
      conversation: {
        select: {
          representativeId: true,
          contactId: true,
          sourceChannel: true,
          representative: { select: { activeVersionId: true } },
        },
      },
      inputMessage: {
        select: {
          id: true,
          conversationId: true,
          channelBinding: { select: { kind: true } },
        },
      },
      representativeVersion: {
        select: { id: true, representativeId: true, status: true },
      },
    },
  });
  if (!generation) {
    throw new MemoryUseExecutionError(
      "memory_use_generation_not_found",
      "Generation run was not found.",
      404,
    );
  }

  const representativeVersionId = generation.representativeVersionId;
  const generationChannel = resolveGenerationChannel(generation);
  if (
    !representativeVersionId
    || !generation.representativeVersion
    || generation.representativeVersion.id !== representativeVersionId
    || generation.representativeVersion.representativeId
      !== generation.conversation.representativeId
    || generation.representativeVersion.status !== "PUBLISHED"
    || generation.conversation.representative.activeVersionId
      !== representativeVersionId
    || generation.inputMessage.id !== generation.inputMessageId
    || generation.inputMessage.conversationId !== generation.conversationId
    || generationChannel !== sourceChannel
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_scope_conflict",
      "Generation run is not pinned to the current representative, conversation, message, and channel scope.",
      409,
    );
  }

  const existing = await tx.memoryUseRun.findFirst({
    where: { generationRunId },
    select: memoryUseRunSnapshotSelect,
  });
  if (existing) {
    assertRunCoordinates(existing, {
      generationRunId,
      representativeId: generation.conversation.representativeId,
      conversationId: generation.conversationId,
      contactId: generation.conversation.contactId,
      sourceChannel,
      representativeVersionId,
      inputMessageId: generation.inputMessageId,
    });
    return { replayed: true, run: toRunSnapshot(existing) };
  }

  const created = await tx.memoryUseRun.create({
    data: {
      generationRunId,
      representativeId: generation.conversation.representativeId,
      conversationId: generation.conversationId,
      contactId: generation.conversation.contactId,
      sourceChannel,
      representativeVersionId,
      inputMessageId: generation.inputMessageId,
      idempotencyKey: `generation:${generationRunId}`,
      startedAt: occurredAt,
    },
    select: memoryUseRunSnapshotSelect,
  });
  return { replayed: false, run: toRunSnapshot(created) };
}

export async function recordMemoryUseSearchHits(
  input: RecordMemoryUseSearchHitsInput,
  options: MemoryUseExecutionOptions = {},
): Promise<RecordMemoryUseSearchHitsResult> {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      recordMemoryUseSearchHitsInTransaction(tx, input, options.now?.() ?? new Date()),
    ),
  );
}

export async function recordMemoryUseSearchHitsInTransaction(
  tx: MemoryUseTransaction,
  input: RecordMemoryUseSearchHitsInput,
  occurredAt = new Date(),
): Promise<RecordMemoryUseSearchHitsResult> {
  const useRunId = requiredOpaqueId(input.useRunId, "useRunId");
  const hits = validateSearchHits(input.hits);
  const observedUnmappedCandidateCount = boundedInteger(
    input.observedUnmappedCandidateCount ?? 0,
    "observedUnmappedCandidateCount",
    0,
    maximumUnmappedCandidates,
  );
  const run = await lockAndLoadRun(tx, useRunId);
  assertRunOpen(run);
  await assertRunStillCurrent(tx, run);

  const governedIds = hits
    .filter((hit): hit is GovernedMemorySearchHit =>
      hit.sourceKind !== MemoryUseSourceKind.PUBLIC_KNOWLEDGE)
    .map((hit) => hit.projectionItemId);
  const publicIds = hits
    .filter((hit): hit is PublicKnowledgeSearchHit =>
      hit.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE)
    .map((hit) => hit.publicKnowledgeProjectionId);

  const [governedRows, publicRows, policy] = await Promise.all([
    loadGovernedProjectionSources(tx, governedIds),
    loadPublicProjectionSources(tx, publicIds),
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: run.representativeId },
      select: {
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: true,
        webRecallEnabled: true,
        matrixRecallEnabled: true,
        telegramRecallEnabled: true,
      },
    }),
  ]);
  const governedById = new Map(governedRows.map((row) => [row.id, row]));
  const publicById = new Map(publicRows.map((row) => [row.id, row]));
  let anonymousRejectedCount = 0;
  const eligibleItems: RecordMemoryUseSearchHitsResult["eligibleItems"] = [];

  for (const hit of hits) {
    if (hit.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE) {
      const source = publicById.get(hit.publicKnowledgeProjectionId);
      if (!source || !publicSourceMatchesRun(source, run)) {
        anonymousRejectedCount += 1;
        continue;
      }
      const item = await upsertSearchItem(tx, {
        run,
        itemKey: searchItemKey(hit.sourceKind, source.id),
        sourceKind: hit.sourceKind,
        publicKnowledgeProjectionId: source.id,
        contentHash: source.contentHash,
        searchRank: hit.searchRank ?? null,
        searchScore: hit.searchScore ?? null,
        scopePassed: true,
        safetyPassed: true,
        rejectionReasonCode: null,
        occurredAt,
      });
      if (item.safetyPassedAt) {
        eligibleItems.push({
          memoryUseItemId: item.id,
          sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
          publicKnowledgeProjectionId: source.id,
        });
      }
      continue;
    }

    const source = governedById.get(hit.projectionItemId);
    if (!source || !governedSourceMatchesScope(source, run, hit.sourceKind)) {
      anonymousRejectedCount += 1;
      continue;
    }
    const safety = governedSourceSafety(source, run, policy, occurredAt);
    const item = await upsertSearchItem(tx, {
      run,
      itemKey: searchItemKey(hit.sourceKind, source.id),
      sourceKind: hit.sourceKind,
      memoryScope: source.memoryVersion.scope,
      memoryVersionId: source.memoryVersion.id,
      projectionItemId: source.id,
      contentHash: source.contentHash,
      searchRank: hit.searchRank ?? null,
      searchScore: hit.searchScore ?? null,
      scopePassed: true,
      safetyPassed: safety.passed,
      rejectionReasonCode: safety.reasonCode,
      occurredAt,
    });
    if (item.safetyPassedAt) {
      eligibleItems.push({
        memoryUseItemId: item.id,
        sourceKind: hit.sourceKind,
        projectionItemId: source.id,
      });
    }
  }

  const nextUnmappedCount = Math.max(
    run.unmappedCandidateCount,
    observedUnmappedCandidateCount,
    anonymousRejectedCount,
  );
  if (nextUnmappedCount !== run.unmappedCandidateCount) {
    await tx.memoryUseUnmappedObservation.createMany({
      data: [{
        useRunId: run.id,
        representativeId: run.representativeId,
        observationKey: createHash("sha256")
          .update(`unmapped:${nextUnmappedCount}`)
          .digest("hex"),
        candidateCount: nextUnmappedCount,
        createdAt: occurredAt,
      }],
      skipDuplicates: true,
    });
  }

  return {
    run: await loadRunSnapshot(tx, run.id),
    eligibleItems,
    anonymousRejectedCount,
  };
}

export async function finalizeMemoryUseGeneration(
  input: FinalizeMemoryUseGenerationInput,
  options: MemoryUseExecutionOptions = {},
): Promise<FinalizeMemoryUseGenerationResult> {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      finalizeMemoryUseGenerationInTransaction(tx, input, options.now?.() ?? new Date()),
    ),
  );
}

/**
 * Intended for conversation-platform after it creates the output Message and
 * binds GenerationRun.outputMessageId on the same Prisma transaction. This
 * helper derives and creates MessageCitation rows itself. Any validation
 * failure rolls all of those writes back together with the use-ledger stages.
 */
export async function finalizeMemoryUseGenerationInTransaction(
  tx: MemoryUseTransaction,
  input: FinalizeMemoryUseGenerationInput,
  occurredAt = new Date(),
): Promise<FinalizeMemoryUseGenerationResult> {
  const useRunId = requiredOpaqueId(input.useRunId, "useRunId");
  const outputMessageId = requiredOpaqueId(input.outputMessageId, "outputMessageId");
  const injectedItemIds = uniqueOpaqueIds(input.injectedItemIds, "injectedItemIds");
  const citedItemIds = uniqueOpaqueIds(input.citedItemIds, "citedItemIds");
  const injectedSet = new Set(injectedItemIds);
  if (citedItemIds.some((id) => !injectedSet.has(id))) {
    throw invalidInput("Every cited item must also be injected.");
  }

  const run = await lockAndLoadRun(tx, useRunId);
  if (run.status === MemoryUseRunStatus.COMPLETED) {
    return replayCompletedFinalization(tx, run, {
      outputMessageId,
      injectedItemIds,
      citedItemIds,
    });
  }
  assertRunOpen(run);
  await assertRunStillCurrent(tx, run);

  const outputMessage = await tx.message.findUnique({
    where: { id: outputMessageId },
    select: {
      id: true,
      conversationId: true,
      senderType: true,
      deliveryStatus: true,
    },
  });
  if (
    !outputMessage
    || outputMessage.conversationId !== run.conversationId
    || outputMessage.senderType !== MessageSenderType.REPRESENTATIVE
    || new Set<MessageDeliveryStatus>([
      MessageDeliveryStatus.ACCEPTED,
      MessageDeliveryStatus.QUEUED,
      MessageDeliveryStatus.PROCESSING,
      MessageDeliveryStatus.SENT,
    ]).has(outputMessage.deliveryStatus) === false
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_output_not_ready",
      "Output message is not a deliverable representative reply in this conversation.",
      409,
    );
  }

  const items = await loadItemsForFinalization(tx, run.id, injectedItemIds);
  if (
    items.length !== injectedItemIds.length
    || items.some((item) =>
      !item.safetyPassedAt
      || item.rejectionReasonCode
      || item.injectedAt
      || item.citedAt
      || item.citationId)
  ) {
    throw rejectedSource();
  }
  for (const item of items) {
    await assertItemStillInjectable(tx, run, item, occurredAt);
  }

  await tx.memoryUseRun.update({
    where: { id: run.id },
    data: { outputMessageId },
  });
  if (injectedItemIds.length) {
    const injected = await tx.memoryUseItem.updateMany({
      where: {
        useRunId: run.id,
        id: { in: injectedItemIds },
        injectedAt: null,
      },
      data: { injectedAt: occurredAt },
    });
    if (injected.count !== injectedItemIds.length) throw rejectedSource();
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  for (const citedItemId of citedItemIds) {
    const item = itemById.get(citedItemId);
    if (!item) throw rejectedSource();
    const citationId = await createAuthoritativeCitation(
      tx,
      run,
      item,
      outputMessageId,
    );
    await tx.memoryUseItem.update({
      where: { id: citedItemId },
      data: {
        citedAt: occurredAt,
        citationId,
      },
    });
  }
  await tx.memoryUseRun.update({
    where: { id: run.id },
    data: {
      status: run.reasonCode
        ? MemoryUseRunStatus.DEGRADED
        : MemoryUseRunStatus.COMPLETED,
      completedAt: occurredAt,
    },
  });

  const sourceById = new Map(items.map((item) => [item.id, item.sourceKind]));
  return {
    run: await loadRunSnapshot(tx, run.id),
    deliveryReadyCitations: citedItemIds.map((memoryUseItemId) => ({
      memoryUseItemId,
      sourceKind: sourceById.get(memoryUseItemId)!,
    })),
  };
}

export async function markMemoryUseItemsDisplayed(
  input: MarkMemoryUseItemsDisplayedInput,
  options: MemoryUseExecutionOptions = {},
): Promise<MemoryUseRunSnapshot> {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      markMemoryUseItemsDisplayedInTransaction(tx, input, options.now?.() ?? new Date()),
    ),
  );
}

export async function markMemoryUseItemsDisplayedInTransaction(
  tx: MemoryUseTransaction,
  input: MarkMemoryUseItemsDisplayedInput,
  occurredAt = new Date(),
): Promise<MemoryUseRunSnapshot> {
  const useRunId = requiredOpaqueId(input.useRunId, "useRunId");
  const displayedItemIds = uniqueOpaqueIds(
    input.displayedItemIds,
    "displayedItemIds",
  );
  const run = await lockAndLoadRun(tx, useRunId);
  if (
    !new Set<MemoryUseRunStatus>([
      MemoryUseRunStatus.COMPLETED,
      MemoryUseRunStatus.DEGRADED,
    ]).has(run.status)
    || run.sourceChannel !== RepresentativeChannelKind.WEB
    || !run.outputMessageId
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_state_conflict",
      "Only finalized Web replies can mark cited sources as displayed.",
      409,
    );
  }
  const output = await tx.message.findUnique({
    where: { id: run.outputMessageId },
    select: { conversationId: true, deliveryStatus: true },
  });
  if (
    !output
    || output.conversationId !== run.conversationId
    || output.deliveryStatus !== MessageDeliveryStatus.SENT
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_output_not_ready",
      "Web output has not been successfully delivered.",
      409,
    );
  }
  if (displayedItemIds.length) {
    const items = await tx.memoryUseItem.findMany({
      where: { useRunId: run.id, id: { in: displayedItemIds } },
      select: { id: true, citedAt: true, citationId: true },
    });
    if (
      items.length !== displayedItemIds.length
      || items.some((item) => !item.citedAt || !item.citationId)
    ) {
      throw new MemoryUseExecutionError(
        "memory_use_state_conflict",
        "Displayed items must be cited by the completed output.",
        409,
      );
    }
    await tx.memoryUseItem.updateMany({
      where: {
        useRunId: run.id,
        id: { in: displayedItemIds },
        displayedAt: null,
      },
      data: { displayedAt: occurredAt },
    });
  }
  return loadRunSnapshot(tx, run.id);
}

export async function markMemoryUseRunDegraded(
  useRunId: string,
  reasonCode: MemoryUseDegradationReasonCode,
  options: MemoryUseExecutionOptions = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      markMemoryUseRunDegradedInTransaction(tx, useRunId, reasonCode),
    ),
  );
}

/** @deprecated Prefer markMemoryUseRunDegraded with an explicit stable reason. */
export async function degradeMemoryUseRun(
  useRunId: string,
  options: MemoryUseExecutionOptions = {},
) {
  return markMemoryUseRunDegraded(
    useRunId,
    "memory_recall_partial",
    options,
  );
}

export async function markMemoryUseRunDegradedInTransaction(
  tx: MemoryUseTransaction,
  useRunIdInput: string,
  reasonCodeInput: MemoryUseDegradationReasonCode,
): Promise<MemoryUseRunSnapshot> {
  const useRunId = requiredOpaqueId(useRunIdInput, "useRunId");
  const reasonCode = validateReasonCode(
    reasonCodeInput,
    degradationReasonCodeSet,
  );
  const run = await lockAndLoadRun(tx, useRunId);
  assertRunOpen(run);
  if (run.reasonCode === reasonCode) return toRunSnapshot(run);
  if (run.reasonCode) {
    throw new MemoryUseExecutionError(
      "memory_use_state_conflict",
      "Memory use degradation reason is immutable once recorded.",
      409,
    );
  }
  const updated = await tx.memoryUseRun.update({
    where: { id: run.id },
    data: { reasonCode },
    select: memoryUseRunSnapshotSelect,
  });
  return toRunSnapshot(updated);
}

export async function failMemoryUseRun(
  useRunId: string,
  reasonCode: MemoryUseFailureReasonCode,
  options: MemoryUseExecutionOptions = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      failMemoryUseRunInTransaction(
        tx,
        useRunId,
        reasonCode,
        options.now?.() ?? new Date(),
      ),
    ),
  );
}

export async function failMemoryUseRunInTransaction(
  tx: MemoryUseTransaction,
  useRunId: string,
  reasonCode: MemoryUseFailureReasonCode,
  occurredAt = new Date(),
) {
  return transitionMemoryUseRunInTransaction(
    tx,
    useRunId,
    MemoryUseRunStatus.FAILED,
    reasonCode,
    failureReasonCodeSet,
    occurredAt,
  );
}

export async function cancelMemoryUseRun(
  useRunId: string,
  reasonCode: MemoryUseCancellationReasonCode,
  options: MemoryUseExecutionOptions = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      cancelMemoryUseRunInTransaction(
        tx,
        useRunId,
        reasonCode,
        options.now?.() ?? new Date(),
      ),
    ),
  );
}

export async function cancelMemoryUseRunInTransaction(
  tx: MemoryUseTransaction,
  useRunId: string,
  reasonCode: MemoryUseCancellationReasonCode,
  occurredAt = new Date(),
) {
  return transitionMemoryUseRunInTransaction(
    tx,
    useRunId,
    MemoryUseRunStatus.CANCELED,
    reasonCode,
    cancellationReasonCodeSet,
    occurredAt,
  );
}

async function transitionMemoryUseRunInTransaction(
  tx: MemoryUseTransaction,
  useRunIdInput: string,
  targetStatus:
    | typeof MemoryUseRunStatus.FAILED
    | typeof MemoryUseRunStatus.CANCELED,
  reasonCodeInput: MemoryUseFailureReasonCode | MemoryUseCancellationReasonCode,
  allowedReasonCodes: ReadonlySet<string>,
  occurredAt = new Date(),
): Promise<MemoryUseRunSnapshot> {
  const useRunId = requiredOpaqueId(useRunIdInput, "useRunId");
  const reasonCode = validateReasonCode(reasonCodeInput, allowedReasonCodes);
  const run = await lockAndLoadRun(tx, useRunId);
  if (run.status === targetStatus && run.reasonCode === reasonCode) {
    return toRunSnapshot(run);
  }
  if (terminalRunStatuses.has(run.status)) {
    throw new MemoryUseExecutionError(
      "memory_use_state_conflict",
      "Memory use run already reached a different terminal state.",
      409,
    );
  }
  const updated = await tx.memoryUseRun.update({
    where: { id: run.id },
    data: { status: targetStatus, reasonCode, completedAt: occurredAt },
    select: memoryUseRunSnapshotSelect,
  });
  return toRunSnapshot(updated);
}

const memoryUseRunSnapshotSelect = {
  id: true,
  generationRunId: true,
  representativeId: true,
  conversationId: true,
  contactId: true,
  sourceChannel: true,
  representativeVersionId: true,
  inputMessageId: true,
  outputMessageId: true,
  status: true,
  reasonCode: true,
  searchedCount: true,
  scopePassedCount: true,
  safetyPassedCount: true,
  injectedCount: true,
  citedCount: true,
  displayedCount: true,
  unmappedCandidateCount: true,
  startedAt: true,
  completedAt: true,
} as const;

type RunSnapshotRecord = MemoryUseRunSnapshot;

async function lockAndLoadRun(tx: MemoryUseTransaction, useRunId: string) {
  await tx.$executeRaw`SELECT "id" FROM "MemoryUseRun" WHERE "id" = ${useRunId} FOR UPDATE`;
  const run = await tx.memoryUseRun.findUnique({
    where: { id: useRunId },
    select: memoryUseRunSnapshotSelect,
  });
  if (!run) {
    throw new MemoryUseExecutionError(
      "memory_use_run_not_found",
      "Memory use run was not found.",
      404,
    );
  }
  return run;
}

async function loadRunSnapshot(tx: MemoryUseTransaction, useRunId: string) {
  const run = await tx.memoryUseRun.findUniqueOrThrow({
    where: { id: useRunId },
    select: memoryUseRunSnapshotSelect,
  });
  return toRunSnapshot(run);
}

function toRunSnapshot(run: RunSnapshotRecord): MemoryUseRunSnapshot {
  return { ...run };
}

function assertRunOpen(run: { status: MemoryUseRunStatus }) {
  if (run.status !== MemoryUseRunStatus.STARTED) {
    throw new MemoryUseExecutionError(
      "memory_use_state_conflict",
      "Memory use run is no longer open.",
      409,
    );
  }
}

async function assertRunStillCurrent(
  tx: MemoryUseTransaction,
  run: RunSnapshotRecord,
) {
  const [representative, conversation] = await Promise.all([
    tx.representative.findUnique({
      where: { id: run.representativeId },
      select: { activeVersionId: true },
    }),
    tx.conversation.findUnique({
      where: { id: run.conversationId },
      select: { representativeId: true, contactId: true, sourceChannel: true },
    }),
  ]);
  if (
    representative?.activeVersionId !== run.representativeVersionId
    || conversation?.representativeId !== run.representativeId
    || conversation.contactId !== run.contactId
    || normalizeOptionalSourceChannel(conversation.sourceChannel)
      !== run.sourceChannel
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_scope_conflict",
      "Memory use run no longer matches the current representative, contact, and channel scope.",
      409,
    );
  }
}

async function loadGovernedProjectionSources(
  tx: MemoryUseTransaction,
  ids: string[],
) {
  if (!ids.length) return [];
  return tx.memoryProjectionItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      representativeId: true,
      lane: true,
      status: true,
      contentHash: true,
      writeVerifiedAt: true,
      memoryVersion: {
        select: {
          id: true,
          representativeId: true,
          scope: true,
          contentHash: true,
          purgedAt: true,
          deidentifiedAt: true,
          deidentificationMethod: true,
          sourceCandidate: {
            select: {
              id: true,
              status: true,
              safetyClass: true,
              contentPurgedAt: true,
            },
          },
          reviewDecisions: {
            where: { outcome: MemoryReviewOutcome.APPROVED },
            select: { reviewerRole: true },
          },
          memory: {
            select: {
              representativeId: true,
              contactId: true,
              sourceChannel: true,
              scope: true,
              status: true,
              currentVersionId: true,
              recallDisabledAt: true,
              expiresAt: true,
            },
          },
        },
      },
    },
  });
}

async function loadPublicProjectionSources(
  tx: MemoryUseTransaction,
  ids: string[],
) {
  if (!ids.length) return [];
  return tx.publicKnowledgeProjectionItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      representativeId: true,
      publishedVersionId: true,
      sourceKind: true,
      resourceKey: true,
      knowledgeAssetId: true,
      contentHash: true,
      projectedAt: true,
      publishedVersion: {
        select: { status: true },
      },
      publishedResource: {
        select: {
          representativeId: true,
          sourceKind: true,
          resourceKey: true,
          knowledgeAssetId: true,
          contentHash: true,
        },
      },
    },
  });
}

type GovernedProjectionSource = Awaited<
  ReturnType<typeof loadGovernedProjectionSources>
>[number];
type PublicProjectionSource = Awaited<
  ReturnType<typeof loadPublicProjectionSources>
>[number];

function governedSourceMatchesScope(
  source: GovernedProjectionSource,
  run: RunSnapshotRecord,
  requestedKind: GovernedMemorySearchHit["sourceKind"],
) {
  const memory = source.memoryVersion.memory;
  if (
    source.representativeId !== run.representativeId
    || source.memoryVersion.representativeId !== run.representativeId
    || memory.representativeId !== run.representativeId
    || source.memoryVersion.scope !== memory.scope
  ) return false;

  if (requestedKind === MemoryUseSourceKind.CONTACT_MEMORY) {
    return memory.scope === MemoryScope.CONTACT_CHANNEL
      && memory.contactId === run.contactId
      && memory.sourceChannel === run.sourceChannel;
  }
  return memory.scope === MemoryScope.REPRESENTATIVE
    && memory.contactId === null
    && memory.sourceChannel === null;
}

function governedSourceSafety(
  source: GovernedProjectionSource,
  run: RunSnapshotRecord,
  policy: {
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
    representativeExperienceEnabled: boolean;
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  } | null,
  occurredAt: Date,
) {
  const version = source.memoryVersion;
  const memory = version.memory;
  const sourceCandidate = version.sourceCandidate;
  if (
    !policy
    || !policy.longTermMemoryEnabled
    || !channelRecallEnabled(policy, run.sourceChannel)
    || (
      memory.scope === MemoryScope.CONTACT_CHANNEL
        ? !policy.contactMemoryEnabled
        : !policy.representativeExperienceEnabled
    )
  ) return rejectedSafety("memory_policy_disabled");
  if (
    memory.status !== GovernedMemoryStatus.ACTIVE
    || memory.recallDisabledAt
    || memory.currentVersionId !== version.id
    || version.purgedAt
    || (memory.expiresAt && memory.expiresAt <= occurredAt)
    || source.status !== MemoryProjectionStatus.ACTIVE
    || source.lane !== MemoryProjectionLane.RECALL
    || !source.writeVerifiedAt
    || source.contentHash !== version.contentHash
    || !sha256Pattern.test(source.contentHash)
  ) return rejectedSafety("memory_not_recall_active");
  if (
    !sourceCandidate
    || sourceCandidate.status !== MemoryCandidateStatus.APPROVED
    || sourceCandidate.contentPurgedAt
    || !new Set<MemorySafetyClass>([
      MemorySafetyClass.LOW_RISK,
      MemorySafetyClass.REVIEW_REQUIRED,
    ]).has(sourceCandidate.safetyClass)
    || !version.reviewDecisions.some(
      (decision) => decision.reviewerRole !== MemoryReviewerRole.SYSTEM,
    )
  ) return rejectedSafety("memory_review_invalid");
  if (
    memory.scope === MemoryScope.REPRESENTATIVE
    && (
      !version.deidentifiedAt
      || !version.deidentificationMethod
    )
  ) return rejectedSafety("representative_experience_review_invalid");
  return { passed: true, reasonCode: null } as const;
}

function rejectedSafety(reasonCode: string) {
  return { passed: false, reasonCode } as const;
}

function publicSourceMatchesRun(
  source: PublicProjectionSource,
  run: RunSnapshotRecord,
) {
  return source.representativeId === run.representativeId
    && source.publishedVersionId === run.representativeVersionId
    && source.publishedVersion.status === "PUBLISHED"
    && source.publishedResource.representativeId === run.representativeId
    && source.publishedResource.sourceKind === source.sourceKind
    && source.publishedResource.resourceKey === source.resourceKey
    && source.publishedResource.knowledgeAssetId === source.knowledgeAssetId
    && source.publishedResource.contentHash === source.contentHash
    && source.projectedAt !== null
    && sha256Pattern.test(source.contentHash);
}

async function upsertSearchItem(
  tx: MemoryUseTransaction,
  input: {
    run: RunSnapshotRecord;
    itemKey: string;
    sourceKind: MemoryUseSourceKind;
    memoryScope?: MemoryScope;
    memoryVersionId?: string;
    projectionItemId?: string;
    publicKnowledgeProjectionId?: string;
    contentHash: string;
    searchRank: number | null;
    searchScore: number | null;
    scopePassed: boolean;
    safetyPassed: boolean;
    rejectionReasonCode: string | null;
    occurredAt: Date;
  },
) {
  const existing = await tx.memoryUseItem.findUnique({
    where: {
      useRunId_itemKey: { useRunId: input.run.id, itemKey: input.itemKey },
    },
    select: {
      id: true,
      sourceKind: true,
      contentHash: true,
      safetyPassedAt: true,
    },
  });
  if (existing) {
    if (
      existing.sourceKind !== input.sourceKind
      || existing.contentHash !== input.contentHash
    ) throw rejectedSource();
    return existing;
  }
  return tx.memoryUseItem.create({
    data: {
      useRunId: input.run.id,
      representativeId: input.run.representativeId,
      itemKey: input.itemKey,
      sourceKind: input.sourceKind,
      ...(input.memoryScope ? { memoryScope: input.memoryScope } : {}),
      ...(input.memoryVersionId ? { memoryVersionId: input.memoryVersionId } : {}),
      ...(input.projectionItemId ? { projectionItemId: input.projectionItemId } : {}),
      ...(input.publicKnowledgeProjectionId
        ? { publicKnowledgeProjectionId: input.publicKnowledgeProjectionId }
        : {}),
      contentHash: input.contentHash,
      searchRank: input.searchRank,
      searchScore: input.searchScore,
      searchedAt: input.occurredAt,
      scopeCheckedAt: input.occurredAt,
      scopePassedAt: input.scopePassed ? input.occurredAt : null,
      safetyCheckedAt: input.scopePassed ? input.occurredAt : null,
      safetyPassedAt: input.safetyPassed ? input.occurredAt : null,
      rejectionReasonCode: input.rejectionReasonCode,
    },
    select: {
      id: true,
      sourceKind: true,
      contentHash: true,
      safetyPassedAt: true,
    },
  });
}

async function loadItemsForFinalization(
  tx: MemoryUseTransaction,
  useRunId: string,
  ids: string[],
) {
  if (!ids.length) return [];
  return tx.memoryUseItem.findMany({
    where: { useRunId, id: { in: ids } },
    select: {
      id: true,
      sourceKind: true,
      safetyPassedAt: true,
      injectedAt: true,
      citedAt: true,
      citationId: true,
      rejectionReasonCode: true,
      memoryVersionId: true,
      projectionItemId: true,
      publicKnowledgeProjectionId: true,
      publicKnowledgeProjection: {
        select: {
          publishedVersionId: true,
          resourceKey: true,
          knowledgeAssetId: true,
        },
      },
      contentHash: true,
    },
  });
}

type FinalizationItem = Awaited<ReturnType<typeof loadItemsForFinalization>>[number];

async function assertItemStillInjectable(
  tx: MemoryUseTransaction,
  run: RunSnapshotRecord,
  item: FinalizationItem,
  occurredAt: Date,
) {
  if (item.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE) {
    if (!item.publicKnowledgeProjectionId) throw rejectedSource();
    const sources = await loadPublicProjectionSources(
      tx,
      [item.publicKnowledgeProjectionId],
    );
    const source = sources[0];
    if (
      !source
      || !publicSourceMatchesRun(source, run)
      || source.contentHash !== item.contentHash
    ) throw rejectedSource();
    return;
  }
  if (!item.projectionItemId || !item.memoryVersionId) throw rejectedSource();
  const [source, policy] = await Promise.all([
    loadGovernedProjectionSources(tx, [item.projectionItemId]).then(
      (sources) => sources[0],
    ),
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: run.representativeId },
      select: {
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: true,
        webRecallEnabled: true,
        matrixRecallEnabled: true,
        telegramRecallEnabled: true,
      },
    }),
  ]);
  if (
    !source
    || source.memoryVersion.id !== item.memoryVersionId
    || source.contentHash !== item.contentHash
    || !governedSourceMatchesScope(source, run, item.sourceKind)
    || !governedSourceSafety(source, run, policy, occurredAt).passed
  ) throw rejectedSource();
}

async function createAuthoritativeCitation(
  tx: MemoryUseTransaction,
  run: RunSnapshotRecord,
  item: FinalizationItem,
  outputMessageId: string,
) {
  if (item.sourceKind === MemoryUseSourceKind.CONTACT_MEMORY) {
    const citation = await tx.messageCitation.create({
      data: {
        messageId: outputMessageId,
        title: "本人历史信息",
      },
      select: { id: true },
    });
    return citation.id;
  }
  if (item.sourceKind === MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE) {
    const citation = await tx.messageCitation.create({
      data: {
        messageId: outputMessageId,
        title: "已审核代表经验",
      },
      select: { id: true },
    });
    return citation.id;
  }

  const projection = item.publicKnowledgeProjection;
  if (
    !projection
    || projection.publishedVersionId !== run.representativeVersionId
  ) throw rejectedSource();

  let title = safePublicCitationTitle(projection.resourceKey);
  if (projection.knowledgeAssetId) {
    const [asset, representative] = await Promise.all([
      tx.knowledgeAsset.findUnique({
        where: { id: projection.knowledgeAssetId },
        select: { ownerId: true, title: true },
      }),
      tx.representative.findUnique({
        where: { id: run.representativeId },
        select: { ownerId: true },
      }),
    ]);
    if (asset && representative && asset.ownerId === representative.ownerId) {
      title = safeCitationTitle(asset.title, title);
    }
  }
  const citation = await tx.messageCitation.create({
    data: {
      messageId: outputMessageId,
      knowledgeAssetId: projection.knowledgeAssetId,
      knowledgeRevision: projection.publishedVersionId,
      title,
    },
    select: { id: true },
  });
  return citation.id;
}

async function replayCompletedFinalization(
  tx: MemoryUseTransaction,
  run: RunSnapshotRecord,
  input: {
    outputMessageId: string;
    injectedItemIds: string[];
    citedItemIds: string[];
  },
): Promise<FinalizeMemoryUseGenerationResult> {
  const staged = await tx.memoryUseItem.findMany({
    where: {
      useRunId: run.id,
      OR: [{ injectedAt: { not: null } }, { citedAt: { not: null } }],
    },
    select: {
      id: true,
      sourceKind: true,
      injectedAt: true,
      citedAt: true,
      citationId: true,
    },
  });
  const injected = staged.filter((item) => item.injectedAt).map((item) => item.id);
  const cited = staged
    .filter((item) => item.citedAt)
    .map((item) => item.id);
  if (
    run.outputMessageId !== input.outputMessageId
    || !sameStringSet(injected, input.injectedItemIds)
    || !sameStringSet(cited, input.citedItemIds)
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_state_conflict",
      "Completed memory use run cannot be rebound to different generation results.",
      409,
    );
  }
  const sourceById = new Map(staged.map((item) => [item.id, item.sourceKind]));
  return {
    run: toRunSnapshot(run),
    deliveryReadyCitations: input.citedItemIds.map((memoryUseItemId) => ({
      memoryUseItemId,
      sourceKind: sourceById.get(memoryUseItemId)!,
    })),
  };
}

function validateSearchHits(hits: MemoryUseSearchHit[]) {
  if (!Array.isArray(hits) || hits.length > maximumSearchHits) {
    throw invalidInput(`hits must contain at most ${maximumSearchHits} items.`);
  }
  const seen = new Set<string>();
  return hits.map((hit) => {
    const sourceId = hit.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE
      ? requiredOpaqueId(hit.publicKnowledgeProjectionId, "publicKnowledgeProjectionId")
      : requiredOpaqueId(hit.projectionItemId, "projectionItemId");
    const key = `${hit.sourceKind}:${sourceId}`;
    if (seen.has(key)) throw invalidInput("Search hits must not contain duplicate sources.");
    seen.add(key);
    return {
      ...hit,
      ...(hit.searchRank === undefined
        ? {}
        : { searchRank: boundedInteger(hit.searchRank, "searchRank", 1, 10_000) }),
      ...(hit.searchScore === undefined
        ? {}
        : { searchScore: boundedNumber(hit.searchScore, "searchScore", 0, 1) }),
    };
  });
}

function uniqueOpaqueIds(values: string[], field: string) {
  if (!Array.isArray(values) || values.length > maximumSearchHits) {
    throw invalidInput(`${field} is invalid.`);
  }
  const normalized = values.map((value) => requiredOpaqueId(value, field));
  if (new Set(normalized).size !== normalized.length) {
    throw invalidInput(`${field} must not contain duplicates.`);
  }
  return normalized;
}

function requiredOpaqueId(value: unknown, field: string) {
  if (
    typeof value !== "string"
    || value.length > maximumOpaqueIdLength
    || !opaqueIdPattern.test(value)
  ) throw invalidInput(`${field} is invalid.`);
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${field} is invalid.`);
  }
  return value as number;
}

function boundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) throw invalidInput(`${field} is invalid.`);
  return value;
}

function normalizeSourceChannel(
  value: StartOrReuseMemoryUseRunInput["sourceChannel"],
) {
  const normalized = String(value).trim().toUpperCase();
  if (normalized === RepresentativeChannelKind.WEB) return RepresentativeChannelKind.WEB;
  if (normalized === RepresentativeChannelKind.MATRIX) return RepresentativeChannelKind.MATRIX;
  if (normalized === RepresentativeChannelKind.TELEGRAM) {
    return RepresentativeChannelKind.TELEGRAM;
  }
  throw invalidInput("sourceChannel is invalid.");
}

function normalizeOptionalSourceChannel(value: string | null) {
  if (!value) return null;
  try {
    return normalizeSourceChannel(value as StartOrReuseMemoryUseRunInput["sourceChannel"]);
  } catch {
    return null;
  }
}

function resolveGenerationChannel(generation: {
  conversation: { sourceChannel: string | null };
  inputMessage: { channelBinding: { kind: RepresentativeChannelKind } | null };
}) {
  const conversationChannel = normalizeOptionalSourceChannel(
    generation.conversation.sourceChannel,
  );
  const bindingChannel = generation.inputMessage.channelBinding?.kind ?? null;
  if (conversationChannel && bindingChannel && conversationChannel !== bindingChannel) {
    return null;
  }
  return bindingChannel ?? conversationChannel;
}

function channelRecallEnabled(
  policy: {
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  },
  channel: RepresentativeChannelKind,
) {
  // Defense in depth for legacy rows whose unsupported channel flags were
  // previously true. Public knowledge does not call this governed-memory gate.
  return channel === RepresentativeChannelKind.WEB && policy.webRecallEnabled;
}

function assertRunCoordinates(
  existing: RunSnapshotRecord,
  expected: Pick<
    MemoryUseRunSnapshot,
    | "generationRunId"
    | "representativeId"
    | "conversationId"
    | "contactId"
    | "sourceChannel"
    | "representativeVersionId"
    | "inputMessageId"
  >,
) {
  if (
    existing.generationRunId !== expected.generationRunId
    || existing.representativeId !== expected.representativeId
    || existing.conversationId !== expected.conversationId
    || existing.contactId !== expected.contactId
    || existing.sourceChannel !== expected.sourceChannel
    || existing.representativeVersionId !== expected.representativeVersionId
    || existing.inputMessageId !== expected.inputMessageId
  ) {
    throw new MemoryUseExecutionError(
      "memory_use_scope_conflict",
      "Existing memory use run has conflicting immutable coordinates.",
      409,
    );
  }
}

function searchItemKey(sourceKind: MemoryUseSourceKind, sourceId: string) {
  return createHash("sha256")
    .update(`${sourceKind}\0${sourceId}`)
    .digest("hex");
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function validateReasonCode(
  value: unknown,
  allowedValues: ReadonlySet<string>,
) {
  if (typeof value !== "string" || !allowedValues.has(value)) {
    throw invalidInput("reasonCode is invalid.");
  }
  return value;
}

function safePublicCitationTitle(resourceKey: string) {
  const normalized = resourceKey.normalize("NFKC").trim();
  const productKey = normalized.toLowerCase();
  if (/(?:^|[._/-])identity(?:$|[._/-])/u.test(productKey)) return "身份";
  if (/(?:^|[._/-])faq(?:$|[._/-])/u.test(productKey)) return "FAQ";
  if (/(?:^|[._/-])materials?(?:$|[._/-])/u.test(productKey)) return "资料";
  if (/(?:^|[._/-])polic(?:y|ies)(?:$|[._/-])/u.test(productKey)) return "政策";
  if (/(?:^|[._/-])pric(?:e|ing)(?:$|[._/-])/u.test(productKey)) return "价格";
  if (/^[\p{L}\p{N} _.-]{1,120}$/u.test(normalized)) return normalized;
  return "已发布知识";
}

function safeCitationTitle(value: string, fallback: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || /(?:[a-z][a-z0-9+.-]*:\/\/|viking:)/iu.test(normalized)) {
    return fallback;
  }
  return normalized.slice(0, 120);
}

function invalidInput(message: string) {
  return new MemoryUseExecutionError("memory_use_invalid_input", message, 400);
}

function rejectedSource() {
  return new MemoryUseExecutionError(
    "memory_use_source_rejected",
    "One or more memory sources are no longer safe and authoritative.",
    409,
  );
}
