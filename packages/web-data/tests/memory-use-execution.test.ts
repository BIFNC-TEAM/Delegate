import {
  MemoryUseRunStatus,
  MemoryUseSourceKind,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  failMemoryUseRunInTransaction,
  finalizeMemoryUseGenerationInTransaction,
  markMemoryUseItemsDisplayedInTransaction,
  markMemoryUseRunDegradedInTransaction,
  recordMemoryUseSearchHitsInTransaction,
  startOrReuseMemoryUseRunInTransaction,
  type MemoryUseRunSnapshot,
} from "../src/memory-use-execution";

const occurredAt = new Date("2026-08-04T08:00:00.000Z");

describe("memory use execution", () => {
  it("idempotently reuses a generation-scoped run without reading message text", async () => {
    const run = runSnapshot();
    const generationFind = vi.fn().mockResolvedValue({
      id: run.generationRunId,
      conversationId: run.conversationId,
      inputMessageId: run.inputMessageId,
      representativeVersionId: run.representativeVersionId,
      conversation: {
        representativeId: run.representativeId,
        contactId: run.contactId,
        sourceChannel: "web",
        representative: { activeVersionId: run.representativeVersionId },
      },
      inputMessage: {
        id: run.inputMessageId,
        conversationId: run.conversationId,
        channelBinding: { kind: RepresentativeChannelKind.WEB },
      },
      representativeVersion: {
        id: run.representativeVersionId,
        representativeId: run.representativeId,
        status: "PUBLISHED",
      },
    });
    const create = vi.fn();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: { findUnique: generationFind },
      memoryUseRun: {
        findFirst: vi.fn().mockResolvedValue(run),
        create,
      },
    });

    await expect(startOrReuseMemoryUseRunInTransaction(tx, {
      generationRunId: run.generationRunId,
      sourceChannel: "web",
    }, occurredAt)).resolves.toEqual({ replayed: true, run });
    expect(create).not.toHaveBeenCalled();
    expect(generationFind).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ text: expect.anything() }),
    }));
  });

  it("fails closed when the generation channel does not match", async () => {
    const run = runSnapshot();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: run.generationRunId,
          conversationId: run.conversationId,
          inputMessageId: run.inputMessageId,
          representativeVersionId: run.representativeVersionId,
          conversation: {
            representativeId: run.representativeId,
            contactId: run.contactId,
            sourceChannel: "matrix",
            representative: { activeVersionId: run.representativeVersionId },
          },
          inputMessage: {
            id: run.inputMessageId,
            conversationId: run.conversationId,
            channelBinding: { kind: RepresentativeChannelKind.MATRIX },
          },
          representativeVersion: {
            id: run.representativeVersionId,
            representativeId: run.representativeId,
            status: "PUBLISHED",
          },
        }),
      },
    });

    await expect(startOrReuseMemoryUseRunInTransaction(tx, {
      generationRunId: run.generationRunId,
      sourceChannel: RepresentativeChannelKind.WEB,
    }, occurredAt)).rejects.toMatchObject({
      code: "memory_use_scope_conflict",
    });
  });

  it("counts unknown and cross-boundary search sources anonymously", async () => {
    let run = runSnapshot();
    const itemCreate = vi.fn();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockImplementation(async () => run),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => run),
        update: vi.fn().mockImplementation(async ({ data }) => {
          run = { ...run, ...data };
          return run;
        }),
      },
      representative: {
        findUnique: vi.fn().mockResolvedValue({
          activeVersionId: run.representativeVersionId,
        }),
      },
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          representativeId: run.representativeId,
          contactId: run.contactId,
          sourceChannel: "web",
        }),
      },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([]) },
      publicKnowledgeProjectionItem: { findMany: vi.fn().mockResolvedValue([]) },
      representativeMemoryPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      memoryUseItem: { create: itemCreate },
      memoryUseUnmappedObservation: {
        createMany: vi.fn().mockImplementation(async ({ data }) => {
          run = {
            ...run,
            unmappedCandidateCount: data[0]!.candidateCount,
          };
          return { count: 1 };
        }),
      },
    });

    const result = await recordMemoryUseSearchHitsInTransaction(tx, {
      useRunId: run.id,
      hits: [
        {
          sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
          projectionItemId: "unknown_projection_1",
        },
        {
          sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
          publicKnowledgeProjectionId: "unknown_public_1",
        },
      ],
      observedUnmappedCandidateCount: 1,
    }, occurredAt);

    expect(result).toMatchObject({
      anonymousRejectedCount: 2,
      eligibleItems: [],
      run: { unmappedCandidateCount: 2 },
    });
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it("records an exact published projection without query, URI, or body fields", async () => {
    let run = runSnapshot();
    const contentHash = "a".repeat(64);
    const itemCreate = vi.fn().mockImplementation(async ({ data }) => {
      run = {
        ...run,
        searchedCount: 1,
        scopePassedCount: 1,
        safetyPassedCount: 1,
      };
      return {
        id: "memory_use_item_1",
        sourceKind: data.sourceKind,
        contentHash: data.contentHash,
        safetyPassedAt: data.safetyPassedAt,
      };
    });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockImplementation(async () => run),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => run),
        update: vi.fn(),
      },
      representative: {
        findUnique: vi.fn().mockResolvedValue({
          activeVersionId: run.representativeVersionId,
        }),
      },
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          representativeId: run.representativeId,
          contactId: run.contactId,
          sourceChannel: "web",
        }),
      },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([]) },
      publicKnowledgeProjectionItem: {
        findMany: vi.fn().mockResolvedValue([{
          id: "public_projection_1",
          representativeId: run.representativeId,
          publishedVersionId: run.representativeVersionId,
          sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
          resourceKey: "identity/profile.md",
          knowledgeAssetId: null,
          contentHash,
          projectedAt: occurredAt,
          publishedVersion: { status: "PUBLISHED" },
          publishedResource: {
            representativeId: run.representativeId,
            sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
            resourceKey: "identity/profile.md",
            knowledgeAssetId: null,
            contentHash,
          },
        }]),
      },
      representativeMemoryPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      memoryUseItem: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: itemCreate,
      },
    });

    await expect(recordMemoryUseSearchHitsInTransaction(tx, {
      useRunId: run.id,
      hits: [{
        sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
        publicKnowledgeProjectionId: "public_projection_1",
        searchRank: 1,
        searchScore: 0.91,
      }],
    }, occurredAt)).resolves.toMatchObject({
      eligibleItems: [{
        memoryUseItemId: "memory_use_item_1",
        sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
        publicKnowledgeProjectionId: "public_projection_1",
      }],
    });
    const createData = itemCreate.mock.calls[0]![0].data;
    expect(createData).toMatchObject({
      publicKnowledgeProjectionId: "public_projection_1",
      contentHash,
      searchedAt: occurredAt,
      scopePassedAt: occurredAt,
      safetyPassedAt: occurredAt,
    });
    expect(createData).not.toHaveProperty("queryText");
    expect(createData).not.toHaveProperty("remoteUri");
    expect(createData).not.toHaveProperty("safeText");
    expect(createData).not.toHaveProperty("excerpt");
  });

  it("does not safety-pass a contact memory approved only by SYSTEM", async () => {
    const run = runSnapshot();
    const contentHash = "c".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    source.memoryVersion.reviewDecisions = [{ reviewerRole: "SYSTEM" }];
    const itemCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: "memory_use_item_system_review",
      sourceKind: data.sourceKind,
      contentHash: data.contentHash,
      safetyPassedAt: data.safetyPassedAt,
    }));
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        findUniqueOrThrow: vi.fn().mockResolvedValue(run),
        update: vi.fn(),
      },
      representative: {
        findUnique: vi.fn().mockResolvedValue({
          activeVersionId: run.representativeVersionId,
        }),
      },
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          representativeId: run.representativeId,
          contactId: run.contactId,
          sourceChannel: "web",
        }),
      },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([source]) },
      publicKnowledgeProjectionItem: { findMany: vi.fn().mockResolvedValue([]) },
      representativeMemoryPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          representativeExperienceEnabled: true,
          webRecallEnabled: true,
          matrixRecallEnabled: false,
          telegramRecallEnabled: false,
        }),
      },
      memoryUseItem: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: itemCreate,
      },
    });

    await expect(recordMemoryUseSearchHitsInTransaction(tx, {
      useRunId: run.id,
      hits: [{
        sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
        projectionItemId: source.id,
      }],
    }, occurredAt)).resolves.toMatchObject({ eligibleItems: [] });
    expect(itemCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        safetyCheckedAt: occurredAt,
        safetyPassedAt: null,
        rejectionReasonCode: "memory_review_invalid",
      }),
    }));
  });

  it("rejects cited identifiers that were not injected before any write", async () => {
    const tx = asTransaction({
      $executeRaw: vi.fn(),
      memoryUseRun: { update: vi.fn() },
      memoryUseItem: { update: vi.fn(), updateMany: vi.fn() },
    });

    await expect(finalizeMemoryUseGenerationInTransaction(tx, {
      useRunId: "memory_use_run_1",
      outputMessageId: "output_message_1",
      injectedItemIds: [],
      citedItemIds: ["memory_use_item_1"],
    }, occurredAt)).rejects.toMatchObject({
      code: "memory_use_invalid_input",
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.memoryUseItem.updateMany).not.toHaveBeenCalled();
    expect(tx.memoryUseRun.update).not.toHaveBeenCalled();
  });

  it("derives contact-memory citations inside the finalization transaction", async () => {
    let run = runSnapshot();
    const contentHash = "b".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    const messageCitationCreate = vi.fn().mockResolvedValue({ id: "citation_internal_1" });
    const itemUpdate = vi.fn().mockImplementation(async ({ data }) => {
      if (data.injectedAt) run = { ...run, injectedCount: 1 };
      if (data.citedAt) run = { ...run, citedCount: 1 };
      return {};
    });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockImplementation(async () => run),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => run),
        update: vi.fn().mockImplementation(async ({ data }) => {
          run = { ...run, ...data };
          return run;
        }),
      },
      representative: {
        findUnique: vi.fn().mockResolvedValue({
          activeVersionId: run.representativeVersionId,
        }),
      },
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          representativeId: run.representativeId,
          contactId: run.contactId,
          sourceChannel: "web",
        }),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "output_message_1",
          conversationId: run.conversationId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
        }),
      },
      memoryUseItem: {
        findMany: vi.fn().mockResolvedValue([{
          id: "memory_use_item_1",
          sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
          safetyPassedAt: occurredAt,
          injectedAt: null,
          citedAt: null,
          citationId: null,
          rejectionReasonCode: null,
          memoryVersionId: "memory_version_1",
          projectionItemId: "projection_1",
          publicKnowledgeProjectionId: null,
          publicKnowledgeProjection: null,
          contentHash,
        }]),
        updateMany: vi.fn().mockImplementation(async ({ data }) => {
          await itemUpdate({ data });
          return { count: 1 };
        }),
        update: itemUpdate,
      },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([source]) },
      representativeMemoryPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          representativeExperienceEnabled: true,
          webRecallEnabled: true,
          matrixRecallEnabled: false,
          telegramRecallEnabled: false,
        }),
      },
      messageCitation: { create: messageCitationCreate },
    });

    await expect(finalizeMemoryUseGenerationInTransaction(tx, {
      useRunId: run.id,
      outputMessageId: "output_message_1",
      injectedItemIds: ["memory_use_item_1"],
      citedItemIds: ["memory_use_item_1"],
    }, occurredAt)).resolves.toMatchObject({
      run: {
        status: MemoryUseRunStatus.COMPLETED,
        outputMessageId: "output_message_1",
      },
      deliveryReadyCitations: [{
        memoryUseItemId: "memory_use_item_1",
        sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
      }],
    });
    expect(messageCitationCreate).toHaveBeenCalledWith({
      data: {
        messageId: "output_message_1",
        title: "本人历史信息",
      },
      select: { id: true },
    });
    expect(itemUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ citationId: "citation_internal_1" }),
    }));
    const citationData = messageCitationCreate.mock.calls[0]![0].data;
    expect(citationData).not.toHaveProperty("uri");
    expect(citationData).not.toHaveProperty("score");
    expect(citationData).not.toHaveProperty("excerpt");
  });

  it("never marks Matrix citations as publicly displayed", async () => {
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockResolvedValue(runSnapshot({
          status: MemoryUseRunStatus.COMPLETED,
          sourceChannel: RepresentativeChannelKind.MATRIX,
          outputMessageId: "output_message_1",
          completedAt: occurredAt,
        })),
      },
      memoryUseItem: { updateMany: vi.fn() },
    });

    await expect(markMemoryUseItemsDisplayedInTransaction(tx, {
      useRunId: "memory_use_run_1",
      displayedItemIds: ["memory_use_item_1"],
    }, occurredAt)).rejects.toMatchObject({
      code: "memory_use_state_conflict",
    });
    expect(tx.memoryUseItem.updateMany).not.toHaveBeenCalled();
  });

  it("records degradation while keeping the run open for generation", async () => {
    const run = runSnapshot();
    const update = vi.fn().mockResolvedValue({
      ...run,
      reasonCode: "memory_recall_partial",
    });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: { findUnique: vi.fn().mockResolvedValue(run), update },
    });

    await expect(markMemoryUseRunDegradedInTransaction(
      tx,
      run.id,
      "memory_recall_partial",
    )).resolves.toMatchObject({
      status: MemoryUseRunStatus.STARTED,
      reasonCode: "memory_recall_partial",
      completedAt: null,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { reasonCode: "memory_recall_partial" },
    }));
  });

  it("keeps terminal transitions idempotent and rejects terminal rebinding", async () => {
    const completedAt = new Date("2026-08-04T08:01:00.000Z");
    const failed = runSnapshot({
      status: MemoryUseRunStatus.FAILED,
      reasonCode: "memory_generation_failed",
      completedAt,
    });
    const update = vi.fn();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: { findUnique: vi.fn().mockResolvedValue(failed), update },
    });

    await expect(failMemoryUseRunInTransaction(
      tx,
      failed.id,
      "memory_generation_failed",
      occurredAt,
    )).resolves.toEqual(failed);
    await expect(failMemoryUseRunInTransaction(
      tx,
      failed.id,
      "memory_ledger_failed",
      occurredAt,
    )).rejects.toMatchObject({
      code: "memory_use_state_conflict",
    });
    expect(update).not.toHaveBeenCalled();
  });
});

function runSnapshot(
  overrides: Partial<MemoryUseRunSnapshot> = {},
): MemoryUseRunSnapshot {
  return {
    id: "memory_use_run_1",
    generationRunId: "generation_run_1",
    representativeId: "representative_1",
    conversationId: "conversation_1",
    contactId: "contact_1",
    sourceChannel: RepresentativeChannelKind.WEB,
    representativeVersionId: "representative_version_1",
    inputMessageId: "input_message_1",
    outputMessageId: null,
    status: MemoryUseRunStatus.STARTED,
    reasonCode: null,
    unmappedCandidateCount: 0,
    searchedCount: 0,
    scopePassedCount: 0,
    safetyPassedCount: 0,
    injectedCount: 0,
    citedCount: 0,
    displayedCount: 0,
    startedAt: occurredAt,
    completedAt: null,
    ...overrides,
  };
}

function governedProjectionSource(
  run: MemoryUseRunSnapshot,
  contentHash: string,
) {
  return {
    id: "projection_1",
    representativeId: run.representativeId,
    lane: "RECALL",
    status: "ACTIVE",
    contentHash,
    writeVerifiedAt: occurredAt,
    memoryVersion: {
      id: "memory_version_1",
      representativeId: run.representativeId,
      scope: "CONTACT_CHANNEL",
      contentHash,
      purgedAt: null,
      deidentifiedAt: null,
      deidentificationMethod: null,
      sourceCandidate: {
        id: "candidate_1",
        status: "APPROVED",
        safetyClass: "LOW_RISK",
        contentPurgedAt: null,
      },
      reviewDecisions: [{ reviewerRole: "OWNER" }],
      memory: {
        representativeId: run.representativeId,
        contactId: run.contactId,
        sourceChannel: run.sourceChannel,
        scope: "CONTACT_CHANNEL",
        status: "ACTIVE",
        currentVersionId: "memory_version_1",
        recallDisabledAt: null,
        expiresAt: null,
      },
    },
  };
}

function asTransaction(value: Record<string, unknown>) {
  return value as unknown as Prisma.TransactionClient;
}
