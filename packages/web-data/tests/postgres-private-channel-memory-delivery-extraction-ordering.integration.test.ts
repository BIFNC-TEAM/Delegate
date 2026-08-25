import { randomUUID } from "node:crypto";

import {
  ChannelDesiredState,
  ChannelHealthStatus,
  Prisma,
  TelegramBotConnectionScope,
  TelegramBotConnectionStatus,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  admitGenerationMessageProviderDelivery,
  markGenerationDeliveryComplete,
  prepareGenerationMessageChannelDelivery,
  withGenerationMessageProviderDeliveryFence,
} from "../src/conversation-platform";
import {
  enqueueInboundMessageMemoryExtraction,
  processMemoryExtractionRunInTransaction,
} from "../src/memory-extraction";
import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  claimMemoryChannelDisclosureDelivery,
  completeMemoryChannelDisclosureDelivery,
} from "../src/memory-disclosure";
import {
  finalizeMemoryUseGenerationInTransaction,
  startOrReuseMemoryUseRun,
} from "../src/memory-use-execution";
import { withActiveMatrixRepresentativeChannelFence } from "../src/matrix-room-security";
import { prisma } from "../src/prisma";
import { withActiveTelegramRepresentativeChannelFence } from "../src/telegram-channel-security";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("private-channel extraction and final provider delivery lock order", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  for (const channel of ["matrix", "telegram"] as const) {
    it(`does not deadlock or fail ${channel} delivery while extracting the same contact-channel memory`, async () => {
      const fixture = await createPrivateChannelFixture(channel);
      const queued = await prisma.$transaction((tx) =>
        enqueueInboundMessageMemoryExtraction(tx, {
          representativeId: fixture.representativeId,
          contactId: fixture.contactId,
          conversationId: fixture.conversationId,
          messageId: fixture.inputMessageId,
          channel,
        }),
      );
      if (!queued.enqueued) throw new Error(queued.reasonCode);

      const providerHasChannelFence = deferred<void>();
      const allowProviderMemoryFence = deferred<void>();
      let providerSideEffectCount = 0;
      const generationDelivery = {
        runId: fixture.generationRunId,
        outboxId: fixture.outboxId,
        leaseAttempt: 1,
        outputMessageId: fixture.outputMessageId,
        deliveryAdmission: fixture.deliveryAdmission,
      };

      const providerDelivery = channel === "matrix"
        ? withActiveMatrixRepresentativeChannelFence(
            {
              representativeId: fixture.representativeId,
              representativeMatrixUserId:
                fixture.representativeMatrixUserId!,
              expectedEndpointLifecycleRevision: 1,
            },
            async (tx) => {
              providerHasChannelFence.resolve();
              await allowProviderMemoryFence.promise;
              return withGenerationMessageProviderDeliveryFence(
                tx,
                {
                  conversationId: fixture.conversationId,
                  ...generationDelivery,
                },
                async () => {
                  providerSideEffectCount += 1;
                  return `$provider-${randomUUID()}`;
                },
              );
            },
          )
        : withActiveTelegramRepresentativeChannelFence(
            {
              conversationId: fixture.conversationId,
              expectedConnectionId: fixture.connectionId,
            },
            async (tx) => {
              providerHasChannelFence.resolve();
              await allowProviderMemoryFence.promise;
              return withGenerationMessageProviderDeliveryFence(
                tx,
                {
                  conversationId: fixture.conversationId,
                  ...generationDelivery,
                },
                async () => {
                  providerSideEffectCount += 1;
                  return String(Math.floor(Math.random() * 1_000_000) + 1);
                },
              );
            },
          );
      await providerHasChannelFence.promise;

      const extractionBackendReady = deferred<number>();
      const extraction = prisma.$transaction(async (tx) => {
        const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::INTEGER AS pid",
        );
        if (!backend) throw new Error("Could not identify extraction backend.");
        extractionBackendReady.resolve(backend.pid);
        return processMemoryExtractionRunInTransaction(tx, {
          runId: queued.runId,
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
      const extractionBackendPid = await extractionBackendReady.promise;

      // Extraction is waiting for the provider's endpoint fence. With the
      // canonical channel -> contact order it cannot own the contact-memory
      // coordinate yet. A regression to contact -> channel would own that
      // coordinate here and deadlock as the provider proceeds into its memory
      // delivery fence.
      await waitForBackendLock(extractionBackendPid);
      allowProviderMemoryFence.resolve();

      const [providerSettlement, extractionSettlement] =
        await Promise.allSettled([providerDelivery, extraction]);
      assertFulfilledWithoutDatabaseDeadlock(
        `${channel} final provider delivery`,
        providerSettlement,
      );
      assertFulfilledWithoutDatabaseDeadlock(
        `${channel} memory extraction`,
        extractionSettlement,
      );
      expect(providerSettlement.value).toMatchObject({
        executed: true,
        value: { executed: true },
      });
      expect(extractionSettlement.value).toMatchObject({
        processed: true,
        runId: queued.runId,
        status: "SUCCEEDED",
      });
      expect(providerSideEffectCount).toBe(1);

      if (
        !providerSettlement.value.executed
        || !providerSettlement.value.value.executed
      ) {
        throw new Error(`${channel} provider side effect did not execute.`);
      }
      await markGenerationDeliveryComplete({
        ...generationDelivery,
        externalMessageId: providerSettlement.value.value.value,
      });
      await expect(prisma.message.findUniqueOrThrow({
        where: { id: fixture.outputMessageId },
        select: { deliveryStatus: true, externalMessageId: true },
      })).resolves.toMatchObject({
        deliveryStatus: "SENT",
        externalMessageId: expect.any(String),
      });
      await expect(prisma.outboxEvent.findUniqueOrThrow({
        where: { id: fixture.outboxId },
        select: { status: true },
      })).resolves.toEqual({ status: "PROCESSED" });
      await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: queued.runId },
        select: { status: true, errorCode: true, attemptCount: true },
      })).resolves.toEqual({
        status: "SUCCEEDED",
        errorCode: null,
        attemptCount: 1,
      });
      await expect(prisma.memoryCandidate.count({
        where: { sourceMessageId: fixture.inputMessageId },
      })).resolves.toBeGreaterThan(0);
    }, 30_000);
  }
});

async function createPrivateChannelFixture(
  channel: "matrix" | "telegram",
) {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Private memory ordering owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `private-memory-ordering-${suffix}`,
      displayName: "Private memory ordering representative",
      roleSummary: "Exercises private-channel memory lock ordering.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const version = await prisma.representativeVersion.create({
    data: {
      representativeId: representative.id,
      versionNumber: 1,
      status: "PUBLISHED",
      snapshot: { knowledgeAssets: [] },
    },
  });
  await prisma.representative.update({
    where: { id: representative.id },
    data: {
      activeVersionId: version.id,
      lifecycleState: "PUBLISHED",
    },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `private-memory-ordering-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: true,
      matrixRecallEnabled: channel === "matrix",
      matrixExtractEnabled: channel === "matrix",
      telegramRecallEnabled: channel === "telegram",
      telegramExtractEnabled: channel === "telegram",
    },
  });

  const connectionId = channel === "matrix"
    ? `matrix-memory-ordering-${suffix}`
    : `70${Date.now()}${Math.floor(Math.random() * 100_000)}`;
  let telegramBotConnectionId: string | undefined;
  if (channel === "telegram") {
    const connection = await prisma.telegramBotConnection.create({
      data: {
        ownerId: owner.id,
        scope: TelegramBotConnectionScope.OWNER_MANAGED,
        botId: connectionId,
        username: `memory_ordering_${suffix.replaceAll("-", "_")}`,
        displayName: "Private memory ordering bot",
        status: TelegramBotConnectionStatus.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        credentialRevision: 1,
      },
    });
    telegramBotConnectionId = connection.id;
  }

  const representativeMatrixUserId = channel === "matrix"
    ? `@delegate_memory_${suffix.replaceAll("-", "_")}:example.test`
    : undefined;
  const representativeBinding =
    await prisma.representativeChannelBinding.create({
      data: {
        representativeId: representative.id,
        kind: channel === "matrix" ? "MATRIX" : "TELEGRAM",
        transport: channel === "matrix" ? "MATRIX" : "TELEGRAM",
        sourceProvider: channel === "matrix" ? "MATRIX" : "TELEGRAM",
        connectionId,
        ...(telegramBotConnectionId ? { telegramBotConnectionId } : {}),
        ...(representativeMatrixUserId
          ? { externalUserId: representativeMatrixUserId }
          : {}),
        endpointAssignmentRevision: 1,
        endpointLifecycleRevision: 1,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        status: "CONNECTED",
      },
    });
  if (representativeMatrixUserId) {
    await prisma.matrixVirtualUserBinding.create({
      data: {
        matrixUserId: representativeMatrixUserId,
        representativeId: representative.id,
        kind: "REPRESENTATIVE",
        displayName: representative.displayName,
        enabled: true,
      },
    });
  }

  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      sourceChannel: channel.toUpperCase(),
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: channel,
      ...(channel === "telegram" ? { telegramChatId: `chat-${suffix}` } : {}),
    },
  });
  const episode = await prisma.conversationEpisode.create({
    data: {
      conversationId: conversation.id,
      representativeVersionId: version.id,
      sequence: 1,
      status: "ACTIVE",
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { activeEpisodeId: episode.id },
  });
  const externalConversationId = channel === "matrix"
    ? `!memory-ordering-${suffix}:example.test`
    : `chat-${suffix}`;
  const channelBinding = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: conversation.id,
      representativeBindingId: representativeBinding.id,
      representativeAssignmentRevision: 1,
      kind: channel === "matrix" ? "MATRIX" : "TELEGRAM",
      transport: channel === "matrix" ? "MATRIX" : "TELEGRAM",
      sourceProvider: channel === "matrix" ? "MATRIX" : "TELEGRAM",
      interactionMode: "PRIVATE_CHAT",
      connectionId,
      externalConversationId,
    },
  });

  const disclosureTriggerExternalId = channel === "matrix"
    ? `$memory-ordering-disclosure-${suffix}`
    : `memory-ordering-disclosure-${suffix}`;
  const disclosure = await claimMemoryChannelDisclosureDelivery({
    conversationId: conversation.id,
    channel,
    inboundExternalMessageIds: [disclosureTriggerExternalId],
  });
  if (!disclosure.send) {
    throw new Error(`Expected a new ${channel} disclosure claim.`);
  }
  if (!await completeMemoryChannelDisclosureDelivery({
    deliveryId: disclosure.deliveryId,
    leaseToken: disclosure.leaseToken,
    externalMessageId: `memory-ordering-notice-${suffix}`,
  })) {
    throw new Error(`Expected ${channel} disclosure delivery to complete.`);
  }
  const disclosureBoundary = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      episodeId: episode.id,
      channelBindingId: channelBinding.id,
      ...(channel === "matrix" ? { channelLifecycleRevision: 1 } : {}),
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: "Disclosure boundary message",
      clientMessageId: disclosureTriggerExternalId,
      externalMessageId: disclosureTriggerExternalId,
      deliveryStatus: "SENT",
    },
  });
  if (!await prisma.$transaction((tx) =>
    activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
      representativeId: representative.id,
      contactId: contact.id,
      conversationId: conversation.id,
      messageId: disclosureBoundary.id,
      channel,
    })
  )) {
    throw new Error(`Expected ${channel} disclosure to activate.`);
  }

  const inputMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      episodeId: episode.id,
      channelBindingId: channelBinding.id,
      ...(channel === "matrix" ? { channelLifecycleRevision: 1 } : {}),
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: `I prefer concise ${channel} replies`,
      clientMessageId: `memory-ordering-source-${suffix}`,
      externalMessageId: `memory-ordering-source-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: conversation.id,
      episodeId: episode.id,
      inputMessageId: inputMessage.id,
      representativeVersionId: version.id,
      status: "PROCESSING",
      idempotencyKey: `private-memory-ordering-generation-${suffix}`,
    },
  });
  const use = await startOrReuseMemoryUseRun({
    generationRunId: generationRun.id,
    sourceChannel: channel,
  }, { client: prisma });
  const outputMessage = await prisma.$transaction(async (tx) => {
    const output = await tx.message.create({
      data: {
        conversationId: conversation.id,
        episodeId: episode.id,
        channelBindingId: channelBinding.id,
        ...(channel === "matrix" ? { channelLifecycleRevision: 1 } : {}),
        senderType: "REPRESENTATIVE",
        contentType: "TEXT",
        text: `A ${channel} answer crossing the final provider fence.`,
        deliveryStatus: "QUEUED",
      },
    });
    await tx.generationRun.update({
      where: { id: generationRun.id },
      data: {
        outputMessageId: output.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await finalizeMemoryUseGenerationInTransaction(tx, {
      useRunId: use.run.id,
      outputMessageId: output.id,
      injectedItemIds: [],
      citedItemIds: [],
    });
    return output;
  });
  const outbox = await prisma.outboxEvent.create({
    data: {
      conversationId: conversation.id,
      aggregateType: "generation_run",
      aggregateId: generationRun.id,
      eventType: "generation.requested",
      payload: {},
      status: "PROCESSING",
      idempotencyKey: `private-memory-ordering-outbox-${suffix}`,
      attemptCount: 1,
      availableAt: new Date(Date.now() + 60_000),
    },
  });
  const preparation = await prepareGenerationMessageChannelDelivery({
    conversationId: conversation.id,
    runId: generationRun.id,
    outboxId: outbox.id,
    leaseAttempt: 1,
    outputMessageId: outputMessage.id,
  });
  await admitGenerationMessageProviderDelivery({
    conversationId: conversation.id,
    runId: generationRun.id,
    outboxId: outbox.id,
    leaseAttempt: 1,
    outputMessageId: outputMessage.id,
    deliveryAdmission: preparation.deliveryAdmission,
  });

  return {
    representativeId: representative.id,
    contactId: contact.id,
    conversationId: conversation.id,
    inputMessageId: inputMessage.id,
    generationRunId: generationRun.id,
    outputMessageId: outputMessage.id,
    outboxId: outbox.id,
    deliveryAdmission: preparation.deliveryAdmission,
    connectionId,
    representativeMatrixUserId,
  };
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

async function waitForBackendLock(pid: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
  throw new Error(`Backend ${pid} did not block on the channel endpoint lock.`);
}

function assertFulfilledWithoutDatabaseDeadlock<T>(
  label: string,
  settlement: PromiseSettledResult<T>,
): asserts settlement is PromiseFulfilledResult<T> {
  if (settlement.status === "rejected") {
    throw new Error(
      `${label} failed during the lock-order race: ${String(settlement.reason)}`,
      { cause: settlement.reason },
    );
  }
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for private-memory PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing private-memory PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}
