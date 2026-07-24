import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    generationRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    message: {
      update: vi.fn(),
    },
    conversation: {
      update: vi.fn(),
    },
    outboxEvent: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    matrixVirtualUserBinding: {
      findFirst: vi.fn(),
    },
  };
  return {
    tx,
    releaseAgentUsageCredits: vi.fn(),
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      ),
      outboxEvent: {
        updateMany: vi.fn(),
      },
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError:
    class InsufficientAgentUsageCreditsError extends Error {},
  releaseAgentUsageCredits: mocks.releaseAgentUsageCredits,
  reserveAgentUsageCredits: vi.fn(),
  settleAgentUsageCredits: vi.fn(),
}));

import {
  claimNextGenerationWorkItem,
  failGenerationRun,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationWorkLeaseLostError,
  markGenerationDeliveryComplete,
  renewGenerationWorkItemLease,
} from "../src/conversation-platform";

const currentTime = new Date("2026-07-24T08:00:00.000Z");
const validRun = {
  id: "run-stale",
  status: "PROCESSING",
  representativeVersionId: "version-1",
  episodeId: "episode-1",
  delegationTaskId: null,
  delegationTaskStepId: null,
  contextSnapshot: null,
  inputMessageId: "message-in",
  inputMessage: {
    id: "message-in",
    text: "resume the stale generation",
  },
  runtimePolicySnapshot: {
    billingMode: "service_credit",
    walletReservation: {
      usageChargeId: "usage-reserved",
      tokenAmount: 1,
    },
  },
  startedAt: new Date("2026-07-24T07:50:00.000Z"),
  episode: {
    representativeVersionId: "version-1",
  },
  conversationId: "conversation-1",
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
};

describe("conversation generation work leases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.generationRun.findUnique.mockResolvedValue(validRun);
    mocks.tx.generationRun.update.mockResolvedValue(validRun);
    mocks.tx.message.update.mockResolvedValue({ id: "message-in" });
    mocks.tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mocks.tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-stale",
      aggregateId: "run-stale",
      attemptCount: 3,
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.releaseAgentUsageCredits.mockResolvedValue({ status: "failed" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("atomically reclaims an expired PROCESSING item and starts a new lease", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{
      id: "outbox-stale",
      aggregateId: "run-stale",
      status: "PROCESSING",
      attemptCount: 2,
    }]);

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      runId: "run-stale",
    });

    const rawQuery = Array.from(
      mocks.tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
    ).join("?");
    expect(rawQuery).toContain("\"status\" = 'PROCESSING'");
    expect(rawQuery).toContain("\"availableAt\" <= NOW()");
    expect(rawQuery).toContain("FOR UPDATE SKIP LOCKED");
    expect(mocks.tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-stale" },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(
          currentTime.getTime() + GENERATION_WORK_LEASE_DURATION_MS,
        ),
        lastError: null,
      },
    });
  });

  it("dead-letters an expired max-attempt item and releases its funds", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{
      id: "outbox-stale",
      aggregateId: "run-stale",
      status: "PROCESSING",
      attemptCount: 5,
    }]);

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-stale" },
      data: {
        status: "FAILED",
        errorCode: "generation_work_lease_exhausted",
        errorMessage:
          "The conversation worker stopped renewing its lease and exhausted all retry attempts.",
        completedAt: currentTime,
      },
    });
    expect(mocks.tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-in" },
      data: {
        deliveryStatus: "FAILED",
        failureCode: "generation_work_lease_exhausted",
        failureReason:
          "The conversation worker stopped renewing its lease and exhausted all retry attempts.",
      },
    });
    expect(mocks.tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-stale" },
      data: {
        status: "DEAD_LETTER",
        lastError: "generation_work_lease_exhausted",
      },
    });
    expect(mocks.releaseAgentUsageCredits).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        failed: true,
        reason: "generation_work_lease_exhausted",
        idempotencyKey: "generation:run-stale:release",
      },
      mocks.tx,
    );
  });

  it("renews only the attempt that still owns the lease", async () => {
    mocks.prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(renewGenerationWorkItemLease({
      outboxId: "outbox-stale",
      leaseAttempt: 3,
    })).resolves.toBe(true);

    expect(mocks.prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-stale",
        status: "PROCESSING",
        attemptCount: 3,
      },
      data: {
        availableAt: new Date(
          currentTime.getTime() + GENERATION_WORK_LEASE_DURATION_MS,
        ),
      },
    });
  });

  it("rejects stale attempt A's commit after B reclaims and accepts B", async () => {
    mocks.tx.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(markGenerationDeliveryComplete({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 2,
      outputMessageId: "message-attempt-a",
    })).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

    expect(mocks.tx.message.update).not.toHaveBeenCalled();

    await expect(markGenerationDeliveryComplete({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      outputMessageId: "message-attempt-b",
    })).resolves.toBeUndefined();

    expect(mocks.tx.message.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-attempt-b" },
      data: {
        deliveryStatus: "SENT",
      },
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-stale",
        aggregateType: "generation_run",
        aggregateId: "run-stale",
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 3,
      },
      data: {
        status: "PROCESSED",
        processedAt: currentTime,
        lastError: null,
      },
    });
  });

  it("does not let stale attempt A fail reclaimed attempt B's run", async () => {
    mocks.tx.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(failGenerationRun({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 2,
      errorCode: "attempt_a_failed",
      errorMessage: "Attempt A failed after losing its lease.",
    })).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

    expect(mocks.tx.generationRun.update).not.toHaveBeenCalled();
    expect(mocks.tx.message.update).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
  });
});
