import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    conversation: { findUnique: vi.fn() },
    message: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    messageDeliveryAttempt: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    matrixVirtualUserBinding: { findFirst: vi.fn() },
  };
  return {
    tx: transactionClient,
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma }));

import {
  claimNextConversationMessageDeliveryWorkItem,
  completeConversationMessageDelivery,
  enqueueConversationMessageDeliveryInTransaction,
  retryConversationMessageDelivery,
  retryOperatorMessageDelivery,
} from "../src/conversation-platform";

describe("conversation message delivery outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.message.update.mockResolvedValue({ id: "message-1" });
    tx.message.updateMany.mockResolvedValue({ count: 1 });
    tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
    });
    tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    tx.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 1 });
  });

  it("queues a system message and a versioned delivery outbox atomically", async () => {
    tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      senderType: "SYSTEM",
      deliveryStatus: "QUEUED",
      externalMessageId: null,
    });
    tx.conversation.findUnique.mockResolvedValue({
      sourceChannel: "web",
      channelBindings: [],
    });
    tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-1" });

    await enqueueConversationMessageDeliveryInTransaction(tx as never, {
      conversationId: "conversation-1",
      messageId: "message-1",
      deliveryKind: "delegation_task_status",
    });

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: expect.objectContaining({ deliveryStatus: "QUEUED" }),
    });
    expect(tx.outboxEvent.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "conversation.message.requested:message-1",
      },
      create: expect.objectContaining({
        aggregateType: "conversation_message",
        aggregateId: "message-1",
        eventType: "conversation.message.requested",
        payload: {
          version: 1,
          messageId: "message-1",
          conversationId: "conversation-1",
          channel: "web",
          senderType: "SYSTEM",
          deliveryKind: "delegation_task_status",
        },
      }),
      update: {},
    });
    expect(tx.messageDeliveryAttempt.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "conversation-message:message-1:attempt:1",
      },
      create: expect.objectContaining({
        messageId: "message-1",
        attemptNumber: 1,
        status: "QUEUED",
      }),
      update: {},
    });
  });

  it("claims a queued web message without pretending it was already sent", async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: "outbox-1", aggregateId: "message-1", attemptCount: 0 },
    ]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-1",
      aggregateId: "message-1",
      attemptCount: 1,
      connectionId: null,
      payload: {
        version: 1,
        deliveryKind: "delegation_task_status",
      },
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      text: "任务已取消。",
      senderType: "SYSTEM",
      senderDisplayName: "Delegate",
      deliveryStatus: "QUEUED",
      externalMessageId: null,
      channelLifecycleRevision: null,
      channelBinding: null,
      conversation: {
        sourceChannel: "web",
        representative: { id: "representative-1" },
      },
    });

    const item = await claimNextConversationMessageDeliveryWorkItem();

    expect(item).toMatchObject({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      messageId: "message-1",
      channel: "web",
      deliveryKind: "delegation_task_status",
      senderType: "SYSTEM",
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-1",
        deliveryStatus: { in: ["QUEUED", "FAILED", "PROCESSING"] },
      },
      data: {
        deliveryStatus: "PROCESSING",
        failureCode: null,
        failureReason: null,
      },
    });
    expect(tx.messageDeliveryAttempt.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "conversation-message:message-1:attempt:1",
      },
      create: expect.objectContaining({
        attemptNumber: 1,
        status: "QUEUED",
      }),
      update: {},
    });
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-1",
        attemptNumber: 1,
        status: { in: ["QUEUED", "FAILED", "PROCESSING"] },
      },
      data: expect.objectContaining({ status: "PROCESSING" }),
    });
  });

  it("marks the message sent only after the claimed delivery completes", async () => {
    const completed = await completeConversationMessageDelivery({
      outboxId: "outbox-1",
      leaseAttempt: 2,
      messageId: "message-1",
      externalMessageId: "provider-message-1",
    });

    expect(completed).toBe(true);
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        aggregateType: "conversation_message",
        aggregateId: "message-1",
        eventType: "conversation.message.requested",
        status: "PROCESSING",
        attemptCount: 2,
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", deliveryStatus: "PROCESSING" },
      data: {
        deliveryStatus: "SENT",
        externalMessageId: "provider-message-1",
        failureCode: null,
        failureReason: null,
      },
    });
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-1",
        attemptNumber: 2,
        status: { in: ["PROCESSING", "PROVIDER_ACCEPTED"] },
      },
      data: expect.objectContaining({
        status: "PROVIDER_ACCEPTED",
        externalMessageId: "provider-message-1",
      }),
    });
  });

  it("dead-letters the fifth failed delivery attempt", async () => {
    const retried = await retryConversationMessageDelivery({
      outboxId: "outbox-1",
      leaseAttempt: 5,
      messageId: "message-1",
      errorMessage: "provider unavailable",
    });

    expect(retried).toBe(true);
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "outbox-1",
        status: "PROCESSING",
        attemptCount: 5,
      }),
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "conversation_message_delivery_attempts_exhausted",
      }),
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", deliveryStatus: "PROCESSING" },
      data: {
        deliveryStatus: "FAILED",
        failureCode: "conversation_message_delivery_attempts_exhausted",
        failureReason: "provider unavailable",
      },
    });
  });

  it("dead-letters the first provider-unknown generic attempt", async () => {
    const retried = await retryConversationMessageDelivery({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      messageId: "message-1",
      errorMessage: "provider outcome unknown",
      providerOutcomeUnknown: true,
    });

    expect(retried).toBe(true);
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "outbox-1",
        status: "PROCESSING",
        attemptCount: 1,
      }),
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "telegram_provider_outcome_unknown",
      }),
    });
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-1",
        attemptNumber: 1,
        status: { in: ["PROCESSING"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        failureCode: "telegram_provider_outcome_unknown",
      }),
    });
  });

  it("dead-letters the first provider-unknown operator attempt", async () => {
    tx.outboxEvent.findUnique.mockResolvedValue({ attemptCount: 1 });

    const retried = await retryOperatorMessageDelivery({
      outboxId: "operator-outbox-1",
      leaseAttempt: 1,
      messageId: "operator-message-1",
      errorMessage: "provider outcome unknown",
      providerOutcomeUnknown: true,
    });

    expect(retried).toBe(true);
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "operator-outbox-1",
        aggregateType: "operator_message",
        aggregateId: "operator-message-1",
        eventType: "operator.message.requested",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "telegram_provider_outcome_unknown",
      }),
    });
  });

  it("terminalizes the attempt when a claimed message has no text", async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: "outbox-1", aggregateId: "message-1", attemptCount: 0 },
    ]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-1",
      aggregateId: "message-1",
      attemptCount: 1,
      connectionId: null,
      payload: { deliveryKind: "delegation_task_status" },
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      text: null,
      senderType: "SYSTEM",
      senderDisplayName: "Delegate",
      deliveryStatus: "QUEUED",
      externalMessageId: null,
      channelLifecycleRevision: null,
      channelBinding: null,
      conversation: {
        sourceChannel: "web",
        representative: { id: "representative-1" },
      },
    });

    await expect(claimNextConversationMessageDeliveryWorkItem())
      .resolves.toBeNull();

    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-1",
        attemptNumber: 1,
        status: { in: ["QUEUED", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        failureCode: "conversation_message_text_missing",
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "outbox-1",
        status: { in: ["PROCESSING"] },
        attemptCount: 1,
      }),
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "conversation_message_text_missing",
      }),
    });
  });

  it("terminalizes the attempt when a private-channel binding is missing", async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: "outbox-1", aggregateId: "message-1", attemptCount: 0 },
    ]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-1",
      aggregateId: "message-1",
      attemptCount: 1,
      connectionId: null,
      payload: { deliveryKind: "delegation_task_status" },
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      text: "任务已取消。",
      senderType: "SYSTEM",
      senderDisplayName: "Delegate",
      deliveryStatus: "QUEUED",
      externalMessageId: null,
      channelLifecycleRevision: null,
      channelBinding: null,
      conversation: {
        sourceChannel: "telegram",
        representative: { id: "representative-1" },
      },
    });

    await expect(claimNextConversationMessageDeliveryWorkItem())
      .resolves.toBeNull();

    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-1",
        attemptNumber: 1,
        status: { in: ["QUEUED", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        failureCode: "conversation_message_channel_missing",
      }),
    });
  });
});
