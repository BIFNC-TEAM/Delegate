import crypto from "node:crypto";

import { RepresentativeChannelKind } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  enqueueInboundMessageMemoryExtraction,
  invalidateMemoryExtractionForSourceMessage,
  processMemoryExtractionRun,
  processNextMemoryExtractionWork,
} from "../src/memory-extraction";
import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  claimMemoryChannelDisclosureDelivery,
  completeMemoryChannelDisclosureDelivery,
} from "../src/memory-disclosure";
import { requestAutomaticContactChannelMemoryDeletionInTransaction } from "../src/memory-governance";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory extraction PostgreSQL pipeline", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("queues Web work once and keeps disabled private-channel extraction off", async () => {
    const fixture = await createFixture();
    for (const channel of ["web"] as const) {
      const source = await createSource(fixture.representativeId, channel, {
        text: "I prefer concise replies",
      });
      const input = {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel,
      } as const;
      const first = await prisma.$transaction((tx) =>
        enqueueInboundMessageMemoryExtraction(tx, input),
      );
      if (!first.enqueued) throw new Error(first.reasonCode);
      expect(first).toMatchObject({ enqueued: true, replayed: false });
      expect(await prisma.memoryCandidate.count({
        where: { sourceMessageId: source.messageId },
      })).toBe(0);
      expect(await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: first.runId },
        select: { status: true, attemptCount: true },
      })).toEqual({ status: "QUEUED", attemptCount: 0 });

      const concurrentClaims = await Promise.all([
        processMemoryExtractionRun({ runId: first.runId }),
        processMemoryExtractionRun({ runId: first.runId }),
      ]);
      expect(concurrentClaims.filter((result) => result.processed)).toHaveLength(1);
      expect(concurrentClaims.filter((result) => !result.processed)).toHaveLength(1);
      expect(concurrentClaims.find((result) => result.processed)).toMatchObject({
        processed: true,
        runId: first.runId,
        status: "completed",
        attemptCount: 1,
      });

      const replay = await prisma.$transaction((tx) =>
        enqueueInboundMessageMemoryExtraction(tx, input),
      );
      expect(replay).toMatchObject({
        enqueued: true,
        replayed: true,
        runId: first.runId,
      });
      const candidates = await prisma.memoryCandidate.findMany({
        where: { sourceMessageId: source.messageId },
      });
      expect(candidates).toHaveLength(2);
      const contactCandidate = candidates.find(
        (candidate) => candidate.scope === "CONTACT_CHANNEL",
      );
      const representativeEvidence = candidates.find(
        (candidate) => candidate.scope === "REPRESENTATIVE",
      );
      expect(contactCandidate).toMatchObject({
        status: "APPROVED",
        safetyClass: "LOW_RISK",
        scope: "CONTACT_CHANNEL",
        originChannel: channel.toUpperCase(),
        scopeChannel: channel.toUpperCase(),
      });
      expect(contactCandidate?.safeText).not.toBe(source.rawText);
      expect(contactCandidate?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(representativeEvidence).toMatchObject({
        status: "EXTRACTED",
        safetyClass: "LOW_RISK",
        scope: "REPRESENTATIVE",
        contactId: null,
        scopeChannel: null,
      });
      expect(representativeEvidence?.deidentifiedAt).toBeInstanceOf(Date);
      expect(representativeEvidence?.safeText).not.toBe(source.rawText);
      expect(await prisma.memoryExtractionRun.count({
        where: { sourceMessageId: source.messageId },
      })).toBe(1);
      expect(await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: first.runId },
        select: { status: true, attemptCount: true, leaseToken: true },
      })).toEqual({ status: "SUCCEEDED", attemptCount: 1, leaseToken: null });
      expect(await prisma.governedMemory.count({
        where: { representativeId: fixture.representativeId },
      })).toBe(1);
      expect(await prisma.memoryProjectionItem.count({
        where: { representativeId: fixture.representativeId },
      })).toBe(1);
      expect(await prisma.memoryPolicyDecision.count({
        where: { representativeId: fixture.representativeId },
      })).toBe(2);
    }

    for (const channel of ["matrix", "telegram"] as const) {
      const source = await createSource(fixture.representativeId, channel, {
        text: `I prefer ${channel} replies`,
      });
      await expect(prisma.$transaction((tx) =>
        enqueueInboundMessageMemoryExtraction(tx, {
          representativeId: fixture.representativeId,
          contactId: source.contactId,
          conversationId: source.conversationId,
          messageId: source.messageId,
          channel,
        }),
      )).resolves.toEqual({
        enqueued: false,
        reasonCode: "channel_extraction_disabled",
      });
      expect(await prisma.memoryExtractionRun.count({
        where: { sourceMessageId: source.messageId },
      })).toBe(0);
      expect(await prisma.memoryCandidate.count({
        where: { sourceMessageId: source.messageId },
      })).toBe(0);
    }
  });

  it("does not revive queued Matrix extraction after its endpoint disconnects and reconnects", async () => {
    const fixture = await createMatrixLifecycleFixture();
    const queued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactId,
        conversationId: fixture.conversationId,
        messageId: fixture.sourceMessageId,
        channel: "matrix",
      }),
    );
    if (!queued.enqueued) throw new Error(queued.reasonCode);

    const lifecycleTransitionHasLock = deferred<void>();
    const releaseLifecycleTransition = deferred<void>();
    const lifecycleTransition = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`matrix-virtual-user:${fixture.representativeId}`})
        )
      `;
      lifecycleTransitionHasLock.resolve(undefined);
      await releaseLifecycleTransition.promise;
      await tx.representativeChannelBinding.update({
        where: { id: fixture.representativeBindingId },
        data: {
          desiredState: "DISCONNECTED",
          endpointLifecycleRevision: { increment: 1 },
        },
      });
      await tx.representativeChannelBinding.update({
        where: { id: fixture.representativeBindingId },
        data: {
          desiredState: "ACTIVE",
          endpointLifecycleRevision: { increment: 1 },
        },
      });
    });
    await lifecycleTransitionHasLock.promise;

    const processing = processMemoryExtractionRun({ runId: queued.runId });
    await waitForExtractionStatus(queued.runId, "RUNNING");
    releaseLifecycleTransition.resolve(undefined);

    await expect(lifecycleTransition).resolves.toBeUndefined();
    await expect(processing).resolves.toMatchObject({
      processed: true,
      runId: queued.runId,
      status: "canceled",
      attemptCount: 1,
    });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: queued.runId },
      select: { status: true, errorCode: true },
    })).resolves.toEqual({
      status: "CANCELED",
      errorCode: "matrix_memory_extraction_channel_lifecycle_changed",
    });
    await expect(prisma.representativeChannelBinding.findUniqueOrThrow({
      where: { id: fixture.representativeBindingId },
      select: { desiredState: true, endpointLifecycleRevision: true },
    })).resolves.toEqual({
      desiredState: "ACTIVE",
      endpointLifecycleRevision: 3,
    });
    await expect(processMemoryExtractionRun({ runId: queued.runId }))
      .resolves.toEqual({ processed: false });
    await expect(prisma.memoryCandidate.count({
      where: { sourceMessageId: fixture.sourceMessageId },
    })).resolves.toBe(0);
    await expect(prisma.governedMemory.count({
      where: { representativeId: fixture.representativeId },
    })).resolves.toBe(0);
    await expect(prisma.memoryProjectionItem.count({
      where: { representativeId: fixture.representativeId },
    })).resolves.toBe(0);
  });

  it("stores prohibited input only as a bodyless marker", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "web", {
      text: "I prefer password sk-proj-abcdefghijklmnopqrstuv",
    });
    const run = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "web",
      }),
    );
    if (!run.enqueued) throw new Error(run.reasonCode);
    expect(await prisma.memoryCandidate.count({
      where: { sourceMessageId: source.messageId },
    })).toBe(0);
    await expect(processMemoryExtractionRun({ runId: run.runId })).resolves
      .toMatchObject({ processed: true, status: "completed" });
    const marker = await prisma.memoryCandidate.findFirstOrThrow({
      where: { sourceMessageId: source.messageId },
    });
    expect(marker).toMatchObject({
      status: "BLOCKED",
      safetyClass: "PROHIBITED",
      safetyReasonCode: "credential_material_detected",
      safeText: null,
      summary: null,
      contentHash: null,
    });
    expect(marker.contentPurgedAt).toBeInstanceOf(Date);
  });

  it("automatically learns representative experience with contact memory disabled", async () => {
    const fixture = await createFixture();
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: {
        contactMemoryEnabled: false,
        representativeExperienceEnabled: true,
        autoExtract: true,
        webExtractEnabled: true,
      },
    });
    const firstSource = await createSource(fixture.representativeId, "web", {
      text: "I prefer concise replies",
    });
    const firstResult = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: firstSource.contactId,
        conversationId: firstSource.conversationId,
        messageId: firstSource.messageId,
        channel: "web",
      }),
    );
    expect(firstResult).toMatchObject({ enqueued: true, replayed: false });
    if (!firstResult.enqueued) throw new Error(firstResult.reasonCode);
    expect(await prisma.memoryCandidate.count({
      where: { sourceMessageId: firstSource.messageId },
    })).toBe(0);
    await expect(processMemoryExtractionRun({ runId: firstResult.runId })).resolves
      .toMatchObject({ processed: true, status: "completed" });
    const firstCandidate = await prisma.memoryCandidate.findFirstOrThrow({
      where: {
        sourceMessageId: firstSource.messageId,
        scope: "REPRESENTATIVE",
      },
    });
    expect(firstCandidate).toMatchObject({
      status: "EXTRACTED",
      scope: "REPRESENTATIVE",
      contactId: null,
      scopeChannel: null,
      category: "REPRESENTATIVE_RESPONSE_PATTERN",
    });
    expect(firstCandidate.deidentifiedAt).toBeInstanceOf(Date);
    expect(firstCandidate.safeText).not.toBe(firstSource.rawText);
    expect(await prisma.memoryPolicyDecision.findUniqueOrThrow({
      where: { candidateId: firstCandidate.id },
      select: { outcome: true },
    })).toEqual({ outcome: "EVIDENCE_RECORDED" });
    expect(await prisma.governedMemory.count({
      where: {
        representativeId: fixture.representativeId,
        scope: "REPRESENTATIVE",
      },
    })).toBe(0);
    expect(await prisma.memoryCandidate.count({
      where: {
        sourceMessageId: firstSource.messageId,
        scope: "CONTACT_CHANNEL",
      },
    })).toBe(0);

    const secondSource = await createSource(fixture.representativeId, "web", {
      text: "I prefer brief replies",
    });
    const secondResult = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: secondSource.contactId,
        conversationId: secondSource.conversationId,
        messageId: secondSource.messageId,
        channel: "web",
      }),
    );
    if (!secondResult.enqueued) throw new Error(secondResult.reasonCode);
    await expect(processMemoryExtractionRun({ runId: secondResult.runId })).resolves
      .toMatchObject({ processed: true, status: "completed" });
    const secondCandidate = await prisma.memoryCandidate.findFirstOrThrow({
      where: {
        sourceMessageId: secondSource.messageId,
        scope: "REPRESENTATIVE",
      },
    });
    expect(secondCandidate.status).toBe("APPROVED");
    expect(await prisma.memoryCandidate.count({
      where: {
        sourceMessageId: secondSource.messageId,
        scope: "CONTACT_CHANNEL",
      },
    })).toBe(0);
    expect(await prisma.memoryPolicyDecision.findUniqueOrThrow({
      where: { candidateId: secondCandidate.id },
      select: { outcome: true },
    })).toEqual({ outcome: "ACTIVATED" });
    expect(await prisma.governedMemory.count({
      where: {
        representativeId: fixture.representativeId,
        scope: "REPRESENTATIVE",
        status: "ACTIVE",
      },
    })).toBe(1);

    const representativeMemory = await prisma.governedMemory.findFirstOrThrow({
      where: {
        representativeId: fixture.representativeId,
        scope: "REPRESENTATIVE",
        status: "ACTIVE",
      },
    });
    await expect(prisma.$transaction((tx) =>
      invalidateMemoryExtractionForSourceMessage(tx, {
        messageId: firstSource.messageId,
        reasonCode: "source_message_redacted",
      })
    )).resolves.toMatchObject({
      purgedCandidateCount: 1,
      suppressedMemoryCount: 1,
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: representativeMemory.id },
      select: { status: true, recallDisabledAt: true },
    })).resolves.toMatchObject({
      status: "SUPPRESSED",
      recallDisabledAt: expect.any(Date),
    });
    await expect(prisma.memoryProjectionItem.findFirstOrThrow({
      where: { memoryId: representativeMemory.id },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toMatchObject({
      status: "DELETE_PENDING",
      deleteRequestedAt: expect.any(Date),
    });
  });

  it("turns the exact contact reply-preference forget command into deletion proof and cleanup", async () => {
    const fixture = await createFixture();
    const preferenceSource = await createSource(
      fixture.representativeId,
      "web",
      { text: "I prefer concise replies" },
    );
    const preferenceRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: preferenceSource.contactId,
        conversationId: preferenceSource.conversationId,
        messageId: preferenceSource.messageId,
        channel: "web",
      })
    );
    if (!preferenceRun.enqueued) throw new Error(preferenceRun.reasonCode);
    await expect(processMemoryExtractionRun({ runId: preferenceRun.runId }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    const memory = await prisma.governedMemory.findFirstOrThrow({
      where: {
        representativeId: fixture.representativeId,
        contactId: preferenceSource.contactId,
        sourceChannel: "WEB",
        semanticKey: "contact-preference:communication",
        status: "ACTIVE",
      },
    });
    const forgetMessage = await prisma.message.create({
      data: {
        conversationId: preferenceSource.conversationId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        text: "Forget my reply preference.",
        clientMessageId: `memory-forget-${crypto.randomUUID()}`,
        deliveryStatus: "SENT",
      },
    });
    const forgetRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: preferenceSource.contactId,
        conversationId: preferenceSource.conversationId,
        messageId: forgetMessage.id,
        channel: "web",
      })
    );
    if (!forgetRun.enqueued) throw new Error(forgetRun.reasonCode);
    await expect(processMemoryExtractionRun({ runId: forgetRun.runId }))
      .resolves.toMatchObject({
        processed: true,
        status: "completed",
      });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: forgetRun.runId },
      select: { candidateCount: true, reasonCounts: true },
    })).resolves.toEqual({
      candidateCount: 0,
      reasonCounts: { contact_reply_preference_forget_requested: 1 },
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: memory.id },
      select: { status: true, recallDisabledAt: true, deleteRequestedAt: true },
    })).resolves.toMatchObject({
      status: "DELETE_PENDING",
      recallDisabledAt: expect.any(Date),
      deleteRequestedAt: expect.any(Date),
    });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { memoryId: memory.id },
      select: {
        requestedByActorId: true,
        reasonCode: true,
        cleanupStatus: true,
      },
    })).resolves.toEqual({
      requestedByActorId: `system:contact:${preferenceSource.contactId}`,
      reasonCode: "contact_forget_reply_preference",
      cleanupStatus: "QUEUED",
    });
    expect(await prisma.memoryCandidate.count({
      where: { sourceMessageId: forgetMessage.id },
    })).toBe(0);
  });

  it("persists a bodyless cutoff when delete matches zero memories and cancels older queued work", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "web", {
      text: "I prefer concise replies",
    });
    const queued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "web",
      }),
    );
    if (!queued.enqueued) throw new Error(queued.reasonCode);

    const staleDeleteMessage = await prisma.message.create({
      data: {
        conversationId: source.conversationId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        text: "/forget.",
        clientMessageId: `memory-stale-delete-${crypto.randomUUID()}`,
        deliveryStatus: "SENT",
      },
    });
    const staleDeleteRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: staleDeleteMessage.id,
        channel: "web",
      }),
    );
    if (!staleDeleteRun.enqueued) throw new Error(staleDeleteRun.reasonCode);

    const deleteText = "Forget my memory.";
    const deleteMessage = await prisma.message.create({
      data: {
        conversationId: source.conversationId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        text: deleteText,
        clientMessageId: `memory-delete-zero-${crypto.randomUUID()}`,
        deliveryStatus: "SENT",
      },
    });
    const deletion = await prisma.$transaction((tx) =>
      requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceMessageId: deleteMessage.id,
        sourceHash: crypto.createHash("sha256").update(deleteText).digest("hex"),
        occurredAt: new Date(),
      }),
    );

    expect(deletion).toEqual({
      matchedCount: 0,
      queuedCount: 0,
      replayedCount: 0,
      memoryIds: [],
    });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: queued.runId },
      select: { status: true, errorCode: true, contactChannelMemoryEpoch: true },
    })).resolves.toEqual({
      status: "CANCELED",
      errorCode: "contact_channel_memory_forget_cutoff",
      contactChannelMemoryEpoch: 0,
    });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: staleDeleteRun.runId },
      select: { status: true, errorCode: true, contactChannelMemoryEpoch: true },
    })).resolves.toEqual({
      status: "CANCELED",
      errorCode: "contact_channel_memory_forget_cutoff",
      contactChannelMemoryEpoch: 0,
    });
    const boundary = await prisma.contactChannelMemoryForgetBoundary
      .findUniqueOrThrow({
        where: { sourceMessageId: deleteMessage.id },
      });
    expect(boundary).toMatchObject({
      representativeId: fixture.representativeId,
      contactId: source.contactId,
      sourceChannel: "WEB",
      epoch: 1,
      sourceConversationId: source.conversationId,
    });
    expect(boundary.requestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(boundary)).not.toContain("text");
    expect(Object.values(boundary).filter(
      (value): value is string => typeof value === "string",
    )).not.toContain(deleteText);
    await expect(prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "web",
      }),
    )).resolves.toEqual({
      enqueued: false,
      reasonCode: "contact_channel_memory_forget_cutoff",
    });
    await expect(prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: staleDeleteMessage.id,
        channel: "web",
      }),
    )).resolves.toEqual({
      enqueued: false,
      reasonCode: "contact_channel_memory_forget_cutoff",
    });
    await expect(processMemoryExtractionRun({ runId: queued.runId }))
      .resolves.toEqual({ processed: false });

    const laterMessage = await prisma.message.create({
      data: {
        conversationId: source.conversationId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        text: "I prefer detailed replies",
        clientMessageId: `memory-after-delete-${crypto.randomUUID()}`,
        deliveryStatus: "SENT",
      },
    });
    const laterRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: laterMessage.id,
        channel: "web",
      }),
    );
    if (!laterRun.enqueued) throw new Error(laterRun.reasonCode);
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: laterRun.runId },
      select: { contactChannelMemoryEpoch: true },
    })).resolves.toEqual({ contactChannelMemoryEpoch: 1 });
    await expect(processMemoryExtractionRun({ runId: laterRun.runId }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.governedMemory.count({
      where: {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        sourceChannel: "WEB",
        status: "ACTIVE",
      },
    })).resolves.toBe(1);
  });

  it("serializes a queued extraction racing an exact delete so stale memory cannot remain active", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "web", {
      text: "I prefer concise replies",
    });
    const queued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "web",
      }),
    );
    if (!queued.enqueued) throw new Error(queued.reasonCode);
    const deleteText = "delete my memory";
    const deleteMessage = await prisma.message.create({
      data: {
        conversationId: source.conversationId,
        senderType: "AUDIENCE",
        contentType: "TEXT",
        text: deleteText,
        clientMessageId: `memory-delete-race-${crypto.randomUUID()}`,
        deliveryStatus: "SENT",
      },
    });

    const [, deletion] = await Promise.all([
      processMemoryExtractionRun({ runId: queued.runId }),
      prisma.$transaction((tx) =>
        requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
          representativeId: fixture.representativeId,
          contactId: source.contactId,
          sourceChannel: RepresentativeChannelKind.WEB,
          sourceMessageId: deleteMessage.id,
          sourceHash: crypto.createHash("sha256").update(deleteText).digest("hex"),
          occurredAt: new Date(),
        }),
      ),
    ]);

    expect(deletion.matchedCount).toBeLessThanOrEqual(1);
    await expect(prisma.contactChannelMemoryForgetBoundary.count({
      where: {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        sourceChannel: "WEB",
      },
    })).resolves.toBe(1);
    await expect(prisma.governedMemory.count({
      where: {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        sourceChannel: "WEB",
        status: "ACTIVE",
      },
    })).resolves.toBe(0);
    const contactMemoryIds = (await prisma.governedMemory.findMany({
      where: {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        sourceChannel: "WEB",
      },
      select: { id: true },
    })).map((memory) => memory.id);
    await expect(prisma.memoryProjectionItem.count({
      where: {
        memoryId: { in: contactMemoryIds },
        status: { in: ["QUEUED", "PROJECTING", "ACTIVE", "RETRYING"] },
      },
    })).resolves.toBe(0);
  });

  it("persists retry backoff and moves the final attempt to FAILED", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "web", {
      text: "I prefer concise replies",
    });
    const enqueued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "web",
      }),
    );
    if (!enqueued.enqueued) throw new Error(enqueued.reasonCode);

    const firstLeaseToken = `retry-${crypto.randomUUID()}`;
    await prisma.memoryExtractionRun.update({
      where: { id: enqueued.runId },
      data: {
        status: "RUNNING",
        attemptCount: 1,
        leaseToken: firstLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      },
    });
    const retry = await processNextMemoryExtractionWork({
      claimNext: async () => ({
        runId: enqueued.runId,
        leaseToken: firstLeaseToken,
        attemptCount: 1,
      }),
      processClaim: async () => {
        throw new Error("private retry detail must not persist");
      },
    });
    expect(retry).toMatchObject({
      processed: true,
      status: "retrying",
      attemptCount: 1,
      errorCode: "memory_extraction_processing_failed",
    });
    const afterRetry = await prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: enqueued.runId },
      select: {
        status: true,
        attemptCount: true,
        availableAt: true,
        leaseToken: true,
        finishedAt: true,
        errorCode: true,
      },
    });
    expect(afterRetry).toMatchObject({
      status: "QUEUED",
      attemptCount: 1,
      leaseToken: null,
      finishedAt: null,
      errorCode: "memory_extraction_processing_failed",
    });
    expect(afterRetry.availableAt.getTime()).toBeGreaterThan(Date.now() - 100);
    expect(JSON.stringify(afterRetry)).not.toContain("private retry detail");
    await expect(processMemoryExtractionRun({ runId: enqueued.runId }))
      .resolves.toEqual({ processed: false });

    const finalLeaseToken = `final-${crypto.randomUUID()}`;
    await prisma.memoryExtractionRun.update({
      where: { id: enqueued.runId },
      data: {
        status: "RUNNING",
        attemptCount: 5,
        leaseToken: finalLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const failed = await processNextMemoryExtractionWork({
      claimNext: async () => ({
        runId: enqueued.runId,
        leaseToken: finalLeaseToken,
        attemptCount: 5,
      }),
      processClaim: async () => {
        throw new Error("private final detail must not persist");
      },
    });
    expect(failed).toEqual({
      processed: true,
      runId: enqueued.runId,
      status: "failed",
      attemptCount: 5,
      errorCode: "memory_extraction_processing_failed",
    });
    const finalRun = await prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: enqueued.runId },
      select: {
        status: true,
        attemptCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
        finishedAt: true,
        errorCode: true,
      },
    });
    expect(finalRun).toMatchObject({
      status: "FAILED",
      attemptCount: 5,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: "memory_extraction_processing_failed",
    });
    expect(finalRun.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(finalRun)).not.toContain("private final detail");

    const crashedSource = await createSource(
      fixture.representativeId,
      "web",
      { text: "I prefer detailed replies" },
    );
    const crashedRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: crashedSource.contactId,
        conversationId: crashedSource.conversationId,
        messageId: crashedSource.messageId,
        channel: "web",
      }),
    );
    if (!crashedRun.enqueued) throw new Error(crashedRun.reasonCode);
    await prisma.memoryExtractionRun.update({
      where: { id: crashedRun.runId },
      data: {
        status: "RUNNING",
        attemptCount: 5,
        leaseToken: `crashed-${crypto.randomUUID()}`,
        leaseExpiresAt: new Date(Date.now() - 1_000),
        startedAt: new Date(),
      },
    });
    await expect(processMemoryExtractionRun({ runId: crashedRun.runId }))
      .resolves.toEqual({ processed: false });
    const exhaustedRun = await prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: crashedRun.runId },
      select: {
        status: true,
        attemptCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
        finishedAt: true,
        errorCode: true,
      },
    });
    expect(exhaustedRun).toMatchObject({
      status: "FAILED",
      attemptCount: 5,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: "memory_extraction_attempts_exhausted",
    });
    expect(exhaustedRun.finishedAt).toBeInstanceOf(Date);
  });
});

async function createMatrixLifecycleFixture() {
  const suffix = crypto.randomUUID();
  const connectionId = `matrix-memory-lifecycle-${suffix}`;
  const owner = await prisma.owner.create({
    data: { displayName: `Matrix memory lifecycle owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `matrix-memory-lifecycle-${suffix}`,
      displayName: "Matrix memory lifecycle representative",
      roleSummary: "Exercises extraction endpoint lifecycle isolation.",
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `matrix-memory-lifecycle-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: true,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
    },
  });
  const representativeBinding = await prisma.representativeChannelBinding
    .create({
      data: {
        representativeId: representative.id,
        kind: "MATRIX",
        transport: "MATRIX",
        sourceProvider: "MATRIX",
        connectionId,
        endpointAssignmentRevision: 1,
        endpointLifecycleRevision: 1,
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        status: "CONNECTED",
      },
    });
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      sourceChannel: "MATRIX",
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "matrix",
    },
  });
  const channelBinding = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: conversation.id,
      representativeBindingId: representativeBinding.id,
      representativeAssignmentRevision: 1,
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      interactionMode: "PRIVATE_CHAT",
      connectionId,
      externalConversationId: `!memory-lifecycle-${suffix}:example.test`,
    },
  });

  const disclosureTriggerId = `$memory-lifecycle-disclosure-${suffix}`;
  const disclosure = await claimMemoryChannelDisclosureDelivery({
    conversationId: conversation.id,
    channel: "matrix",
    inboundExternalMessageIds: [disclosureTriggerId],
  });
  if (!disclosure.send) {
    throw new Error("Expected a new Matrix memory disclosure claim.");
  }
  if (!await completeMemoryChannelDisclosureDelivery({
    deliveryId: disclosure.deliveryId,
    leaseToken: disclosure.leaseToken,
    externalMessageId: `$memory-lifecycle-notice-${suffix}`,
  })) {
    throw new Error("Expected Matrix memory disclosure delivery to complete.");
  }
  const disclosureBoundary = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      channelBindingId: channelBinding.id,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: "Disclosure boundary message",
      clientMessageId: disclosureTriggerId,
      externalMessageId: disclosureTriggerId,
      deliveryStatus: "SENT",
    },
  });
  if (!await prisma.$transaction((tx) =>
    activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
      representativeId: representative.id,
      contactId: contact.id,
      conversationId: conversation.id,
      messageId: disclosureBoundary.id,
      channel: "matrix",
    })
  )) {
    throw new Error("Expected Matrix memory disclosure to activate.");
  }
  const sourceMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      channelBindingId: channelBinding.id,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: "I prefer concise replies",
      clientMessageId: `$memory-lifecycle-source-${suffix}`,
      externalMessageId: `$memory-lifecycle-source-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  return {
    representativeId: representative.id,
    representativeBindingId: representativeBinding.id,
    contactId: contact.id,
    conversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
  };
}

async function createFixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Memory extraction owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-extraction-${suffix}`,
      displayName: "Memory extraction representative",
      roleSummary: "Exercises candidate extraction.",
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `memory-extraction-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
      matrixExtractEnabled: false,
      telegramExtractEnabled: false,
    },
  });
  return { representativeId: representative.id };
}

async function waitForExtractionStatus(
  runId: string,
  expectedStatus: "RUNNING",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await prisma.memoryExtractionRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (run?.status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for memory extraction run ${runId} to become ${expectedStatus}.`,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createSource(
  representativeId: string,
  channel: "web" | "matrix" | "telegram",
  input: { text: string },
) {
  const contact = await prisma.contact.create({
    data: {
      representativeId,
      sourceChannel: channel.toUpperCase(),
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: channel.toUpperCase(),
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: input.text,
      clientMessageId: `memory-source-${crypto.randomUUID()}`,
      deliveryStatus: "SENT",
    },
  });
  return {
    contactId: contact.id,
    conversationId: conversation.id,
    messageId: message.id,
    rawText: input.text,
  };
}

function assertSafePostgresE2eTarget() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL E2E.");
  const databaseName = new URL(value).pathname.replace(/^\//u, "").toLowerCase();
  if (!/(?:test|e2e)/u.test(databaseName)) {
    throw new Error(
      `Refusing to run PostgreSQL E2E against non-test database ${databaseName}.`,
    );
  }
}
