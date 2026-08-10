import {
  ContactMemorySharingSourceEventRole,
  ConversationEpisodeStatus,
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
  revalidateMemoryUseDeliverySourcesInTransaction,
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
      episodeId: null,
      inputMessageId: run.inputMessageId,
      representativeVersionId: run.representativeVersionId,
      conversation: {
        representativeId: run.representativeId,
        contactId: run.contactId,
        sourceChannel: "web",
        activeEpisodeId: null,
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
      episode: null,
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
          episodeId: null,
          inputMessageId: run.inputMessageId,
          representativeVersionId: run.representativeVersionId,
          conversation: {
            representativeId: run.representativeId,
            contactId: run.contactId,
            sourceChannel: "matrix",
            activeEpisodeId: null,
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
          episode: null,
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

  it("keeps an Episode-pinned run valid after a newer release becomes active", async () => {
    const run = runSnapshot();
    const create = vi.fn().mockResolvedValue(run);
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: run.generationRunId,
          conversationId: run.conversationId,
          episodeId: "episode_1",
          inputMessageId: run.inputMessageId,
          representativeVersionId: run.representativeVersionId,
          conversation: {
            representativeId: run.representativeId,
            contactId: run.contactId,
            sourceChannel: "web",
            activeEpisodeId: "episode_1",
            representative: { activeVersionId: "representative_version_2" },
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
          episode: {
            id: "episode_1",
            conversationId: run.conversationId,
            representativeVersionId: run.representativeVersionId,
            status: ConversationEpisodeStatus.ACTIVE,
          },
        }),
      },
      memoryUseRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    });

    await expect(startOrReuseMemoryUseRunInTransaction(tx, {
      generationRunId: run.generationRunId,
      sourceChannel: "web",
    }, occurredAt)).resolves.toEqual({ replayed: false, run });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        representativeVersionId: run.representativeVersionId,
      }),
    }));
  });

  it("rejects a historical archived Episode even when it pins the same release", async () => {
    const run = runSnapshot();
    const create = vi.fn();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: run.generationRunId,
          conversationId: run.conversationId,
          episodeId: "episode_closed",
          inputMessageId: run.inputMessageId,
          representativeVersionId: run.representativeVersionId,
          conversation: {
            representativeId: run.representativeId,
            contactId: run.contactId,
            sourceChannel: "web",
            activeEpisodeId: "episode_closed",
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
          episode: {
            id: "episode_closed",
            conversationId: run.conversationId,
            representativeVersionId: run.representativeVersionId,
            status: ConversationEpisodeStatus.ARCHIVED,
          },
        }),
      },
      memoryUseRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    });

    await expect(startOrReuseMemoryUseRunInTransaction(tx, {
      generationRunId: run.generationRunId,
      sourceChannel: "web",
    }, occurredAt)).rejects.toMatchObject({
      code: "memory_use_scope_conflict",
    });
    expect(create).not.toHaveBeenCalled();
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
      ...runScopeClient(run),
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
      ...runScopeClient(run),
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

  it("does not safety-pass a contact memory without an automatic decision", async () => {
    const run = runSnapshot();
    const contentHash = "c".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    source.memoryVersion.sourceCandidate.policyDecision = undefined;
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
      ...runScopeClient(run),
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
        rejectionReasonCode: "memory_automatic_policy_invalid",
      }),
    }));
  });

  it("safety-passes an automatically activated contact memory without a human review", async () => {
    const run = runSnapshot();
    const contentHash = "d".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    const itemCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: "memory_use_item_automatic_policy",
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
      ...runScopeClient(run),
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
    }, occurredAt)).resolves.toMatchObject({
      eligibleItems: [{
        memoryUseItemId: "memory_use_item_automatic_policy",
      }],
    });
    expect(itemCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        safetyCheckedAt: occurredAt,
        safetyPassedAt: occurredAt,
        rejectionReasonCode: null,
      }),
    }));
  });

  it("allows shared contact memory only for the current verified identity and consent revision", async () => {
    const run = runSnapshot({ sourceChannel: RepresentativeChannelKind.WEB });
    const contentHash = "f".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    Object.assign(source.memoryVersion, { scope: "CONTACT_SHARED" });
    Object.assign(source.memoryVersion.memory, {
      scope: "CONTACT_SHARED",
      contactId: null,
      audienceIdentityId: "identity_1",
      sourceChannel: null,
    });
    Object.assign(source.memoryVersion.sourceCandidate, {
      scope: "CONTACT_SHARED",
      contactId: null,
      audienceIdentityId: "identity_1",
      scopeChannel: null,
    });
    Object.assign(source.memoryVersion.sourceCandidate.policyDecision!, {
      policyRevision: 7,
    });
    const consentFind = vi.fn()
      .mockResolvedValueOnce({
        ...sharedConsentGrant("1".repeat(64)),
      })
      .mockResolvedValueOnce({
        status: "REVOKED",
        grantedAt: occurredAt,
        revokedAt: occurredAt,
        policyRevision: 7,
        consentVersion: 2,
        disclosureContractVersion: "cross-channel-contact-memory-v1",
        proofHash: "1".repeat(64),
      });
    const itemCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: "memory_use_item_shared",
      sourceKind: data.sourceKind,
      contentHash: data.contentHash,
      safetyPassedAt: data.safetyPassedAt,
    }));
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      ...exactWebSourceEvidenceClient(run),
      memoryUseRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        findUniqueOrThrow: vi.fn().mockResolvedValue(run),
        update: vi.fn(),
      },
      ...runScopeClient(run),
      contact: {
        findFirst: vi.fn().mockResolvedValue({
          audienceIdentityId: "identity_1",
        }),
      },
      audienceIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "identity_1",
          status: "REGISTERED",
          mergedIntoId: null,
          identityLinks: [{ id: "verified_link_1" }],
        }),
      },
      contactMemorySharingConsent: { findFirst: consentFind },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([source]) },
      publicKnowledgeProjectionItem: { findMany: vi.fn().mockResolvedValue([]) },
      representativeMemoryPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          revision: 7,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          representativeExperienceEnabled: true,
          webRecallEnabled: true,
          matrixRecallEnabled: true,
          telegramRecallEnabled: true,
        }),
      },
      memoryUseItem: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: itemCreate,
      },
      memoryUseUnmappedObservation: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const input = {
      useRunId: run.id,
      hits: [{
        sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
        projectionItemId: source.id,
      }],
    };

    await expect(recordMemoryUseSearchHitsInTransaction(tx, input, occurredAt))
      .resolves.toMatchObject({
        eligibleItems: [{ memoryUseItemId: "memory_use_item_shared" }],
        anonymousRejectedCount: 0,
      });
    await expect(recordMemoryUseSearchHitsInTransaction(tx, input, occurredAt))
      .resolves.toMatchObject({
        eligibleItems: [],
        anonymousRejectedCount: 1,
      });
    expect(consentFind).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        representativeId: run.representativeId,
        audienceIdentityId: "identity_1",
        policyRevision: 7,
      },
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
      ...runScopeClient(run),
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

  it("blocks a persisted answer at delivery after its injected memory is revoked", async () => {
    const run = runSnapshot({
      status: MemoryUseRunStatus.COMPLETED,
      outputMessageId: "output_message_1",
      injectedCount: 1,
      citedCount: 1,
      completedAt: occurredAt,
    });
    const contentHash = "e".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    const deliveryItem = {
      id: "memory_use_item_1",
      sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
      safetyPassedAt: occurredAt,
      injectedAt: occurredAt,
      citedAt: occurredAt,
      citationId: "citation_1",
      rejectionReasonCode: null,
      memoryVersionId: "memory_version_1",
      projectionItemId: "projection_1",
      publicKnowledgeProjectionId: null,
      publicKnowledgeProjection: null,
      contentHash,
    };
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: { findUnique: vi.fn().mockResolvedValue(run) },
      memoryUseItem: { findMany: vi.fn().mockResolvedValue([deliveryItem]) },
      ...runScopeClient(run),
      message: {
        findUnique: vi.fn().mockResolvedValue({ memoryIngressOrdinal: 1n }),
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
    });
    const input = {
      generationRunId: run.generationRunId,
      conversationId: run.conversationId,
      outputMessageId: "output_message_1",
    };

    await expect(revalidateMemoryUseDeliverySourcesInTransaction(
      tx,
      input,
      occurredAt,
    )).resolves.toEqual({
      authorized: true,
      checkedItemCount: 1,
    });

    const governedMemory = source.memoryVersion.memory as {
      status: string;
      recallDisabledAt: Date | null;
    };
    governedMemory.status = "SUPPRESSED";
    governedMemory.recallDisabledAt = occurredAt;
    await expect(revalidateMemoryUseDeliverySourcesInTransaction(
      tx,
      input,
      occurredAt,
    )).resolves.toEqual({
      authorized: false,
      checkedItemCount: 1,
      reasonCode: "memory_use_delivery_source_revoked",
    });
  });

  it("blocks provider delivery immediately after shared-memory consent is revoked", async () => {
    const run = runSnapshot({
      status: MemoryUseRunStatus.COMPLETED,
      outputMessageId: "output_message_shared",
      injectedCount: 1,
      citedCount: 1,
      completedAt: occurredAt,
    });
    const contentHash = "9".repeat(64);
    const source = governedProjectionSource(run, contentHash);
    Object.assign(source.memoryVersion, { scope: "CONTACT_SHARED" });
    Object.assign(source.memoryVersion.memory, {
      scope: "CONTACT_SHARED",
      contactId: null,
      audienceIdentityId: "identity_1",
      sourceChannel: null,
    });
    Object.assign(source.memoryVersion.sourceCandidate, {
      scope: "CONTACT_SHARED",
      contactId: null,
      audienceIdentityId: "identity_1",
      scopeChannel: null,
    });
    Object.assign(source.memoryVersion.sourceCandidate.policyDecision!, {
      policyRevision: 7,
    });
    const consentFind = vi.fn()
      .mockResolvedValueOnce({
        ...sharedConsentGrant("2".repeat(64)),
      })
      .mockResolvedValueOnce({
        status: "REVOKED",
        grantedAt: occurredAt,
        revokedAt: occurredAt,
        policyRevision: 7,
        consentVersion: 2,
        disclosureContractVersion: "cross-channel-contact-memory-v1",
        proofHash: "2".repeat(64),
      });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      ...exactWebSourceEvidenceClient(run),
      memoryUseRun: { findUnique: vi.fn().mockResolvedValue(run) },
      memoryUseItem: {
        findMany: vi.fn().mockResolvedValue([{
          id: "memory_use_item_shared",
          sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
          safetyPassedAt: occurredAt,
          injectedAt: occurredAt,
          citedAt: occurredAt,
          citationId: "citation_shared",
          rejectionReasonCode: null,
          memoryVersionId: "memory_version_1",
          projectionItemId: "projection_1",
          publicKnowledgeProjectionId: null,
          publicKnowledgeProjection: null,
          contentHash,
        }]),
      },
      ...runScopeClient(run),
      contact: {
        findFirst: vi.fn().mockResolvedValue({ audienceIdentityId: "identity_1" }),
      },
      audienceIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "identity_1",
          status: "REGISTERED",
          mergedIntoId: null,
          identityLinks: [{ id: "verified_web_link" }],
        }),
      },
      contactMemorySharingConsent: { findFirst: consentFind },
      memoryProjectionItem: { findMany: vi.fn().mockResolvedValue([source]) },
      representativeMemoryPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          revision: 7,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          representativeExperienceEnabled: true,
          webRecallEnabled: true,
          matrixRecallEnabled: true,
          telegramRecallEnabled: true,
        }),
      },
    });
    const input = {
      generationRunId: run.generationRunId,
      conversationId: run.conversationId,
      outputMessageId: "output_message_shared",
    };

    await expect(revalidateMemoryUseDeliverySourcesInTransaction(
      tx,
      input,
      occurredAt,
    )).resolves.toEqual({ authorized: true, checkedItemCount: 1 });
    await expect(revalidateMemoryUseDeliverySourcesInTransaction(
      tx,
      input,
      occurredAt,
    )).resolves.toEqual({
      authorized: false,
      checkedItemCount: 1,
      reasonCode: "memory_use_delivery_source_revoked",
    });
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

  it("never marks a citation attached to a different output as displayed", async () => {
    const run = runSnapshot({
      status: MemoryUseRunStatus.COMPLETED,
      outputMessageId: "output_message_1",
      completedAt: occurredAt,
    });
    const updateMany = vi.fn();
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        findUniqueOrThrow: vi.fn().mockResolvedValue(run),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          conversationId: run.conversationId,
          deliveryStatus: "SENT",
        }),
      },
      memoryUseItem: {
        findMany: vi.fn().mockResolvedValue([{
          id: "memory_use_item_1",
          citedAt: occurredAt,
          citationId: "citation_1",
          citation: { messageId: "output_message_other" },
        }]),
        updateMany,
      },
    });

    await expect(markMemoryUseItemsDisplayedInTransaction(tx, {
      useRunId: run.id,
      displayedItemIds: ["memory_use_item_1"],
    }, occurredAt)).rejects.toMatchObject({
      code: "memory_use_state_conflict",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    "memory_recall_partial",
    "memory_recall_query_blocked",
  ] as const)("records degradation reason %s while keeping the run open for generation", async (reasonCode) => {
    const run = runSnapshot();
    const update = vi.fn().mockResolvedValue({
      ...run,
      reasonCode,
    });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      memoryUseRun: { findUnique: vi.fn().mockResolvedValue(run), update },
    });

    await expect(markMemoryUseRunDegradedInTransaction(
      tx,
      run.id,
      reasonCode,
    )).resolves.toMatchObject({
      status: MemoryUseRunStatus.STARTED,
      reasonCode,
      completedAt: null,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { reasonCode },
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
        contactId: run.contactId,
        audienceIdentityId: null,
        scope: "CONTACT_CHANNEL",
        scopeChannel: run.sourceChannel,
        sourceKind: "AUDIENCE_MESSAGE",
        status: "APPROVED",
        safetyClass: "LOW_RISK",
        contentPurgedAt: null,
        policyDecision: {
          representativeId: run.representativeId,
          memoryId: "memory_1",
          resultVersionId: "memory_version_1",
          outcome: "ACTIVATED" as const,
          outputHash: contentHash,
          policyRevision: 7,
        } as {
          representativeId: string;
          memoryId: string;
          resultVersionId: string;
          outcome: "ACTIVATED";
          outputHash: string;
          policyRevision: number;
        } | undefined,
      },
      memory: {
        id: "memory_1",
        representativeId: run.representativeId,
        contactId: run.contactId,
        audienceIdentityId: null,
        sourceChannel: run.sourceChannel,
        category: "CONTACT_CONTEXT",
        scope: "CONTACT_CHANNEL",
        status: "ACTIVE",
        currentVersionId: "memory_version_1",
        recallDisabledAt: null,
        expiresAt: null,
      },
    },
  };
}

function runScopeClient(
  run: MemoryUseRunSnapshot,
  activeVersionId = run.representativeVersionId,
) {
  return {
    representative: {
      findUnique: vi.fn().mockResolvedValue({ activeVersionId }),
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        representativeId: run.representativeId,
        contactId: run.contactId,
        sourceChannel: run.sourceChannel.toLowerCase(),
        activeEpisodeId: null,
      }),
    },
    generationRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: run.generationRunId,
        conversationId: run.conversationId,
        episodeId: null,
        inputMessageId: run.inputMessageId,
        representativeVersionId: run.representativeVersionId,
        episode: null,
      }),
    },
  };
}

function exactWebSourceEvidenceClient(run: MemoryUseRunSnapshot) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "verified_web_link" }]),
    message: {
      findFirst: vi.fn().mockResolvedValue({
        senderId: null,
        sourceIdentityLinkId: "verified_web_link",
        sourceIdentityConnectionProofId: null,
        conversation: {
          audienceIdentityId: "identity_1",
          contact: { audienceIdentityId: "identity_1" },
        },
        channelBinding: { kind: RepresentativeChannelKind.WEB, connectionId: null },
      }),
    },
    identityLink: {
      findUnique: vi.fn().mockResolvedValue({
        id: "verified_web_link",
        audienceIdentityId: "identity_1",
        provider: "LOGTO",
        providerSubject: "logto-user-1",
        issuer: "https://identity.delegate.test",
        verifiedAt: occurredAt,
        assuranceLevel: "PLATFORM_VERIFIED",
        revokedAt: null,
      }),
    },
    identityLinkConnectionProof: { findUnique: vi.fn() },
    audienceIdentity: {
      findUnique: vi.fn().mockResolvedValue({
        id: "identity_1",
        status: "REGISTERED",
        mergedIntoId: null,
      }),
    },
  };
}

function sharedConsentGrant(proofHash: string) {
  const consentId = "consent_1";
  const challengeId = "challenge_1";
  const sourceEvidenceHash = "2".repeat(64);
  const confirmationEventHash = "3".repeat(64);
  const disclosureEventHash = "4".repeat(64);
  const createdAt = new Date(occurredAt.getTime() - 2_000);
  const consumedAt = new Date(occurredAt.getTime() - 1_000);
  const expiresAt = new Date(occurredAt.getTime() + 60_000);
  return {
    id: consentId,
    status: "GRANTED",
    grantedAt: occurredAt,
    revokedAt: null,
    policyRevision: 7,
    consentVersion: 1,
    disclosureContractVersion: "cross-channel-contact-memory-v1",
    proofHash,
    challengeId,
    sourceEvidenceHash,
    confirmationEventHash,
    sourceEventClaim: {
      eventHash: confirmationEventHash,
      role: ContactMemorySharingSourceEventRole.CONFIRMATION,
      representativeId: "representative_1",
      audienceIdentityId: "identity_1",
      sourceChannel: RepresentativeChannelKind.WEB,
      challengeId,
      consentId,
    },
    challenge: {
      id: challengeId,
      sourceChannel: RepresentativeChannelKind.WEB,
      disclosureEventHash,
      createdAt,
      expiresAt,
      sourceEventClaims: [{
        eventHash: disclosureEventHash,
        role: ContactMemorySharingSourceEventRole.DISCLOSURE,
        representativeId: "representative_1",
        audienceIdentityId: "identity_1",
        sourceChannel: RepresentativeChannelKind.WEB,
        challengeId,
        consentId: null,
      }],
      audienceIdentityId: "identity_1",
      representativeId: "representative_1",
      policyRevision: 7,
      disclosureContractVersion: "cross-channel-contact-memory-v1",
      sourceEvidenceHash,
      consumedAt,
      revokedAt: null,
    },
  };
}

function asTransaction(value: Record<string, unknown>) {
  return value as unknown as Prisma.TransactionClient;
}
