import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    conversation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    conversationEpisode: {
      create: vi.fn(),
      update: vi.fn(),
    },
    message: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    generationRun: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    outboxEvent: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    mockPrisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  acceptInboundConversationMessage,
  claimNextGenerationWorkItem,
  hasGenerationServiceCreditEntitlement,
} from "../src/conversation-platform";

describe("conversation runtime version pin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.message.upsert.mockResolvedValue({ id: "message-1" });
    tx.generationRun.upsert.mockResolvedValue({ id: "run-1" });
    tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-1" });
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
  });

  it("does not grant paid entitlement from an incomplete runtime snapshot", () => {
    expect(
      hasGenerationServiceCreditEntitlement({
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      }),
    ).toBe(false);
    expect(
      hasGenerationServiceCreditEntitlement({
        billingMode: "service_credit",
      }),
    ).toBe(false);
  });

  it("keeps subsequent runs on the episode version after the representative active version changes", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "representative-version-2",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "representative-version-1",
      }],
      channelBindings: [],
    });

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "continue the existing conversation",
      clientMessageId: "client-message-1",
    });

    expect(tx.conversationEpisode.create).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "reply:conversation-1:client-message-1",
      },
      create: expect.objectContaining({
        episodeId: "episode-1",
        representativeVersionId: "representative-version-1",
      }),
      update: {},
    });
  });

  it("treats the current service-credit reservation as paid entitlement after free replies are exhausted", async () => {
    tx.$queryRaw.mockResolvedValue([{ id: "outbox-paid" }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-paid",
      aggregateId: "run-paid",
    });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-paid",
      status: "QUEUED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      delegationTaskId: null,
      delegationTaskStepId: null,
      contextSnapshot: null,
      inputMessageId: "message-paid",
      inputMessage: {
        id: "message-paid",
        text: "continue with my paid credit",
      },
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
      startedAt: null,
      episode: {
        representativeVersionId: "representative-version-1",
      },
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 3,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
        },
        channelBindings: [],
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-paid" });
    tx.message.update.mockResolvedValue({ id: "message-paid" });

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      runId: "run-paid",
      usage: {
        freeRepliesUsed: 3,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
  });

  it("dead-letters a legacy run whose version differs from its episode", async () => {
    tx.$queryRaw.mockResolvedValue([{ id: "outbox-legacy" }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-legacy",
        aggregateId: "run-legacy",
      })
      .mockResolvedValueOnce({ id: "outbox-legacy" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-legacy",
      status: "QUEUED",
      representativeVersionId: "representative-version-2",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-legacy",
      inputMessage: {
        id: "message-legacy",
        text: "legacy work",
      },
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 0,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
        },
        channelBindings: [],
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-legacy" });
    tx.message.update.mockResolvedValue({ id: "message-legacy" });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-legacy" },
      data: expect.objectContaining({
        status: "FAILED",
        errorCode: "representative_version_context_mismatch",
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-legacy" },
      data: expect.objectContaining({
        deliveryStatus: "FAILED",
        failureCode: "representative_version_context_mismatch",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-legacy" },
      data: {
        status: "DEAD_LETTER",
        lastError: "representative_version_context_mismatch",
      },
    });
  });
});
