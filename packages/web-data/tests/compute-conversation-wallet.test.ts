import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    approvalRequest: {
      findUnique: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    messageAttachment: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    generationRun: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationEpisode: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    tx,
    prisma: {
      approvalRequest: tx.approvalRequest,
      conversation: tx.conversation,
      conversationEpisode: tx.conversationEpisode,
      message: tx.message,
      $transaction: vi.fn(
        async (operation: ((client: typeof tx) => unknown) | Promise<unknown>[]) =>
          Array.isArray(operation)
            ? Promise.all(operation)
            : operation(tx),
      ),
    },
    releaseConversationWalletUsage: vi.fn(),
    settleConversationWalletUsage: vi.fn(),
    consumeConversationEntitlementByGenerationRunId: vi.fn(),
    releaseConversationEntitlementByGenerationRunId: vi.fn(),
    finalizeComputeDelegationTask: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError: class InsufficientAgentUsageCreditsError
    extends Error {},
  reserveConversationWalletUsage: vi.fn(),
  releaseConversationWalletUsage: mocks.releaseConversationWalletUsage,
  settleConversationWalletUsage: mocks.settleConversationWalletUsage,
}));
vi.mock("../src/service-entitlements", () => ({
  consumeConversationEntitlementByGenerationRunId:
    mocks.consumeConversationEntitlementByGenerationRunId,
  releaseConversationEntitlementByGenerationRunId:
    mocks.releaseConversationEntitlementByGenerationRunId,
}));
vi.mock("../src/delegation-tasks", () => ({
  finalizeComputeDelegationTask: mocks.finalizeComputeDelegationTask,
}));

import { finalizeComputeApprovalConversation } from "../src/compute-conversation-results";

const approvalWithPaidRun = {
  id: "approval-1",
  delegationTaskId: null,
  delegationTaskStepId: null,
  representative: {
    displayName: "Representative",
    slug: "representative",
  },
  generationRun: {
    id: "run-1",
    status: "WAITING_APPROVAL",
    outputMessageId: "pending-message",
    conversationId: "conversation-1",
    episodeId: "episode-1",
    runtimePolicySnapshot: {
      billingMode: "service_credit",
      walletReservation: {
        usageChargeId: "usage-1",
        tokenAmount: 1,
      },
    },
  },
};

describe("compute approval wallet finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (
        operation:
          | ((client: typeof mocks.tx) => unknown)
          | Promise<unknown>[],
      ) =>
        Array.isArray(operation)
          ? Promise.all(operation)
          : operation(mocks.tx),
    );
    mocks.tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes('UPDATE "Conversation"') ? 1 : undefined
    );
    mocks.tx.approvalRequest.findUnique.mockResolvedValue(approvalWithPaidRun);
    mocks.tx.conversation.findUnique.mockResolvedValue({ state: "PROCESSING" });
    mocks.tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.message.upsert.mockResolvedValue({
      id: "result-message",
      text: "result",
    });
    mocks.tx.message.update.mockResolvedValue({
      id: "result-message",
      text: "result",
    });
    mocks.tx.messageAttachment.deleteMany.mockResolvedValue({ count: 0 });
    mocks.tx.generationRun.update.mockResolvedValue({ id: "run-1" });
    mocks.tx.generationRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mocks.tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversationEpisode.update.mockResolvedValue({ id: "episode-1" });
    mocks.settleConversationWalletUsage.mockResolvedValue({ status: "settled" });
    mocks.releaseConversationWalletUsage.mockResolvedValue({ status: "released" });
    mocks.consumeConversationEntitlementByGenerationRunId.mockResolvedValue(null);
    mocks.releaseConversationEntitlementByGenerationRunId.mockResolvedValue(null);
    mocks.finalizeComputeDelegationTask.mockResolvedValue({
      taskId: "task-1",
      status: "READY",
      hasMoreSteps: true,
      nextGenerationRunId: "run-step-2",
    });
  });

  it("settles paid credits and does not consume a free reply on success", async () => {
    await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "completed",
      actualCredits: 8,
    });

    expect(
      mocks.consumeConversationEntitlementByGenerationRunId,
    ).toHaveBeenCalledWith(
      { generationRunId: "run-1" },
      mocks.tx,
    );
    expect(
      mocks.releaseConversationEntitlementByGenerationRunId,
    ).not.toHaveBeenCalled();
    expect(mocks.settleConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-1",
        settledTokenAmount: 1,
        provider: "compute",
        idempotencyKey: "generation:run-1:settle",
      },
      mocks.tx,
    );
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: "WAITING_USER",
        lastMessageAt: expect.any(Date),
      },
    });
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
    expect(
      mocks.tx.$executeRaw.mock.calls.map((call) => call[1]),
    ).toEqual(["conversation-1", "run-1"]);
  });

  it("releases paid credits when compute is rejected", async () => {
    await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "rejected",
    });

    expect(
      mocks.releaseConversationEntitlementByGenerationRunId,
    ).toHaveBeenCalledWith(
      {
        generationRunId: "run-1",
        reason: "compute_rejected",
      },
      mocks.tx,
    );
    expect(
      mocks.consumeConversationEntitlementByGenerationRunId,
    ).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-1",
        failed: false,
        reason: "compute_rejected",
        idempotencyKey: "generation:run-1:release",
      },
      mocks.tx,
    );
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("does not consume the free allowance for a rejected compute run", async () => {
    mocks.tx.approvalRequest.findUnique.mockResolvedValue({
      ...approvalWithPaidRun,
      generationRun: {
        ...approvalWithPaidRun.generationRun,
        runtimePolicySnapshot: { billingMode: "free" },
      },
    });

    await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "rejected",
    });

    expect(mocks.tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: "WAITING_USER",
        lastMessageAt: expect.any(Date),
      },
    });
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
  });

  it("leaves a delegated reservation and free allowance untouched while the next approved step is queued", async () => {
    mocks.tx.approvalRequest.findUnique.mockResolvedValue({
      ...approvalWithPaidRun,
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      generationRun: {
        ...approvalWithPaidRun.generationRun,
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
      },
    });

    await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "completed",
      actualCredits: 8,
    });

    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        stepId: "step-1",
        generationRunId: "run-1",
        outcome: "completed",
      }),
    );
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: "WAITING_USER",
        lastMessageAt: expect.any(Date),
      },
    });
    expect(mocks.tx.conversation.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        state: "AI_QUEUED",
        lastMessageAt: expect.any(Date),
      },
    });
  });

  it.each(["HUMAN_ACTIVE", "NEEDS_HUMAN"] as const)(
    "defers a late approved result under %s without exposing or settling it",
    async (state) => {
      mocks.tx.conversation.findUnique.mockResolvedValue({ state });

      const result = await finalizeComputeApprovalConversation({
        approvalId: "approval-1",
        outcome: "completed",
        actualCredits: 8,
      });

      expect(result).toBeNull();
      expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith({
        where: {
          id: "run-1",
          status: "WAITING_APPROVAL",
        },
        data: {
          status: "WAITING_HUMAN",
          completedAt: null,
          canceledAt: null,
          runtimePolicySnapshot: {
            billingMode: "service_credit_released",
            billingFinalizedAt: expect.any(String),
          },
        },
      });
      expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
        {
          usageChargeId: "usage-1",
          reason: "generation_deferred_to_human",
          idempotencyKey: "generation:run-1:release",
        },
        mocks.tx,
      );
      expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
      expect(mocks.tx.message.upsert).not.toHaveBeenCalled();
      expect(mocks.tx.messageAttachment.deleteMany).not.toHaveBeenCalled();
      expect(mocks.tx.conversation.updateMany).not.toHaveBeenCalled();
      expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
      expect(
        mocks.tx.$executeRaw.mock.calls.map((call) => call[1]),
      ).toEqual(["conversation-1", "run-1"]);
    },
  );

  it("defers a delegated result without finalizing its task-owned reservation", async () => {
    mocks.tx.approvalRequest.findUnique.mockResolvedValue({
      ...approvalWithPaidRun,
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      generationRun: {
        ...approvalWithPaidRun.generationRun,
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
      },
    });
    mocks.tx.conversation.findUnique.mockResolvedValue({
      state: "NEEDS_HUMAN",
    });

    const result = await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "completed",
    });

    expect(result).toBeNull();
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "WAITING_APPROVAL",
      },
      data: {
        status: "WAITING_HUMAN",
        completedAt: null,
        canceledAt: null,
      },
    });
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.message.upsert).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
  });

  it("rolls back human deferral when the guarded run transition loses the race", async () => {
    mocks.tx.conversation.findUnique.mockResolvedValue({
      state: "HUMAN_ACTIVE",
    });
    mocks.tx.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      finalizeComputeApprovalConversation({
        approvalId: "approval-1",
        outcome: "completed",
      }),
    ).rejects.toThrow(
      "Compute generation changed while deferring its approval result to human control.",
    );

    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.message.upsert).not.toHaveBeenCalled();
  });

  it("does not settle when the guarded completion transition loses the race", async () => {
    mocks.tx.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      finalizeComputeApprovalConversation({
        approvalId: "approval-1",
        outcome: "completed",
      }),
    ).rejects.toThrow(
      "Compute generation changed while completing its approval result.",
    );

    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
  });

  it("does not settle when the guarded conversation transition loses the race", async () => {
    mocks.tx.conversation.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      finalizeComputeApprovalConversation({
        approvalId: "approval-1",
        outcome: "completed",
      }),
    ).rejects.toThrow(
      "Compute approval conversation changed while completing its result.",
    );

    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
  });

  it("returns an existing completed result idempotently", async () => {
    const completedApproval = {
      ...approvalWithPaidRun,
      generationRun: {
        ...approvalWithPaidRun.generationRun,
        status: "COMPLETED",
        outputMessageId: "result-message",
      },
    };
    mocks.tx.approvalRequest.findUnique.mockResolvedValue(completedApproval);
    mocks.tx.message.findUnique.mockResolvedValue({
      id: "result-message",
      text: "existing result",
    });

    const result = await finalizeComputeApprovalConversation({
      approvalId: "approval-1",
      outcome: "completed",
    });

    expect(result).toEqual({
      id: "result-message",
      text: "existing result",
    });
    expect(mocks.tx.message.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
  });
});
