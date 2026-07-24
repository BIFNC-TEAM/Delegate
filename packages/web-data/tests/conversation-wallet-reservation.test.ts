import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    conversation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    conversationEpisode: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    generationRun: {
      count: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    message: {
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    outboxEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    tx,
    reserveAgentUsageCredits: vi.fn(),
    settleAgentUsageCredits: vi.fn(),
    releaseAgentUsageCredits: vi.fn(),
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError: class InsufficientAgentUsageCreditsError
    extends Error {},
  reserveAgentUsageCredits: mocks.reserveAgentUsageCredits,
  settleAgentUsageCredits: mocks.settleAgentUsageCredits,
  releaseAgentUsageCredits: mocks.releaseAgentUsageCredits,
}));

import {
  acceptInboundConversationMessage,
  completeInlineGenerationRun,
  deferGenerationRunForHuman,
  failGenerationRun,
  ServiceCreditRequiredError,
} from "../src/conversation-platform";
import { InsufficientAgentUsageCreditsError } from "../src/agent-wallet-usage-charge";

const reservedRun = {
  id: "run-paid",
  status: "QUEUED",
  outputMessage: null,
  outputMessageId: null,
  conversationId: "conversation-1",
  episodeId: "episode-1",
  inputMessageId: "message-in",
  delegationTaskId: null,
  startedAt: null,
  runtimePolicySnapshot: {
    walletReservation: {
      usageChargeId: "usage-reserved",
      tokenAmount: 1,
    },
  },
};

describe("generation wallet reservation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.generationRun.findUnique.mockResolvedValue(reservedRun);
    mocks.tx.generationRun.count.mockResolvedValue(0);
    mocks.tx.generationRun.upsert.mockResolvedValue({ id: "run-new" });
    mocks.tx.generationRun.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...reservedRun,
        ...data,
      }),
    );
    mocks.tx.message.create.mockResolvedValue({ id: "message-out" });
    mocks.tx.message.upsert.mockResolvedValue({ id: "message-in" });
    mocks.tx.message.update.mockResolvedValue({ id: "message-in" });
    mocks.tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mocks.tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-new" });
    mocks.tx.outboxEvent.findMany.mockResolvedValue([]);
    mocks.reserveAgentUsageCredits.mockResolvedValue({
      id: "usage-reserved",
      reservedTokenAmount: 1,
    });
    mocks.settleAgentUsageCredits.mockResolvedValue({ status: "settled" });
    mocks.releaseAgentUsageCredits.mockResolvedValue({ status: "released" });
  });

  it("settles a paid reservation atomically with generation completion", async () => {
    await completeInlineGenerationRun({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Paid answer",
      senderDisplayName: "Representative",
      countUsage: true,
      provider: "openai",
      costCents: 2,
    });

    expect(mocks.settleAgentUsageCredits).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        settledTokenAmount: 1,
        providerCostCents: 2,
        provider: "openai",
        idempotencyKey: "generation:run-paid:settle",
      },
      mocks.tx,
    );
    expect(mocks.releaseAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        state: "WAITING_USER",
        lastMessageAt: expect.any(Date),
      },
    });
  });

  it("does not settle or consume free allowance for an intermediate delegation step", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      id: "run-task-step-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      delegationTaskStep: { kind: "COMPUTE" },
      runtimePolicySnapshot: {
        billingMode: "free",
      },
    });

    await completeInlineGenerationRun({
      runId: "run-task-step-1",
      outboxId: "outbox-task-step-1",
      leaseAttempt: 1,
      replyText: "Step one completed",
      senderDisplayName: "Representative",
      countUsage: true,
      keepConversationQueued: true,
    });

    expect(mocks.settleAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.releaseAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        state: "AI_QUEUED",
        lastMessageAt: expect.any(Date),
      },
    });
  });

  it("claims the last free slot under the conversation lock", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      freeRepliesUsed: 2,
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.generationRun.count.mockResolvedValue(0);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "last free request",
      clientMessageId: "client-free",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-free",
      },
    });

    expect(mocks.reserveAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "free",
          },
        }),
      }),
    );
  });

  it("reserves paid credit atomically when an earlier free run is in flight", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      freeRepliesUsed: 2,
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.generationRun.count.mockResolvedValue(1);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "paid request",
      clientMessageId: "client-paid",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-paid",
      },
    });

    expect(mocks.reserveAgentUsageCredits).toHaveBeenCalledWith(
      {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        tokenAmount: 1,
        idempotencyKey: "reserve:client-paid",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "service_credit",
            walletReservation: {
              usageChargeId: "usage-reserved",
              tokenAmount: 1,
            },
          },
        }),
      }),
    );
  });

  it("keeps a retryable failed free run occupying its quota slot during backoff", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      freeRepliesUsed: 2,
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.outboxEvent.findMany.mockResolvedValue([
      { aggregateId: "run-retrying-free" },
    ]);
    mocks.tx.generationRun.count.mockResolvedValue(1);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "request during retry backoff",
      clientMessageId: "client-during-retry",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-during-retry",
      },
    });

    expect(mocks.tx.outboxEvent.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        aggregateType: "generation_run",
        eventType: "generation.requested",
        status: "FAILED",
        attemptCount: { lt: 5 },
      },
      select: { aggregateId: true },
    });
    expect(mocks.tx.generationRun.count).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        OR: [
          {
            status: {
              in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL"],
            },
          },
          {
            id: { in: ["run-retrying-free"] },
            status: "FAILED",
          },
        ],
        runtimePolicySnapshot: {
          path: ["billingMode"],
          equals: "free",
        },
      },
    });
    expect(mocks.reserveAgentUsageCredits).toHaveBeenCalledTimes(1);
  });

  it("does not keep a terminal failed free run occupying a quota slot", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      freeRepliesUsed: 2,
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.outboxEvent.findMany.mockResolvedValue([]);
    mocks.tx.generationRun.count.mockResolvedValue(0);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "replacement after terminal failure",
      clientMessageId: "client-after-terminal-failure",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-after-terminal-failure",
      },
    });

    expect(mocks.reserveAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "free",
          },
        }),
      }),
    );
  });

  it("fails the accept transaction with a typed payment-required error", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      freeRepliesUsed: 3,
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.reserveAgentUsageCredits.mockRejectedValue(
      new InsufficientAgentUsageCreditsError(),
    );

    const rejection = await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "no balance",
      clientMessageId: "client-no-balance",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-no-balance",
      },
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ServiceCreditRequiredError);
    expect(rejection).toMatchObject({
      effectiveFreeRepliesUsed: 3,
    });

    expect(mocks.tx.message.upsert).not.toHaveBeenCalled();
  });

  it("releases a reservation when a completed response is not billable", async () => {
    await completeInlineGenerationRun({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Operator-owned answer",
      senderDisplayName: "Representative",
      countUsage: false,
    });

    expect(mocks.releaseAgentUsageCredits).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        reason: "generation_usage_not_counted",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.settleAgentUsageCredits).not.toHaveBeenCalled();
  });

  it("keeps the reservation during retryable failures", async () => {
    await failGenerationRun({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 4,
      errorCode: "provider_timeout",
      errorMessage: "Provider timed out.",
    });

    expect(mocks.releaseAgentUsageCredits).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-paid",
        aggregateType: "generation_run",
        aggregateId: reservedRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 4,
      },
      data: {
        status: "FAILED",
        lastError: "Provider timed out.",
        availableAt: expect.any(Date),
      },
    });
  });

  it("releases the reservation on terminal failure or human deferral", async () => {
    await failGenerationRun({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 5,
      errorCode: "provider_failed",
      errorMessage: "Provider failed.",
    });

    expect(mocks.releaseAgentUsageCredits).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        failed: true,
        reason: "provider_failed",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-paid",
        aggregateType: "generation_run",
        aggregateId: reservedRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 5,
      },
      data: {
        status: "DEAD_LETTER",
        lastError: "Provider failed.",
        availableAt: expect.any(Date),
      },
    });

    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.generationRun.findUnique.mockResolvedValue(reservedRun);
    mocks.tx.generationRun.update.mockResolvedValue({
      ...reservedRun,
      status: "WAITING_HUMAN",
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.releaseAgentUsageCredits.mockResolvedValue({ status: "released" });

    await deferGenerationRunForHuman({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
    });

    expect(mocks.releaseAgentUsageCredits).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        reason: "generation_deferred_to_human",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
  });
});
