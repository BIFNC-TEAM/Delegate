import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  claimMemoryChannelDisclosureDelivery,
  completeMemoryChannelDisclosureDelivery,
} from "../src/memory-disclosure";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("private-channel disclosure provider-ID race", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("atomically excludes the full triggering batch", async () => {
    const fixture = await createFixture();
    const claim = await claimMemoryChannelDisclosureDelivery({
      conversationId: fixture.conversationId,
      channel: "matrix",
      inboundExternalMessageIds: ["$batch-1", "$batch-2"],
    });
    expect(claim.send).toBe(true);
    if (!claim.send) throw new Error("Expected a new disclosure claim.");

    await expect(prisma.memoryChannelDisclosureExcludedInbound.findMany({
      where: { deliveryId: claim.deliveryId },
      orderBy: { externalInboundMessageId: "asc" },
      select: { externalInboundMessageId: true },
    })).resolves.toEqual([
      { externalInboundMessageId: "$batch-1" },
      { externalInboundMessageId: "$batch-2" },
    ]);
  });

  it("makes a pending claim append and delivery completion one row-lock order", async () => {
    const fixture = await createFixture();
    const first = await claimMemoryChannelDisclosureDelivery({
      conversationId: fixture.conversationId,
      channel: "matrix",
      inboundExternalMessageIds: ["$trigger"],
    });
    expect(first.send).toBe(true);
    if (!first.send) throw new Error("Expected a new disclosure claim.");

    const [concurrentClaim, completed] = await Promise.all([
      claimMemoryChannelDisclosureDelivery({
        conversationId: fixture.conversationId,
        channel: "matrix",
        inboundExternalMessageIds: ["$racing"],
      }),
      completeMemoryChannelDisclosureDelivery({
        deliveryId: first.deliveryId,
        leaseToken: first.leaseToken,
        externalMessageId: "$notice",
      }),
    ]);
    expect(completed).toBe(true);
    expect(concurrentClaim.send).toBe(false);

    const exclusion = await prisma.memoryChannelDisclosureExcludedInbound
      .findUnique({
        where: {
          deliveryId_externalInboundMessageId: {
            deliveryId: first.deliveryId,
            externalInboundMessageId: "$racing",
          },
        },
        select: { deliveryId: true },
      });
    if (concurrentClaim.send) {
      throw new Error("Concurrent claim unexpectedly acquired a new delivery.");
    }
    expect(Boolean(exclusion)).toBe(concurrentClaim.status === "in_flight");
  });

  it("excludes an earlier durable arrival when its validation finishes after a later delivery", async () => {
    const fixture = await createFixture();
    const releaseEarlierValidation = deferred<void>();
    const earlierArrivalPersisted = deferred<void>();

    const earlierRequest = (async () => {
      await persistProviderArrival(fixture, "$arrival-a", "txn-arrival-a");
      earlierArrivalPersisted.resolve(undefined);
      // Simulate slow remote room validation after provider arrival A has
      // already crossed the durable inbox boundary.
      await releaseEarlierValidation.promise;
      return claimMemoryChannelDisclosureDelivery({
        conversationId: fixture.conversationId,
        channel: "matrix",
        inboundExternalMessageIds: ["$arrival-a"],
      });
    })();

    await earlierArrivalPersisted.promise;
    await persistProviderArrival(fixture, "$arrival-b", "txn-arrival-b");
    const laterClaim = await claimMemoryChannelDisclosureDelivery({
      conversationId: fixture.conversationId,
      channel: "matrix",
      inboundExternalMessageIds: ["$arrival-b"],
    });
    expect(laterClaim.send).toBe(true);
    if (!laterClaim.send) throw new Error("Expected the later request to claim delivery.");
    await expect(completeMemoryChannelDisclosureDelivery({
      deliveryId: laterClaim.deliveryId,
      leaseToken: laterClaim.leaseToken,
      externalMessageId: "$notice-arrival-b",
    })).resolves.toBe(true);

    releaseEarlierValidation.resolve(undefined);
    const earlierClaim = await earlierRequest;
    expect(earlierClaim).toEqual({
      send: false,
      status: "current",
      deliveryId: laterClaim.deliveryId,
    });
    await expect(prisma.memoryChannelDisclosureExcludedInbound.findMany({
      where: { deliveryId: laterClaim.deliveryId },
      orderBy: { externalInboundMessageId: "asc" },
      select: { externalInboundMessageId: true },
    })).resolves.toEqual([
      { externalInboundMessageId: "$arrival-a" },
      { externalInboundMessageId: "$arrival-b" },
    ]);
  });

  it("activates after a binding epoch change using the conversation-wide ingress floor", async () => {
    const fixture = await createFixture();
    const oldEpochMessage = await prisma.message.create({
      data: {
        conversationId: fixture.conversationId,
        channelBindingId: fixture.bindingId,
        senderType: "AUDIENCE",
        text: "old binding message",
        clientMessageId: `$old-${fixture.conversationId}`,
        externalMessageId: `$old-${fixture.conversationId}`,
      },
      select: { ingressSequence: true },
    });
    expect(oldEpochMessage.ingressSequence).toBe(1);

    await prisma.conversationChannelBinding.delete({
      where: { id: fixture.bindingId },
    });
    const replacementBinding = await prisma.conversationChannelBinding.create({
      data: {
        conversationId: fixture.conversationId,
        kind: "MATRIX",
        externalConversationId: fixture.roomId,
        connectionId: `${fixture.connectionId}-replacement`,
        representativeAssignmentRevision: 2,
      },
    });
    const claim = await claimMemoryChannelDisclosureDelivery({
      conversationId: fixture.conversationId,
      channel: "matrix",
      inboundExternalMessageIds: ["$replacement-trigger"],
    });
    expect(claim.send).toBe(true);
    if (!claim.send) throw new Error("Expected replacement binding disclosure claim.");
    await expect(completeMemoryChannelDisclosureDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      externalMessageId: "$replacement-notice",
    })).resolves.toBe(true);
    await expect(prisma.memoryChannelDisclosureDelivery.findUnique({
      where: { id: claim.deliveryId },
      select: { deliveredAfterIngressSequence: true },
    })).resolves.toEqual({ deliveredAfterIngressSequence: 1 });

    const boundaryMessage = await prisma.message.create({
      data: {
        conversationId: fixture.conversationId,
        channelBindingId: replacementBinding.id,
        senderType: "AUDIENCE",
        text: "new binding boundary message",
        clientMessageId: "$replacement-trigger",
        externalMessageId: "$replacement-trigger",
      },
      select: { id: true, ingressSequence: true },
    });
    expect(boundaryMessage.ingressSequence).toBe(2);
    await expect(prisma.$transaction((tx) =>
      activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactId,
        conversationId: fixture.conversationId,
        messageId: boundaryMessage.id,
        channel: "matrix",
      }),
    )).resolves.toBe(true);
    await expect(prisma.memoryChannelDisclosureActivation.findUnique({
      where: { deliveryId: claim.deliveryId },
      select: {
        firstExcludedMessageId: true,
        firstExcludedIngressSequence: true,
      },
    })).resolves.toEqual({
      firstExcludedMessageId: boundaryMessage.id,
      firstExcludedIngressSequence: 2,
    });
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Disclosure race owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `disclosure-race-${suffix}`,
      displayName: "Disclosure race representative",
      roleSummary: "Exercises private-channel disclosure ordering.",
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
      namespaceKey: `disclosure-race-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: true,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
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
  const roomId = `!disclosure-race-${suffix}:example.test`;
  const connectionId = `matrix-connection-${suffix}`;
  const binding = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: conversation.id,
      kind: "MATRIX",
      externalConversationId: roomId,
      connectionId,
      representativeAssignmentRevision: 1,
    },
  });
  return {
    conversationId: conversation.id,
    representativeId: representative.id,
    contactId: contact.id,
    bindingId: binding.id,
    connectionId,
    roomId,
  };
}

async function persistProviderArrival(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  eventId: string,
  transactionId: string,
) {
  await prisma.channelEventInbox.create({
    data: {
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      connectionId: fixture.connectionId,
      originKey: `matrix:${fixture.connectionId}:${eventId}`,
      transactionId,
      externalEventId: eventId,
      eventType: "m.room.message",
      payload: {
        event_id: eventId,
        type: "m.room.message",
        room_id: fixture.roomId,
        sender: "@contact:example.test",
        content: { msgtype: "m.text", body: `body ${eventId}` },
      },
      status: "PENDING",
      attemptCount: 0,
    },
  });
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
