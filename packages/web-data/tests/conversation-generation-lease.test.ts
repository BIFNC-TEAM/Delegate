import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    generationRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    conversationTurnPlan: {
      findFirst: vi.fn(),
    },
    memoryUseRun: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    message: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    messageDeliveryAttempt: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    planExecutionFence: {
      findUnique: vi.fn(),
    },
    conversation: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationEpisode: {
      updateMany: vi.fn(),
    },
    outboxEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventAudit: {
      upsert: vi.fn(),
    },
    matrixVirtualUserBinding: {
      findFirst: vi.fn(),
    },
    serviceEntitlementAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    serviceEntitlementLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  return {
    tx,
    releaseConversationWalletUsage: vi.fn(),
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
  releaseConversationWalletUsage: mocks.releaseConversationWalletUsage,
  reserveConversationWalletUsage: vi.fn(),
  settleConversationWalletUsage: vi.fn(),
}));

import {
  claimNextGenerationWorkItem,
  failGenerationRun,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationWorkLeaseLostError,
  markGenerationDeliveryComplete,
  renewGenerationWorkItemLease,
  retryGenerationDelivery,
  updateGenerationTurnExecutionProgress,
} from "../src/conversation-platform";

const currentTime = new Date("2026-07-24T08:00:00.000Z");
const deliveryAdmission = (attemptNumber: number) => ({
  attemptNumber,
  leaseToken: `delivery-lease-${attemptNumber}`,
});
const validRun = {
  id: "run-stale",
  outputMessageId: "message-attempt-b",
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
    channelBinding: {
      id: "web-binding-1",
      kind: "WEB",
      representativeBinding: {
        status: "CONNECTED",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
      },
    },
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
      lifecycleState: "PUBLISHED",
      activeVersionId: "version-1",
      publicMode: true,
      runtimePolicyOverlays: [],
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
    mocks.tx.conversationTurnPlan.findFirst.mockResolvedValue(null);
    mocks.tx.message.update.mockResolvedValue({ id: "message-in" });
    mocks.tx.message.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.messageDeliveryAttempt.findUnique.mockImplementation(
      async ({ where }) => {
        const attemptNumber = where.messageId_attemptNumber.attemptNumber;
        return {
          status: "PROCESSING",
          attemptPhase: "CALL_PREPARED",
          leaseToken: `delivery-lease-${attemptNumber}`,
          leaseExpiresAt: new Date(currentTime.getTime() + 60_000),
          deliveryOutboxId: "outbox-stale",
          deliveryLeaseAttempt: attemptNumber,
          planId: null,
          planRevision: null,
          executionEpoch: null,
          planActionId: null,
          plan: null,
        };
      },
    );
    mocks.tx.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.message.findUnique.mockResolvedValue({
      conversationId: "conversation-1",
    });
    mocks.tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mocks.tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-stale",
      aggregateId: "run-stale",
      attemptCount: 3,
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.outboxEvent.findUnique.mockResolvedValue({
      attemptCount: 3,
      status: "PROCESSING",
    });
    mocks.tx.messageDeliveryAttempt.upsert.mockResolvedValue({ id: "attempt-1" });
    mocks.tx.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([]);
    mocks.tx.serviceEntitlementLedgerEntry.findUnique.mockResolvedValue(null);
    mocks.tx.serviceEntitlementAccount.findUnique.mockResolvedValue(null);
    mocks.tx.serviceEntitlementAccount.update.mockResolvedValue({ id: "entitlement-1" });
    mocks.tx.serviceEntitlementAccount.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.serviceEntitlementLedgerEntry.create.mockResolvedValue({ id: "ledger-1" });
    mocks.releaseConversationWalletUsage.mockResolvedValue({ status: "failed" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists a lease-fenced public-safe turn execution stage", async () => {
    await updateGenerationTurnExecutionProgress({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      stage: "generating",
      part: 2,
      maxParts: 3,
    });

    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "outbox-stale",
          aggregateId: "run-stale",
          attemptCount: 3,
          status: "PROCESSING",
        }),
      }),
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-stale" },
      data: {
        contextSnapshot: expect.objectContaining({
          turnExecutionProgress: expect.objectContaining({
            version: 1,
            stage: "generating",
            part: 2,
            maxParts: 3,
          }),
        }),
      },
      select: { id: true, contextSnapshot: true },
    });
  });

  it("atomically reclaims an expired PROCESSING item and starts a new lease", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{
      id: "outbox-stale",
      aggregateId: "run-stale",
      conversationId: "conversation-1",
      delegationTaskId: null,
      status: "PROCESSING",
      attemptCount: 2,
    }]);

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      runId: "run-stale",
    });

    const candidateQuery = Array.from(
      mocks.tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
    ).join("?");
    const lockedQuery = Array.from(
      mocks.tx.$queryRaw.mock.calls[1]?.[0] as TemplateStringsArray,
    ).join("?");
    expect(candidateQuery).toContain("outbox.\"status\" = 'PROCESSING'");
    expect(candidateQuery).toContain("outbox.\"availableAt\" <= NOW()");
    expect(candidateQuery).not.toContain("FOR UPDATE SKIP LOCKED");
    expect(lockedQuery).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(lockedQuery).toContain(
      "run.\"conversationId\"\n          IS NOT DISTINCT FROM ?",
    );
    expect(lockedQuery).toContain(
      "run.\"delegationTaskId\"\n          IS NOT DISTINCT FROM ?",
    );
    expect(
      mocks.tx.$executeRaw.mock.calls.map((call) => call[1]),
    ).toEqual(["conversation-1", "run-stale"]);
    expect(mocks.tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-stale" },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(
          currentTime.getTime() + GENERATION_WORK_LEASE_DURATION_MS,
        ),
        processedAt: null,
        lastError: null,
      },
    });
  });

  it("retries an expired pre-call delivery but never classifies it as provider-unknown", async () => {
    const candidate = {
      id: "outbox-stale",
      aggregateId: "run-stale",
      conversationId: "conversation-1",
      delegationTaskId: null,
      status: "PROCESSING",
      attemptCount: 2,
      runStatus: "COMPLETED",
      outputMessageId: "message-attempt-b",
    };
    mocks.tx.$queryRaw.mockResolvedValue([candidate]);
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...validRun,
      status: "COMPLETED",
      outputMessageId: "message-attempt-b",
      outputMessage: {
        id: "message-attempt-b",
        text: "persisted reply",
        externalMessageId: null,
        deliveryStatus: "FAILED",
      },
    });

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      runId: "run-stale",
      deliveryOnly: true,
    });

    expect(mocks.tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-attempt-b",
        attemptNumber: 2,
        status: { in: ["PROCESSING"] },
      },
      data: expect.objectContaining({
        status: "FAILED",
        attemptPhase: "LEASE_EXPIRED",
        leaseToken: null,
        failureCode: "delivery_lease_expired_before_provider_call",
      }),
    });
    expect(mocks.tx.outboxEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: "provider_outcome_unknown_after_lease_expiry",
        }),
      }),
    );
  });

  it("dead-letters an expired max-attempt item and releases its funds", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{
      id: "outbox-stale",
      aggregateId: "run-stale",
      conversationId: "conversation-1",
      delegationTaskId: null,
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
    expect(mocks.tx.conversationEpisode.updateMany).toHaveBeenCalledWith({
      where: {
        id: "episode-1",
        status: { in: ["ACTIVE", "WAITING_APPROVAL"] },
      },
      data: { status: "FAILED" },
    });
    expect(mocks.tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-stale" },
      data: {
        status: "DEAD_LETTER",
        lastError: "generation_work_lease_exhausted",
      },
    });
    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-stale",
        failed: true,
        reason: "generation_work_lease_exhausted",
        idempotencyKey: "generation:run-stale:release",
      },
      mocks.tx,
    );
  });

  it("releases delivery-gated billing when a persisted reply exhausts delivery retries", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{
      id: "outbox-stale",
      aggregateId: "run-stale",
      conversationId: "conversation-1",
      delegationTaskId: null,
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...validRun,
      status: "COMPLETED",
      contextSnapshot: {
        deliveryBilling: { version: 1, status: "pending" },
      },
    });
    mocks.tx.outboxEvent.findUnique.mockResolvedValue({
      attemptCount: 5,
      status: "PROCESSING",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-stale",
        failed: true,
        reason: "generation_work_lease_exhausted",
        idempotencyKey: "generation:run-stale:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-stale" },
      data: expect.objectContaining({
        runtimePolicySnapshot: expect.objectContaining({
          billingMode: "service_credit_released",
        }),
        contextSnapshot: expect.objectContaining({
          deliveryBilling: expect.objectContaining({
            status: "released",
            reason: "generation_work_lease_exhausted",
          }),
        }),
      }),
    });
    expect(mocks.tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-attempt-b",
        deliveryStatus: {
          in: ["QUEUED", "PROCESSING", "FAILED"],
        },
      },
      data: {
        deliveryStatus: "FAILED",
        failureCode: "generation_work_lease_exhausted",
        failureReason: "The channel delivery worker exhausted all retry attempts.",
      },
    });
    expect(mocks.tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-attempt-b",
        attemptNumber: 5,
        status: { in: ["QUEUED", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        failureCode: "generation_work_lease_exhausted",
      }),
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-stale",
        status: "PROCESSING",
        attemptCount: 5,
      },
      data: {
        status: "DEAD_LETTER",
        processedAt: currentTime,
        lastError: "generation_work_lease_exhausted",
      },
    });
  });

  it("dead-letters the first provider-unknown generation attempt and releases pending billing", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...validRun,
      status: "COMPLETED",
      contextSnapshot: {
        deliveryBilling: { version: 1, status: "pending" },
      },
    });

    await retryGenerationDelivery({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 1,
      outputMessageId: "message-attempt-b",
      errorMessage: "provider outcome unknown",
      providerOutcomeUnknown: true,
    });

    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-stale",
        aggregateType: "generation_run",
        aggregateId: "run-stale",
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "telegram_provider_outcome_unknown",
      }),
    });
    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-stale",
        failed: true,
        reason: "telegram_provider_outcome_unknown",
        idempotencyKey: "generation:run-stale:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-stale" },
      data: expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          deliveryBilling: expect.objectContaining({
            status: "released",
            reason: "telegram_provider_outcome_unknown",
          }),
        }),
      }),
    });
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
      deliveryAdmission: deliveryAdmission(2),
    })).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

    expect(mocks.tx.message.updateMany).not.toHaveBeenCalled();

    await expect(markGenerationDeliveryComplete({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      outputMessageId: "message-attempt-b",
      deliveryAdmission: deliveryAdmission(3),
    })).resolves.toBeUndefined();

    expect(mocks.tx.message.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-attempt-b",
        deliveryStatus: "PROCESSING",
      },
      data: {
        deliveryStatus: "SENT",
        failureCode: null,
        failureReason: null,
      },
    });
    expect(mocks.tx.memoryUseRun.findFirst).not.toHaveBeenCalled();
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

  it("rejects delivery completion for a message outside the generation run", async () => {
    mocks.tx.outboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(markGenerationDeliveryComplete({
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 3,
      outputMessageId: "message-from-another-run",
      deliveryAdmission: deliveryAdmission(3),
    })).rejects.toThrow("does not belong to the generation run");

    expect(mocks.tx.message.update).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.upsert).not.toHaveBeenCalled();
  });

  it("does not let stale attempt A fail reclaimed attempt B's run", async () => {
    mocks.tx.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(failGenerationRun({
      conversationId: "conversation-stale",
      runId: "run-stale",
      outboxId: "outbox-stale",
      leaseAttempt: 2,
      errorCode: "attempt_a_failed",
      errorMessage: "Attempt A failed after losing its lease.",
    })).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

    expect(mocks.tx.generationRun.update).not.toHaveBeenCalled();
    expect(mocks.tx.message.update).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("keeps delegated MCP billing reserved while its owner reconciliation is pending", async () => {
    mocks.tx.generationRun.update.mockResolvedValue({
      ...validRun,
      delegationTaskId: "task-uncertain-effect",
      delegationTaskStepId: "step-uncertain-effect",
      delegationTaskStep: { kind: "MCP" },
    });

    await failGenerationRun({
      conversationId: validRun.conversationId,
      runId: validRun.id,
      outboxId: "outbox-stale",
      leaseAttempt: 5,
      errorCode: "conversation_worker_failed",
      errorMessage: "The remote effect requires owner reconciliation.",
    });

    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-stale",
        aggregateType: "generation_run",
        aggregateId: validRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 5,
      },
      data: {
        status: "DEAD_LETTER",
        lastError: "The remote effect requires owner reconciliation.",
        availableAt: expect.any(Date),
      },
    });
  });
});
