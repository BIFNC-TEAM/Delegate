import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  enqueueInboundMessageMemoryExtraction,
  enqueueManualMemoryExtraction,
  processMemoryExtractionRun,
  processNextMemoryExtractionWork,
} from "../src/memory-extraction";
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

  it("queues Web, Matrix, and Telegram work and claims each run once", async () => {
    const fixture = await createFixture();
    const channelPreferences = {
      web: "I prefer concise replies",
      matrix: "I prefer detailed replies",
      telegram: "I prefer formal replies",
    } as const;
    for (const channel of ["web", "matrix", "telegram"] as const) {
      const source = await createSource(fixture.representativeId, channel, {
        text: channelPreferences[channel],
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
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        status: "PENDING_REVIEW",
        safetyClass: "LOW_RISK",
        scope: "CONTACT_CHANNEL",
        originChannel: channel.toUpperCase(),
        scopeChannel: channel.toUpperCase(),
      });
      expect(candidates[0]?.safeText).not.toBe(source.rawText);
      expect(candidates[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(await prisma.memoryExtractionRun.count({
        where: { sourceMessageId: source.messageId },
      })).toBe(1);
      expect(await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: first.runId },
        select: { status: true, attemptCount: true, leaseToken: true },
      })).toEqual({ status: "SUCCEEDED", attemptCount: 1, leaseToken: null });
      expect(await prisma.governedMemory.count({
        where: { representativeId: fixture.representativeId },
      })).toBe(0);
      expect(await prisma.memoryProjectionItem.count({
        where: { representativeId: fixture.representativeId },
      })).toBe(0);
    }
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

  it("keeps representative experience deidentified and pending manual review", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "matrix", {
      text: "I prefer concise replies",
    });
    const result = await enqueueManualMemoryExtraction({
      representativeId: fixture.representativeId,
      contactId: source.contactId,
      conversationId: source.conversationId,
      messageId: source.messageId,
      channel: "matrix",
      scope: "REPRESENTATIVE",
      requestId: `manual-${crypto.randomUUID()}`,
    });
    expect(result).toMatchObject({ enqueued: true, replayed: false });
    if (!result.enqueued) throw new Error(result.reasonCode);
    expect(await prisma.memoryCandidate.count({
      where: { sourceMessageId: source.messageId },
    })).toBe(0);
    await expect(processMemoryExtractionRun({ runId: result.runId })).resolves
      .toMatchObject({ processed: true, status: "completed" });
    const candidate = await prisma.memoryCandidate.findFirstOrThrow({
      where: { sourceMessageId: source.messageId },
    });
    expect(candidate).toMatchObject({
      status: "PENDING_REVIEW",
      scope: "REPRESENTATIVE",
      contactId: null,
      scopeChannel: null,
      category: "REPRESENTATIVE_RESPONSE_PATTERN",
    });
    expect(candidate.deidentifiedAt).toBeInstanceOf(Date);
    expect(candidate.safeText).not.toBe(source.rawText);
  });

  it("persists retry backoff and moves the final attempt to FAILED", async () => {
    const fixture = await createFixture();
    const source = await createSource(fixture.representativeId, "telegram", {
      text: "I prefer concise replies",
    });
    const enqueued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        channel: "telegram",
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
      "telegram",
      { text: "I prefer detailed replies" },
    );
    const crashedRun = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: crashedSource.contactId,
        conversationId: crashedSource.conversationId,
        messageId: crashedSource.messageId,
        channel: "telegram",
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
      webExtractEnabled: true,
      matrixExtractEnabled: true,
      telegramExtractEnabled: true,
    },
  });
  return { representativeId: representative.id };
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
