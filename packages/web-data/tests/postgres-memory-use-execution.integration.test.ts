import { createHash, randomUUID } from "node:crypto";

import { RepresentativeChannelKind } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  prepareGenerationMessageChannelDelivery,
  retryGenerationDelivery,
  withGenerationMessageProviderDeliveryFence,
} from "../src/conversation-platform";
import {
  applyAutomaticMemoryPolicyInTransaction,
  requestAutomaticContactChannelMemoryDeletionInTransaction,
} from "../src/memory-governance";
import {
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";
import {
  finalizeMemoryUseGenerationInTransaction,
  markMemoryUseItemsDisplayed,
  recordMemoryUseSearchHits,
  startOrReuseMemoryUseRun,
} from "../src/memory-use-execution";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory use PostgreSQL execution", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("tracks search, injection, citation, and Web display without crossing contacts", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    await expect(startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma })).resolves.toMatchObject({
      replayed: true,
      run: { id: started.run.id },
    });

    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: fixture.contactAProjectionId,
          searchRank: 1,
          searchScore: 0.96,
        },
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: fixture.contactBProjectionId,
          searchRank: 2,
          searchScore: 0.85,
        },
        {
          sourceKind: "PUBLIC_KNOWLEDGE",
          publicKnowledgeProjectionId: fixture.publicProjectionId,
          searchRank: 3,
          searchScore: 0.75,
        },
      ],
    }, { client: prisma });

    expect(recorded).toMatchObject({
      anonymousRejectedCount: 1,
      run: {
        unmappedCandidateCount: 1,
        searchedCount: 2,
        scopePassedCount: 2,
        safetyPassedCount: 2,
        injectedCount: 0,
        citedCount: 0,
        displayedCount: 0,
      },
    });
    expect(recorded.eligibleItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }),
      expect.objectContaining({
        sourceKind: "PUBLIC_KNOWLEDGE",
        publicKnowledgeProjectionId: fixture.publicProjectionId,
      }),
    ]));
    expect(recorded.eligibleItems).toHaveLength(2);

    const contactItem = recorded.eligibleItems.find(
      (item) => item.sourceKind === "CONTACT_MEMORY",
    )!;
    const publicItem = recorded.eligibleItems.find(
      (item) => item.sourceKind === "PUBLIC_KNOWLEDGE",
    )!;
    const finalized = await prisma.$transaction(async (tx) => {
      const output = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "A concise response grounded in automatically governed memory.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId: output.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      const result = await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId: output.id,
        injectedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
        citedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
      });
      return { output, result };
    });

    expect(finalized.result.run).toMatchObject({
      status: "COMPLETED",
      searchedCount: 2,
      scopePassedCount: 2,
      safetyPassedCount: 2,
      injectedCount: 2,
      citedCount: 2,
      displayedCount: 0,
    });
    await expect(prisma.messageCitation.findMany({
      where: { messageId: finalized.output.id },
      select: {
        title: true,
        excerpt: true,
        knowledgeAssetId: true,
        knowledgeRevision: true,
      },
      orderBy: { title: "asc" },
    })).resolves.toEqual([
      {
        title: "本人历史信息",
        excerpt: null,
        knowledgeAssetId: null,
        knowledgeRevision: null,
      },
      {
        title: "身份",
        excerpt: null,
        knowledgeAssetId: null,
        knowledgeRevision: fixture.representativeVersionId,
      },
    ]);

    await prisma.message.update({
      where: { id: finalized.output.id },
      data: { deliveryStatus: "SENT" },
    });
    await expect(markMemoryUseItemsDisplayed({
      useRunId: started.run.id,
      displayedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
    }, { client: prisma })).resolves.toMatchObject({
      displayedCount: 2,
    });
  });

  it("does not redeliver a completed answer after its cited memory is deleted", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const output = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "QUEUED",
          text: "A completed personalized answer that must not be replayed.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId: message.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId: message.id,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
      return message;
    });
    const outbox = await prisma.outboxEvent.create({
      data: {
        conversationId: fixture.conversationAId,
        aggregateType: "generation_run",
        aggregateId: fixture.generationRunId,
        eventType: "generation.requested",
        payload: {},
        status: "PROCESSING",
        idempotencyKey: `memory-delivery-retry-${randomUUID()}`,
        attemptCount: 1,
        availableAt: new Date(Date.now() + 60_000),
      },
    });

    await prepareGenerationMessageChannelDelivery({
      conversationId: fixture.conversationAId,
      runId: fixture.generationRunId,
      outboxId: outbox.id,
      leaseAttempt: 1,
      outputMessageId: output.id,
    });
    await expect(prisma.$transaction((tx) =>
      withGenerationMessageProviderDeliveryFence(
        tx,
        {
          conversationId: fixture.conversationAId,
          runId: fixture.generationRunId,
          outboxId: outbox.id,
          leaseAttempt: 1,
          outputMessageId: output.id,
        },
        async () => {
          throw new Error("simulated provider send failure");
        },
      ),
    )).rejects.toThrow("simulated provider send failure");
    await retryGenerationDelivery({
      runId: fixture.generationRunId,
      outboxId: outbox.id,
      leaseAttempt: 1,
      outputMessageId: output.id,
      errorMessage: "simulated provider send failure",
    });
    await prisma.outboxEvent.update({
      where: { id: outbox.id },
      data: {
        status: "PROCESSING",
        attemptCount: 2,
        availableAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.$transaction(async (tx) => {
      const deleteText = "删除我的记忆";
      const deleteMessage = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "AUDIENCE",
          deliveryStatus: "ACCEPTED",
          text: deleteText,
        },
      });
      await requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactAId,
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceMessageId: deleteMessage.id,
        sourceHash: createHash("sha256").update(deleteText).digest("hex"),
        occurredAt: new Date(),
      });
    });

    let replayProviderCalled = false;
    await expect(prisma.$transaction((tx) =>
      withGenerationMessageProviderDeliveryFence(
        tx,
        {
          conversationId: fixture.conversationAId,
          runId: fixture.generationRunId,
          outboxId: outbox.id,
          leaseAttempt: 2,
          outputMessageId: output.id,
        },
        async () => {
          replayProviderCalled = true;
          return "must-not-send";
        },
      ),
    )).resolves.toEqual({
      executed: false,
      reason: "memory_delivery_source_revoked",
    });
    expect(replayProviderCalled).toBe(false);
    await expect(prisma.message.findUniqueOrThrow({
      where: { id: output.id },
      select: { deliveryStatus: true, failureCode: true, text: true },
    })).resolves.toEqual({
      deliveryStatus: "CANCELED",
      failureCode: "generation_memory_delivery_source_revoked",
      text: "A completed personalized answer that must not be replayed.",
    });
    await expect(prisma.outboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
      select: { status: true, attemptCount: true, lastError: true },
    })).resolves.toEqual({
      status: "DEAD_LETTER",
      attemptCount: 2,
      lastError: "generation_memory_delivery_source_revoked",
    });
  });

  it("serializes forget between final authorization and the provider side effect", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const output = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "QUEUED",
          text: "A personalized answer whose send must be linearized with forget.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId: message.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId: message.id,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
      return message;
    });
    const outbox = await prisma.outboxEvent.create({
      data: {
        conversationId: fixture.conversationAId,
        aggregateType: "generation_run",
        aggregateId: fixture.generationRunId,
        eventType: "generation.requested",
        payload: {},
        status: "PROCESSING",
        idempotencyKey: `memory-provider-fence-${randomUUID()}`,
        attemptCount: 1,
        availableAt: new Date(Date.now() + 60_000),
      },
    });
    await prepareGenerationMessageChannelDelivery({
      conversationId: fixture.conversationAId,
      runId: fixture.generationRunId,
      outboxId: outbox.id,
      leaseAttempt: 1,
      outputMessageId: output.id,
    });

    const deleteText = "forget my memory";
    const deleteMessage = await prisma.message.create({
      data: {
        conversationId: fixture.conversationAId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        deliveryStatus: "SENT",
        text: deleteText,
      },
    });
    const providerAuthorized = createDeferred<void>();
    const allowProviderSideEffect = createDeferred<void>();
    let providerSideEffectExecuted = false;
    let sequence = 0;
    let providerSideEffectOrder = 0;
    let deletionCommitOrder = 0;
    const providerOutcome = prisma.$transaction(async (tx) =>
      withGenerationMessageProviderDeliveryFence(
        tx,
        {
          conversationId: fixture.conversationAId,
          runId: fixture.generationRunId,
          outboxId: outbox.id,
          leaseAttempt: 1,
          outputMessageId: output.id,
        },
        async () => {
          providerAuthorized.resolve();
          await allowProviderSideEffect.promise;
          providerSideEffectExecuted = true;
          providerSideEffectOrder = ++sequence;
          return "provider-message-id";
        },
      ),
    { timeout: 10_000 });
    await providerAuthorized.promise;

    const deletionBackendReady = createDeferred<number>();
    const deletion = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid()::INTEGER AS pid",
      );
      if (!backend) throw new Error("Could not identify deletion backend.");
      deletionBackendReady.resolve(backend.pid);
      await requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactAId,
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceMessageId: deleteMessage.id,
        sourceHash: createHash("sha256").update(deleteText).digest("hex"),
        occurredAt: new Date(),
      });
    }, { timeout: 10_000 }).then(() => {
      deletionCommitOrder = ++sequence;
    });

    const deletionBackendPid = await deletionBackendReady.promise;
    await waitForBackendLock(deletionBackendPid);
    expect(providerSideEffectExecuted).toBe(false);
    expect(deletionCommitOrder).toBe(0);

    allowProviderSideEffect.resolve();
    await expect(providerOutcome).resolves.toEqual({
      executed: true,
      value: "provider-message-id",
    });
    await deletion;

    expect(providerSideEffectExecuted).toBe(true);
    expect(providerSideEffectOrder).toBeGreaterThan(0);
    expect(deletionCommitOrder).toBeGreaterThan(providerSideEffectOrder);
    await expect(prisma.contactChannelMemoryForgetBoundary.count({
      where: {
        representativeId: fixture.representativeId,
        contactId: fixture.contactAId,
        sourceChannel: "WEB",
      },
    })).resolves.toBe(1);
  });

  it("keeps an Episode-pinned memory run valid after a newer release becomes active", async () => {
    const fixture = await createFixture();
    const nextVersion = await prisma.representativeVersion.create({
      data: {
        representativeId: fixture.representativeId,
        versionNumber: 2,
        status: "PUBLISHED",
        snapshot: { knowledgeAssets: [] },
      },
    });
    await prisma.representative.update({
      where: { id: fixture.representativeId },
      data: { activeVersionId: nextVersion.id },
    });

    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "PUBLIC_KNOWLEDGE",
        publicKnowledgeProjectionId: fixture.publicProjectionId,
      }],
    }, { client: prisma });
    const publicItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const output = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "Reply from the Episode-pinned release.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId: message.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId: message.id,
        injectedItemIds: [publicItemId],
        citedItemIds: [],
      });
      return message;
    });

    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: {
        representativeVersionId: true,
        outputMessageId: true,
        status: true,
        injectedCount: true,
      },
    })).resolves.toEqual({
      representativeVersionId: fixture.representativeVersionId,
      outputMessageId: output.id,
      status: "COMPLETED",
      injectedCount: 1,
    });
  });

  it("stops an open memory run when the conversation moves to another Episode", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const nextEpisode = await prisma.conversationEpisode.create({
      data: {
        conversationId: fixture.conversationAId,
        representativeVersionId: fixture.representativeVersionId,
        sequence: 2,
        status: "ACTIVE",
      },
    });
    await prisma.$transaction([
      prisma.conversationEpisode.update({
        where: { id: fixture.episodeAId },
        data: { status: "RESOLVED", endedAt: new Date() },
      }),
      prisma.conversation.update({
        where: { id: fixture.conversationAId },
        data: { activeEpisodeId: nextEpisode.id },
      }),
    ]);

    await expect(recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "PUBLIC_KNOWLEDGE",
        publicKnowledgeProjectionId: fixture.publicProjectionId,
      }],
    }, { client: prisma })).rejects.toMatchObject({
      code: "memory_use_scope_conflict",
    });
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { searchedCount: true, injectedCount: true },
    })).resolves.toEqual({ searchedCount: 0, injectedCount: 0 });
  });

  it("rolls back the output when a selected memory is withdrawn before injection", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;

    const blockedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: fixture.contactAMemoryId },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: blockedAt,
        suppressedAt: blockedAt,
      },
    });
    const outputMessageId = `rolled_back_output_${randomUUID()}`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: outputMessageId,
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "This output must roll back.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: { outputMessageId },
      });
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
    })).rejects.toMatchObject({ code: "memory_use_source_rejected" });

    await expect(prisma.message.findUnique({
      where: { id: outputMessageId },
    })).resolves.toBeNull();
    await expect(prisma.generationRun.findUniqueOrThrow({
      where: { id: fixture.generationRunId },
      select: { outputMessageId: true },
    })).resolves.toEqual({ outputMessageId: null });
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { status: true, injectedCount: true, citedCount: true },
    })).resolves.toEqual({
      status: "STARTED",
      injectedCount: 0,
      citedCount: 0,
    });
  });

  it("blocks a racing injection until withdrawal commits, then revalidates fail-closed", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const withdrawalLocked = createDeferred<void>();
    const releaseWithdrawal = createDeferred<void>();

    const withdrawal = prisma.$transaction(async (tx) => {
      const blockedAt = new Date();
      await tx.governedMemory.update({
        where: { id: fixture.contactAMemoryId },
        data: {
          status: "SUPPRESSED",
          recallDisabledAt: blockedAt,
          suppressedAt: blockedAt,
        },
      });
      withdrawalLocked.resolve();
      await releaseWithdrawal.promise;
    }, { timeout: 10_000 });
    await withdrawalLocked.promise;

    const outputMessageId = `racing_output_${randomUUID()}`;
    const finalizationBackendReady = createDeferred<number>();
    const finalizationOutcome = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid()::INTEGER AS pid",
      );
      if (!backend) throw new Error("Could not identify finalization backend.");
      await tx.message.create({
        data: {
          id: outputMessageId,
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "This racing output must roll back.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      finalizationBackendReady.resolve(backend.pid);
      return finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
    }, { timeout: 10_000 }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const finalizationBackendPid = await finalizationBackendReady.promise;
    await waitForBackendLock(finalizationBackendPid);
    releaseWithdrawal.resolve();
    await withdrawal;

    const outcome = await finalizationOutcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("Racing injection unexpectedly committed.");
    }
    expect(String(outcome.error)).toMatch(
      /memory was not active, current, independently reviewed, policy-enabled, and recall-projected at injection/u,
    );
    await expect(prisma.message.findUnique({
      where: { id: outputMessageId },
    })).resolves.toBeNull();
    await expect(prisma.generationRun.findUniqueOrThrow({
      where: { id: fixture.generationRunId },
      select: { status: true, outputMessageId: true, completedAt: true },
    })).resolves.toEqual({
      status: "PROCESSING",
      outputMessageId: null,
      completedAt: null,
    });
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { status: true, injectedCount: true, citedCount: true },
    })).resolves.toEqual({
      status: "STARTED",
      injectedCount: 0,
      citedCount: 0,
    });
  });

  it("blocks final injection behind a concurrent exact-delete boundary and rolls the output back", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const deleteText = "forget my memory";
    const deleteMessage = await prisma.message.create({
      data: {
        conversationId: fixture.conversationAId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        deliveryStatus: "SENT",
        text: deleteText,
      },
    });
    const deletionLocked = createDeferred<void>();
    const releaseDeletion = createDeferred<void>();
    const deletion = prisma.$transaction(async (tx) => {
      await requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactAId,
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceMessageId: deleteMessage.id,
        sourceHash: createHash("sha256").update(deleteText).digest("hex"),
        occurredAt: new Date(),
      });
      deletionLocked.resolve();
      await releaseDeletion.promise;
    }, { timeout: 10_000 });
    await deletionLocked.promise;

    const outputMessageId = `forget_racing_output_${randomUUID()}`;
    const finalizationBackendReady = createDeferred<number>();
    const finalizationOutcome = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid()::INTEGER AS pid",
      );
      if (!backend) throw new Error("Could not identify finalization backend.");
      await tx.message.create({
        data: {
          id: outputMessageId,
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "This output cannot outlive the exact-delete boundary.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      finalizationBackendReady.resolve(backend.pid);
      return finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
    }, { timeout: 10_000 }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const finalizationBackendPid = await finalizationBackendReady.promise;
    await waitForBackendLock(finalizationBackendPid);
    releaseDeletion.resolve();
    await deletion;

    const outcome = await finalizationOutcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("Exact-delete racing injection unexpectedly committed.");
    }
    expect(outcome.error).toMatchObject({ code: "memory_use_source_rejected" });
    await expect(prisma.message.findUnique({
      where: { id: outputMessageId },
    })).resolves.toBeNull();
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { status: true, injectedCount: true, citedCount: true },
    })).resolves.toEqual({
      status: "STARTED",
      injectedCount: 0,
      citedCount: 0,
    });
    await expect(prisma.contactChannelMemoryForgetBoundary.count({
      where: {
        representativeId: fixture.representativeId,
        contactId: fixture.contactAId,
        sourceChannel: "WEB",
      },
    })).resolves.toBe(1);
  });
});

async function createFixture() {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Memory use owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-use-${suffix}`,
      displayName: "Memory use representative",
      roleSummary: "Tests the authoritative memory-use ledger.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const representativeVersion = await prisma.representativeVersion.create({
    data: {
      representativeId: representative.id,
      versionNumber: 1,
      status: "PUBLISHED",
      snapshot: { knowledgeAssets: [] },
    },
  });
  await prisma.representative.update({
    where: { id: representative.id },
    data: { activeVersionId: representativeVersion.id },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `memory-use-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
    },
  });

  const contactA = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const contactB = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const conversationA = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contactA.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });
  const conversationB = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contactB.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });
  const episodeA = await prisma.conversationEpisode.create({
    data: {
      conversationId: conversationA.id,
      representativeVersionId: representativeVersion.id,
      sequence: 1,
      status: "ACTIVE",
    },
  });
  await prisma.conversation.update({
    where: { id: conversationA.id },
    data: { activeEpisodeId: episodeA.id },
  });

  const contactAMemory = await createAutomaticallyActivatedContactMemory({
    representativeId: representative.id,
    contactId: contactA.id,
    conversationId: conversationA.id,
    preference: "concise",
    suffix: `${suffix}-a`,
  });
  const contactBMemory = await createAutomaticallyActivatedContactMemory({
    representativeId: representative.id,
    contactId: contactB.id,
    conversationId: conversationB.id,
    preference: "detailed",
    suffix: `${suffix}-b`,
  });
  const provider = new SuccessfulProjectionProvider();
  await runNextMemoryProjectionWrite({
    client: prisma,
    representativeId: representative.id,
    provider,
  });
  await runNextMemoryProjectionWrite({
    client: prisma,
    representativeId: representative.id,
    provider,
  });

  const inputMessage = await prisma.message.create({
    data: {
      conversationId: conversationA.id,
      senderType: "AUDIENCE",
      text: "How should I proceed?",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: conversationA.id,
      episodeId: episodeA.id,
      inputMessageId: inputMessage.id,
      representativeVersionId: representativeVersion.id,
      status: "PROCESSING",
      idempotencyKey: `memory-use-generation-${suffix}`,
    },
  });
  const publicSafeText = `published-profile-${suffix}`;
  const publicHash = createHash("sha256").update(publicSafeText).digest("hex");
  await prisma.representativeVersionResource.create({
    data: {
      representativeId: representative.id,
      publishedVersionId: representativeVersion.id,
      sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
      resourceKey: "identity/profile.md",
      contentHash: publicHash,
      safeText: publicSafeText,
      citationTitle: "Identity",
    },
  });
  const publicProjection = await prisma.publicKnowledgeProjectionItem.create({
    data: {
      representativeId: representative.id,
      publishedVersionId: representativeVersion.id,
      sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
      resourceKey: "identity/profile.md",
      contentHash: publicHash,
      remoteUri:
        `viking://resources/delegate/reps/${representative.slug}/versions/`
        + `${representativeVersion.id}/identity/profile.md`,
      projectedAt: new Date(),
    },
  });

  return {
    representativeId: representative.id,
    contactAId: contactA.id,
    representativeVersionId: representativeVersion.id,
    conversationAId: conversationA.id,
    episodeAId: episodeA.id,
    generationRunId: generationRun.id,
    contactAMemoryId: contactAMemory.memoryId,
    contactAProjectionId: contactAMemory.projectionId,
    contactBProjectionId: contactBMemory.projectionId,
    publicProjectionId: publicProjection.id,
  };
}

async function createAutomaticallyActivatedContactMemory(input: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  preference: "concise" | "detailed";
  suffix: string;
}) {
  const sourceMessage = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      senderType: "AUDIENCE",
      text: `I prefer ${input.preference} replies`,
    },
  });
  const safeText = `Preference: reply_length=${input.preference}`;
  const contentHash = createHash("sha256").update(safeText).digest("hex");
  const candidate = await prisma.memoryCandidate.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      scope: "CONTACT_CHANNEL",
      scopeChannel: "WEB",
      originChannel: "WEB",
      category: "CONTACT_PREFERENCE",
      sourceKind: "AUDIENCE_MESSAGE",
      safeText,
      summary: safeText,
      contentHash,
      semanticKey: "contact-preference:communication",
      dedupeKey: `memory-use-candidate-${input.suffix}`,
      status: "PENDING_REVIEW",
      safetyClass: "LOW_RISK",
      extractionReasonCode: "explicit_contact_preference",
      sourceContactId: input.contactId,
      sourceConversationId: input.conversationId,
      sourceMessageId: sourceMessage.id,
    },
  });
  const activated = await prisma.$transaction((tx) =>
    applyAutomaticMemoryPolicyInTransaction(tx, {
      candidateId: candidate.id,
      sourceHash: createHash("sha256")
        .update(sourceMessage.text ?? "")
        .digest("hex"),
      confidence: 1,
    }),
  );
  if (!activated.memoryId || !activated.memoryVersionId) {
    throw new Error("Automatic policy did not create governed memory coordinates.");
  }
  const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
    where: {
      memoryId: activated.memoryId,
      memoryVersionId: activated.memoryVersionId,
    },
  });
  return {
    memoryId: activated.memoryId,
    projectionId: projection.id,
  };
}

class SuccessfulProjectionProvider implements MemoryProjectionProvider {
  readonly name = "openviking";

  async ensureRoot(input: { rootUri: string }) {
    return { rootUri: input.rootUri, receipt: `ensure:${input.rootUri}` };
  }

  async writeExact(input: { uri: string; contentHash: string }) {
    return {
      uri: input.uri,
      contentHash: input.contentHash,
      receipt: `write:${input.uri}`,
    };
  }

  async inspectExact(input: { uri: string }) {
    const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
      where: { remoteUri: input.uri },
      select: { contentHash: true },
    });
    return {
      uri: input.uri,
      exists: true,
      contentHash: projection.contentHash,
      receipt: `inspect:${input.uri}`,
    };
  }

  async deleteExact(input: { uri: string }) {
    return {
      uri: input.uri,
      outcome: "deleted" as const,
      receipt: `delete:${input.uri}`,
    };
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForBackendLock(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [activity] = await prisma.$queryRawUnsafe<Array<{
      waitEventType: string | null;
      waitEvent: string | null;
    }>>(`
      SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
        FROM pg_stat_activity
       WHERE pid = ${pid}
    `);
    if (activity?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on the withdrawal row lock.`);
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for Memory use PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing Memory use PostgreSQL E2E against ${host}/${database}.`);
  }
}
