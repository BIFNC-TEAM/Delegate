import { createHash, randomUUID } from "node:crypto";

import {
  Channel,
  MemoryExtractionStatus,
  MemoryExtractionTrigger,
  MessageContentType,
  MessageSenderType,
  RepresentativeChannelKind,
  type Prisma,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  executeMemoryDashboardAction,
  updateMemoryDashboardSettings,
} from "../src/memory-dashboard";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory dashboard PostgreSQL concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("replays an exact concurrent settings create after the unique race", async () => {
    const suffix = randomUUID();
    const owner = await prisma.owner.create({
      data: { displayName: `Memory dashboard owner ${suffix}` },
    });
    const representative = await prisma.representative.create({
      data: {
        ownerId: owner.id,
        slug: `memory-dashboard-concurrency-${suffix}`,
        displayName: "Memory dashboard concurrency",
        roleSummary: "Exercises idempotent settings writes.",
        tone: "clear",
        languages: ["en", "zh"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Escalate.",
        allowedSkills: [],
        actionGate: {},
      },
    });
    const barrier = createTwoPartyBarrier();
    const clients = [
      createAuditBarrierClient(barrier),
      createAuditBarrierClient(barrier),
    ];
    const request = {
      actorOwnerId: owner.id,
      representativeSlug: representative.slug,
      idempotencyKey: `settings-${suffix}`,
      update: {
        expectedRevision: 0,
        policy: {
          basic: {
            longTermMemoryEnabled: true,
            contactMemoryEnabled: true,
            representativeExperienceEnabled: false,
            autoExtract: true,
          },
          channels: {
            web: { recallEnabled: true, extractEnabled: true },
            matrix: { recallEnabled: false, extractEnabled: false },
            telegram: { recallEnabled: false, extractEnabled: false },
          },
          retention: { days: 30, expiryAction: "ARCHIVE" },
          advanced: {
            provider: "openviking",
            recallLimit: 6,
            recallThreshold: 0.01,
          },
        },
      },
    } as const;

    const responses = await Promise.all(clients.map((client, index) =>
      updateMemoryDashboardSettings({
        ...request,
        requestId: `settings-request-${index}-${suffix}`,
      }, { client: client as never }),
    ));

    expect(responses.map((response) => response.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(await prisma.representativeMemoryPolicy.count({
      where: { representativeId: representative.id },
    })).toBe(1);
    expect(await prisma.representativeMemoryPolicy.findUniqueOrThrow({
      where: { representativeId: representative.id },
      select: { revision: true },
    })).toEqual({ revision: 1 });
    expect(await prisma.eventAudit.count({
      where: { ownerId: owner.id, idempotencyKey: request.idempotencyKey },
    })).toBe(1);
  });

  it("replays a concurrent extraction retry with one semantic requeue", async () => {
    const suffix = randomUUID();
    const { owner, representative } = await createDashboardFixture(
      suffix,
      "extraction retry",
    );
    const contact = await prisma.contact.create({
      data: {
        representativeId: representative.id,
        externalUserId: `memory-dashboard-contact-${suffix}`,
        displayName: "Concurrency contact",
        sourceChannel: "web",
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        channel: Channel.PRIVATE_CHAT,
        sourceChannel: "web",
        externalConversationId: `memory-dashboard-conversation-${suffix}`,
      },
    });
    const sourceText = "I prefer concise replies";
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: MessageSenderType.AUDIENCE,
        contentType: MessageContentType.TEXT,
        text: sourceText,
      },
    });
    await createEnabledMemoryPolicy(representative.id, suffix);
    const sourceRevisionDigest = hashText(`${message.id}\u0000${sourceText}`);
    const failedAt = new Date();
    const extractionRun = await prisma.memoryExtractionRun.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
        trigger: MemoryExtractionTrigger.CHANNEL_MESSAGE,
        status: MemoryExtractionStatus.FAILED,
        idempotencyKey: [
          "memory-extraction",
          "v1",
          MemoryExtractionTrigger.CHANNEL_MESSAGE,
          "CONTACT_CHANNEL",
          "web",
          sourceRevisionDigest,
          "a".repeat(64),
        ].join(":"),
        attemptCount: 3,
        errorCode: "memory_extraction_attempts_exhausted",
        startedAt: failedAt,
        finishedAt: failedAt,
        createdAt: failedAt,
        updatedAt: failedAt,
      },
    });
    const barrier = createTwoPartyBarrier();
    const clients = [
      createAuditBarrierClient(barrier),
      createAuditBarrierClient(barrier),
    ];
    const idempotencyKey = `retry-extraction-${suffix}`;
    const action = {
      action: "retry_extraction",
      extractionRunId: extractionRun.id,
      expectedUpdatedAt: extractionRun.updatedAt.toISOString(),
      reasonCode: "owner_retry",
    } as const;
    const now = new Date();

    const responses = await Promise.all(clients.map((client, index) =>
      executeMemoryDashboardAction({
        actorOwnerId: owner.id,
        representativeSlug: representative.slug,
        requestId: `retry-extraction-request-${index}-${suffix}`,
        idempotencyKey,
        action,
      }, { client: client as never, now: () => now }),
    ));

    expect(responses.filter((response) => response.result.replayed)).toHaveLength(1);
    expect(responses.filter((response) => !response.result.replayed)).toHaveLength(1);
    expect(responses.map((response) => withoutReplay(response.result)))
      .toEqual([withoutReplay(responses[0]!.result), withoutReplay(responses[0]!.result)]);
    expect(responses[0]!.result).toMatchObject({
      action: "retry_extraction",
      target: { kind: "extraction", id: extractionRun.id },
      status: MemoryExtractionStatus.QUEUED,
      previousStatus: MemoryExtractionStatus.FAILED,
      previousAttemptCount: 3,
      previousErrorCode: "memory_extraction_attempts_exhausted",
    });
    expect(await prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: extractionRun.id },
      select: {
        status: true,
        attemptCount: true,
        errorCode: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    })).toEqual({
      status: MemoryExtractionStatus.QUEUED,
      attemptCount: 0,
      errorCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(await prisma.memoryExtractionRun.count({
      where: { id: extractionRun.id, representativeId: representative.id },
    })).toBe(1);
    expect(await prisma.eventAudit.count({
      where: { ownerId: owner.id, idempotencyKey },
    })).toBe(1);
  }, 30_000);

  it("replays a concurrent reconciliation enqueue with one queued run", async () => {
    const suffix = randomUUID();
    const { owner, representative } = await createDashboardFixture(
      suffix,
      "reconciliation enqueue",
    );
    await createEnabledMemoryPolicy(representative.id, suffix);
    const barrier = createTwoPartyBarrier();
    const clients = [
      createAuditBarrierClient(barrier),
      createAuditBarrierClient(barrier),
    ];
    const idempotencyKey = `reconciliation-${suffix}`;
    const now = new Date();

    const responses = await Promise.all(clients.map((client, index) =>
      executeMemoryDashboardAction({
        actorOwnerId: owner.id,
        representativeSlug: representative.slug,
        requestId: `reconciliation-request-${index}-${suffix}`,
        idempotencyKey,
        action: { action: "enqueue_reconciliation" },
      }, { client: client as never, now: () => now }),
    ));

    expect(responses.filter((response) => response.result.replayed)).toHaveLength(1);
    expect(responses.filter((response) => !response.result.replayed)).toHaveLength(1);
    expect(responses.map((response) => withoutReplay(response.result)))
      .toEqual([withoutReplay(responses[0]!.result), withoutReplay(responses[0]!.result)]);
    const runs = await prisma.memoryReconciliationRun.findMany({
      where: {
        representativeId: representative.id,
        idempotencyKey: `manual:${idempotencyKey}`,
      },
      select: { id: true, status: true, attemptCount: true },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "QUEUED", attemptCount: 0 });
    expect(responses[0]!.result).toMatchObject({
      action: "enqueue_reconciliation",
      runId: runs[0]!.id,
      status: "QUEUED",
    });
    expect(await prisma.eventAudit.count({
      where: { ownerId: owner.id, idempotencyKey },
    })).toBe(1);
  }, 30_000);
});

async function createDashboardFixture(suffix: string, purpose: string) {
  const owner = await prisma.owner.create({
    data: { displayName: `Memory dashboard owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-dashboard-concurrency-${purpose.replaceAll(" ", "-")}-${suffix}`,
      displayName: "Memory dashboard concurrency",
      roleSummary: `Exercises idempotent ${purpose}.`,
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  return { owner, representative };
}

function createEnabledMemoryPolicy(representativeId: string, suffix: string) {
  return prisma.representativeMemoryPolicy.create({
    data: {
      representativeId,
      namespaceKey: `memory-dashboard-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
    },
  });
}

function withoutReplay<T extends { replayed: boolean }>(result: T) {
  const { replayed: _replayed, ...semanticResult } = result;
  return semanticResult;
}

function hashText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type ReleaseBarrier = () => Promise<void>;

function createTwoPartyBarrier(): ReleaseBarrier {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await released;
  };
}

function createAuditBarrierClient(barrier: ReleaseBarrier) {
  let intercepted = false;
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) => target.$transaction(async (tx) => operation(new Proxy(tx, {
          get(transaction, transactionProperty, transactionReceiver) {
            if (transactionProperty !== "eventAudit") {
              return Reflect.get(
                transaction,
                transactionProperty,
                transactionReceiver,
              );
            }
            return new Proxy(transaction.eventAudit, {
              get(delegate, delegateProperty, delegateReceiver) {
                if (delegateProperty !== "findUnique") {
                  return Reflect.get(delegate, delegateProperty, delegateReceiver);
                }
                return async (...args: unknown[]) => {
                  const result = await Reflect.apply(
                    delegate.findUnique,
                    delegate,
                    args,
                  );
                  if (!intercepted) {
                    intercepted = true;
                    await barrier();
                  }
                  return result;
                };
              },
            });
          },
        })), options);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for memory dashboard PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing memory dashboard PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}
