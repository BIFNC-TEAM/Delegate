import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  finalizeConversationEntitlementForGenerationRuns,
  releaseConversationWalletUsage,
  settleConversationWalletUsage,
  transferAgentUsageEntitlementReservation,
  transferConversationEntitlementByGenerationRunId,
} = vi.hoisted(() => {
  const client = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    agentUsageCharge: { findUnique: vi.fn() },
    approvalRequest: {},
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationEpisode: { updateMany: vi.fn() },
    artifact: { findMany: vi.fn(), updateMany: vi.fn() },
    delegationTask: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    delegationTaskEvent: { findFirst: vi.fn(), create: vi.fn() },
    delegationTaskExternalEffect: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    delegationTaskInput: { findFirst: vi.fn(), create: vi.fn() },
    delegationTaskOutput: { count: vi.fn(), create: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    delegationTaskStep: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    delegationTaskResourcePolicy: { update: vi.fn() },
    generationRun: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    messageDeliveryAttempt: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    workflowRun: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workflowCommandOutbox: { upsert: vi.fn() },
    conversationTurnPlan: { findFirst: vi.fn() },
    conversationPlanAction: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    eventAudit: { create: vi.fn() },
  };
  return {
    mockPrisma: {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    },
    finalizeConversationEntitlementForGenerationRuns: vi.fn(),
    releaseConversationWalletUsage: vi.fn(),
    settleConversationWalletUsage: vi.fn(),
    transferAgentUsageEntitlementReservation: vi.fn(),
    transferConversationEntitlementByGenerationRunId: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  releaseConversationWalletUsage,
  settleConversationWalletUsage,
  transferAgentUsageEntitlementReservation,
}));
vi.mock("../src/service-entitlements", () => ({
  finalizeConversationEntitlementForGenerationRuns,
  transferConversationEntitlementByGenerationRunId,
}));

describe("delegation task owner actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma));
    mockPrisma.$queryRaw.mockResolvedValue([
      { originConversationId: "conversation-1" },
    ]);
    mockPrisma.delegationTaskEvent.findFirst.mockResolvedValue(null);
    mockPrisma.delegationTaskEvent.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.generationRun.create.mockResolvedValue({ id: "run-retry-1" });
    mockPrisma.generationRun.findFirst.mockResolvedValue({
      id: "run-1",
      status: "FAILED",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-1",
      representativeVersionId: "rep-version-1",
    });
    mockPrisma.generationRun.findMany.mockResolvedValue([]);
    mockPrisma.generationRun.upsert.mockResolvedValue({
      id: "run-terminal-recovery",
      status: "QUEUED",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-1",
      representativeVersionId: "rep-version-1",
    });
    mockPrisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.outboxEvent.findFirst.mockResolvedValue(null);
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowRun.findUnique.mockResolvedValue(null);
    mockPrisma.conversationTurnPlan.findFirst.mockResolvedValue(null);
    mockPrisma.conversationPlanAction.findMany.mockResolvedValue([]);
    mockPrisma.delegationTaskExternalEffect.findMany.mockResolvedValue([]);
    mockPrisma.delegationTaskOutput.count.mockResolvedValue(0);
    mockPrisma.delegationTaskOutput.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({
      state: "AI_QUEUED",
      sourceChannel: "web",
      channelBindings: [],
    });
    mockPrisma.conversation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.upsert.mockResolvedValue({
      id: "task-system-message-1",
    });
    mockPrisma.message.findUnique.mockResolvedValue({
      id: "task-system-message-1",
      conversationId: "conversation-1",
      senderType: "SYSTEM",
      deliveryStatus: "QUEUED",
      externalMessageId: null,
    });
    mockPrisma.outboxEvent.upsert.mockResolvedValue({
      id: "conversation-message-outbox-1",
    });
    mockPrisma.agentUsageCharge.findUnique.mockResolvedValue({
      status: "RESERVED",
    });
    finalizeConversationEntitlementForGenerationRuns.mockResolvedValue(null);
    releaseConversationWalletUsage.mockResolvedValue({ status: "released" });
    settleConversationWalletUsage.mockResolvedValue({ status: "settled" });
    transferAgentUsageEntitlementReservation.mockResolvedValue({ status: "RESERVED" });
    transferConversationEntitlementByGenerationRunId.mockResolvedValue(null);
  });

  it("queues a new generation attempt on the same failed task", async () => {
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce(buildTask("FAILED"))
      .mockResolvedValueOnce(null);
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([
      { id: "run-1", status: "FAILED" },
    ]);
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        inputMessageId: "message-1",
        status: "QUEUED",
        contextSnapshot: expect.objectContaining({
          source: "owner_retry",
          request: expect.objectContaining({
            capability: "read",
            path: "notes/source.txt",
          }),
          retryOfGenerationRunId: "run-1",
          requestedBy: "owner-1",
        }),
      }),
    });
    expect(
      mockPrisma.generationRun.create.mock.calls.at(-1)?.[0]
        .data.contextSnapshot,
    ).not.toHaveProperty("previousGenerationRunId");
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "generation_run",
        aggregateId: "run-retry-1",
        eventType: "generation.requested",
      }),
    });
    expect(transferConversationEntitlementByGenerationRunId).toHaveBeenCalledWith(
      {
        fromGenerationRunId: "run-1",
        toGenerationRunId: "run-retry-1",
      },
      mockPrisma,
    );
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: { in: ["run-1"] },
        eventType: "generation.requested",
        status: { in: ["PENDING", "FAILED"] },
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: "delegation_attempt_superseded",
      },
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "READY", nextActionBy: "SYSTEM" }),
    });
    expect(mockPrisma.delegationTaskOutput.updateMany).toHaveBeenCalledWith({
      where: { delegationTaskId: "task-1", isFinal: true },
      data: { isFinal: false },
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: "task-1",
        eventType: "task.retry_scheduled",
        actorType: "OWNER",
        fromStatus: "FAILED",
        toStatus: "READY",
      }),
    });
  }, 15_000);

  it("retries the failed step instead of a later blocked dependent step", async () => {
    const task = buildTask("FAILED");
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce({
        ...task,
        generationRuns: [{
          ...task.generationRuns[0]!,
          delegationTaskStepId: "step-failed",
        }],
        steps: [
          {
            ...task.steps[0]!,
            id: "step-failed",
            sequence: 1,
            status: "FAILED",
            inputSnapshot: {
              request: {
                ...task.steps[0]!.inputSnapshot.request,
                path: "inputs/failed-step.txt",
              },
            },
          },
          {
            ...task.steps[0]!,
            id: "step-blocked",
            sequence: 2,
            status: "BLOCKED",
            dependsOnStepIds: ["step-failed"],
            inputSnapshot: {
              request: {
                ...task.steps[0]!.inputSnapshot.request,
                path: "outputs/dependent-step.txt",
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce(null);
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([
      { id: "run-1", status: "FAILED" },
    ]);
    const { applyRepresentativeDelegationTaskAction } =
      await import("../src/delegation-tasks");

    await applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskStepId: "step-failed",
        contextSnapshot: expect.objectContaining({
          source: "owner_retry",
          request: expect.objectContaining({
            path: "inputs/failed-step.txt",
          }),
          retryOfGenerationRunId: "run-1",
        }),
      }),
    });
  });

  it("copies the persisted step request when the owner continues a waiting task", async () => {
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce(buildTask("WAITING_FOR_OWNER"))
      .mockResolvedValueOnce(null);
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "continue",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          source: "owner_continue",
          request: expect.objectContaining({
            capability: "read",
            path: "notes/source.txt",
          }),
          retryOfGenerationRunId: "run-1",
          requestedBy: "owner-1",
        }),
      }),
    });
  });

  it.each([
    { action: "retry" as const, status: "FAILED" },
    { action: "continue" as const, status: "WAITING_FOR_OWNER" },
  ])("atomically refuses owner $action when the step request is missing", async ({
    action,
    status,
  }) => {
    const task = buildTask(status);
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce({
      ...task,
      steps: [{
        ...task.steps[0],
        inputSnapshot: {},
      }],
    });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action,
      actorId: "owner-1",
    })).rejects.toThrow("persisted execution request");

    expect(mockPrisma.generationRun.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
  });

  it("does not schedule a retry while the previous attempt is still running", async () => {
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce(buildTask("FAILED"));
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([
      { id: "run-1", status: "PROCESSING" },
    ]);
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    })).rejects.toThrow("still running");

    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("cancels an older completed reply before scheduling a newer attempt", async () => {
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce(buildTask("FAILED"))
      .mockResolvedValueOnce(null);
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([{
      id: "run-completed-old",
      status: "COMPLETED",
      outputMessage: {
        id: "message-output-old",
        deliveryStatus: "QUEUED",
      },
    }]);
    mockPrisma.outboxEvent.findFirst.mockResolvedValueOnce({
      status: "PENDING",
      availableAt: new Date(Date.now() - 1_000),
    });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    });

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-completed-old",
        eventType: "generation.requested",
        status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: "delegation_attempt_superseded_before_delivery",
      },
    });
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-output-old",
        deliveryStatus: { in: ["PROCESSING", "QUEUED", "FAILED"] },
      },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "delegation_attempt_superseded_before_delivery",
        failureReason:
          "Delivery was canceled because the task was scheduled for a newer attempt.",
      },
    });
    expect(mockPrisma.generationRun.create).toHaveBeenCalled();
  });

  it("does not retry while an older completed reply is being delivered", async () => {
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce(buildTask("FAILED"));
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([{
      id: "run-completed-old",
      status: "COMPLETED",
      outputMessage: {
        id: "message-output-old",
        deliveryStatus: "PROCESSING",
      },
    }]);
    mockPrisma.outboxEvent.findFirst.mockResolvedValueOnce({
      status: "PROCESSING",
      availableAt: new Date(Date.now() + 60_000),
    });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    })).rejects.toThrow("currently being delivered");

    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it("does not reuse a released paid reservation when an owner retries a task", async () => {
    const task = buildTask("FAILED");
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce({
      ...task,
      generationRuns: [{
        ...task.generationRuns[0],
        delegationTaskStepId: "step-1",
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-released",
            tokenAmount: 1,
          },
        },
      }],
      steps: [{
        ...task.steps[0],
        kind: "COMPUTE",
        status: "FAILED",
      }],
    });
    mockPrisma.agentUsageCharge.findUnique.mockResolvedValueOnce({
      status: "RELEASED",
    });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "retry",
      actorId: "owner-1",
    })).rejects.toThrow("no longer reserved");

    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
  });

  it("refuses to bypass a pending approval during direct cancellation", async () => {
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce({
      ...buildTask("AWAITING_APPROVAL"),
      approvalRequests: [{ id: "approval-1", status: "PENDING" }],
    });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "cancel",
      actorId: "owner-1",
    })).rejects.toThrow("approval workflow");
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
  });

  it("cancels queued work, settles the conversation, and appends owner evidence", async () => {
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce({
        ...buildTask("READY"),
        generationRuns: [{
          id: "run-queued-1",
          conversationId: "conversation-1",
          episodeId: "episode-1",
          inputMessageId: "message-1",
          status: "QUEUED",
        }],
      })
      .mockResolvedValueOnce(null);
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "cancel",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-queued-1"] }, status: "QUEUED" },
      data: { status: "CANCELED", canceledAt: expect.any(Date) },
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "CANCELED", nextActionBy: "NONE" }),
    });
    expect(mockPrisma.message.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ delegationTaskId: "task-1", senderType: "SYSTEM" }),
    }));
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "task.canceled_by_owner",
        actorType: "OWNER",
        fromStatus: "READY",
        toStatus: "CANCELED",
      }),
    });
  });

  it("does not claim that a running atomic operation was canceled", async () => {
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce(buildTask("RUNNING"));
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "cancel",
      actorId: "owner-1",
    })).rejects.toThrow("termination is confirmed");
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
  });

  it("rolls back cancellation when the worker claims the outbox concurrently", async () => {
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce({
      ...buildTask("READY"),
      generationRuns: [{
        id: "run-queued-1",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        status: "QUEUED",
      }],
    });
    mockPrisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });
    const { applyRepresentativeDelegationTaskAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationTaskAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      action: "cancel",
      actorId: "owner-1",
    })).rejects.toThrow("claim its queue item");
    expect(mockPrisma.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
  });

  it("records a new final summary when a retried attempt completes without artifacts", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "READY",
      representativeId: "representative-1",
      steps: [{ id: "step-1" }],
      generationRuns: [{
        id: "run-1",
        delegationTaskStepId: "step-1",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await finalizeComputeDelegationTask({
      taskId: "task-1",
      generationRunId: "run-1",
      outboxId: "outbox-run-1",
      leaseAttempt: 3,
      outcome: "completed",
    });

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-run-1",
        aggregateType: "generation_run",
        aggregateId: "run-1",
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 3,
        availableAt: { gt: expect.any(Date) },
      },
      data: { status: "PROCESSING" },
    });
    expect(mockPrisma.delegationTaskOutput.create).toHaveBeenCalledWith({
      data: {
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        kind: "SUMMARY",
        title: "任务执行完成",
        summary: "completed",
        isFinal: true,
      },
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "task.completed",
        fromStatus: "READY",
        toStatus: "COMPLETED",
      }),
    });
  });

  it("rolls back task and billing finalization when the worker lease is stale", async () => {
    mockPrisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await expect(
      finalizeComputeDelegationTask({
        taskId: "task-1",
        stepId: "step-1",
        generationRunId: "run-1",
        outboxId: "outbox-run-1",
        leaseAttempt: 2,
        outcome: "completed",
      }),
    ).rejects.toMatchObject({
      code: "generation_work_lease_lost",
    });

    expect(mockPrisma.delegationTask.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskStep.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(finalizeConversationEntitlementForGenerationRuns).not.toHaveBeenCalled();
  });

  it("ignores finalization from an older generation attempt after a retry", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "READY",
      representativeId: "representative-1",
      steps: [{ id: "step-1", status: "READY" }],
      generationRuns: [
        {
          id: "run-new",
          delegationTaskStepId: "step-1",
          conversationId: "conversation-1",
        },
        {
          id: "run-old",
          delegationTaskStepId: "step-1",
          conversationId: "conversation-1",
        },
      ],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-1",
      generationRunId: "run-old",
      outcome: "failed",
      failureReason: "late worker result",
    });

    expect(result).toMatchObject({
      taskId: "task-1",
      status: "READY",
      superseded: true,
    });
    expect(mockPrisma.delegationTaskStep.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskExternalEffect.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskOutput.create).not.toHaveBeenCalled();
  });

  it("distinguishes a policy-blocked step from an execution failure", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "READY",
      representativeId: "representative-1",
      steps: [{ id: "step-1", status: "READY" }],
      generationRuns: [{
        id: "run-1",
        delegationTaskStepId: "step-1",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-1",
      generationRunId: "run-1",
      outcome: "blocked",
      failureReason: "Representative policy denies write.",
    });

    expect(mockPrisma.delegationTaskStep.update).toHaveBeenCalledWith({
      where: { id: "step-1" },
      data: expect.objectContaining({
        status: "BLOCKED",
        outputSnapshot: expect.objectContaining({ outcome: "blocked" }),
      }),
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("queues the next dependency-ready step without completing the business task", async () => {
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-step-2" });
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        { id: "step-1", kind: "COMPUTE", sequence: 1, status: "RUNNING", dependsOnStepIds: [], inputSnapshot: {} },
        {
          id: "step-2",
          kind: "COMPUTE",
          sequence: 2,
          status: "DRAFT",
          dependsOnStepIds: ["step-1"],
          inputSnapshot: {
            request: {
              capability: "read",
              path: "notes/p1.txt",
              displayTarget: "读取 notes/p1.txt",
              hasPaidEntitlement: false,
              browserMode: "deterministic",
              maxSteps: 1,
              allowMutations: false,
            },
          },
        },
      ],
      generationRuns: [{
        id: "run-step-1",
        delegationTaskStepId: "step-1",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-task-1",
            tokenAmount: 1,
          },
        },
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-1",
      generationRunId: "run-step-1",
      outcome: "completed",
    });

    expect(result).toMatchObject({ status: "READY", hasMoreSteps: true, nextGenerationRunId: "run-step-2" });
    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-2",
        idempotencyKey: "delegation-step:task-1:step-2",
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-task-1",
            tokenAmount: 1,
          },
        },
      }),
    });
    expect(mockPrisma.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-step-1" },
      data: {
        runtimePolicySnapshot: {
          billingMode: "service_credit_transferred",
          billingTransferredToGenerationRunId: "run-step-2",
        },
      },
    });
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(transferConversationEntitlementByGenerationRunId).toHaveBeenCalledWith(
      {
        fromGenerationRunId: "run-step-1",
        toGenerationRunId: "run-step-2",
      },
      mockPrisma,
    );
    expect(transferAgentUsageEntitlementReservation).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-task-1",
        fromGenerationRunId: "run-step-1",
        toGenerationRunId: "run-step-2",
        conversationId: "conversation-1",
      },
      mockPrisma,
    );
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ aggregateId: "run-step-2", eventType: "generation.requested" }),
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "READY", nextActionBy: "SYSTEM" }),
    });
  });

  it("transfers the no-charge marker across MCP-only dependency steps", async () => {
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-forecast" });
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-weather",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        { id: "step-search", kind: "MCP", sequence: 1, status: "RUNNING", dependsOnStepIds: [], inputSnapshot: {} },
        {
          id: "step-forecast",
          kind: "MCP",
          sequence: 2,
          status: "DRAFT",
          dependsOnStepIds: ["step-search"],
          inputSnapshot: {
            request: {
              capability: "mcp",
              bindingId: "weather-binding",
              toolName: "openmeteo_get_forecast",
              toolArguments: {},
              displayTarget: "查询天气",
              hasPaidEntitlement: false,
              browserMode: "deterministic",
              maxSteps: 1,
              allowMutations: false,
            },
          },
        },
      ],
      generationRuns: [{
        id: "run-search",
        delegationTaskStepId: "step-search",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        runtimePolicySnapshot: {
          billingMode: "free",
          usageExemptReason: "mcp",
        },
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-weather",
      stepId: "step-search",
      generationRunId: "run-search",
      outcome: "completed",
    });

    expect(result).toMatchObject({
      status: "READY",
      hasMoreSteps: true,
      nextGenerationRunId: "run-forecast",
    });
    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskStepId: "step-forecast",
        runtimePolicySnapshot: {
          billingMode: "free",
          usageExemptReason: "mcp",
        },
      }),
    });
    expect(transferAgentUsageEntitlementReservation).not.toHaveBeenCalled();
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("resolves a deferred V3 MCP argument only from a successful verified dependency result", async () => {
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-forecast" });
    const forecastStepSnapshot = {
      request: {
        capability: "mcp",
        bindingId: "weather-binding",
        toolName: "get_forecast",
        toolArguments: {},
        displayTarget: "capability-2",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
      },
      executionRequest: {
        executor: "mcp",
        planId: "plan-1",
        planRevision: 1,
        executionEpoch: 1,
        actionId: "action-forecast",
        generationRunId: "run-search",
        capabilityKey: "mcp.weather.get_forecast",
        capabilityVersion: "1",
        capabilityDefinitionHash: `sha256:${"1".repeat(64)}`,
        argumentsHash: `sha256:${"2".repeat(64)}`,
        idempotencyKey: "forecast-once",
        bindingId: "weather-binding",
        bindingRevision: 1,
        toolName: "get_forecast",
        expectedToolSchemaHash: `sha256:${"3".repeat(64)}`,
        expectedBindingDefinitionHash: `sha256:${"4".repeat(64)}`,
        toolArguments: {},
      },
    };
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-weather",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [{
        id: "step-search",
        kind: "MCP",
        sequence: 1,
        status: "RUNNING",
        dependsOnStepIds: [],
        inputSnapshot: {},
      }, {
        id: "step-forecast",
        kind: "MCP",
        sequence: 2,
        status: "DRAFT",
        dependsOnStepIds: ["step-search"],
        inputSnapshot: forecastStepSnapshot,
      }],
      generationRuns: [{
        id: "run-search",
        delegationTaskStepId: "step-search",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    mockPrisma.conversationPlanAction.findFirst.mockResolvedValueOnce({
      id: "action-forecast",
      dependsOnActionIds: ["action-search"],
      inputSnapshot: {
        arguments: {},
        argumentProvenance: {
          latitude: {
            source: "previous_action_output",
            pointer: "/actions/capability-1/output/results/0/latitude",
          },
          longitude: {
            source: "previous_action_output",
            pointer: "/actions/capability-1/output/results/0/longitude",
          },
          timezone: {
            source: "previous_action_output",
            pointer: "/actions/capability-1/output/results/0/timezone",
          },
        },
        inputSchema: {
          type: "object",
          properties: {
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
          required: ["latitude", "longitude"],
          additionalProperties: false,
        },
      },
      turnPlan: {
        protocolVersion: 3,
        actions: [{
          id: "action-search",
          actionKey: "capability-1",
          actionResults: [{
            id: "result-search",
            semanticOutcome: "succeeded",
            output: {
              results: [{
                latitude: 22.5431,
                longitude: 114.0579,
                timezone: "Asia/Shanghai",
              }],
            },
          }],
        }, {
          id: "action-forecast",
          actionKey: "capability-2",
          actionResults: [],
        }],
      },
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-weather",
      stepId: "step-search",
      generationRunId: "run-search",
      outcome: "completed",
    });

    expect(result).toMatchObject({
      status: "READY",
      hasMoreSteps: true,
      nextGenerationRunId: "run-forecast",
    });
    expect(mockPrisma.delegationTaskStep.update).toHaveBeenCalledWith({
      where: { id: "step-forecast" },
      data: {
        inputSnapshot: expect.objectContaining({
          request: expect.objectContaining({
            toolArguments: {
              latitude: 22.5431,
              longitude: 114.0579,
              timezone: "Asia/Shanghai",
            },
          }),
          executionRequest: expect.objectContaining({
            toolArguments: {
              latitude: 22.5431,
              longitude: 114.0579,
              timezone: "Asia/Shanghai",
            },
            argumentsHash: expect.stringMatching(/^sha256:/),
          }),
          resolvedArgumentBindings: expect.arrayContaining([
            expect.objectContaining({
              argumentKey: "latitude",
              sourceActionId: "action-search",
              actionResultId: "result-search",
            }),
          ]),
        }),
      },
    });
    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          request: expect.objectContaining({
            toolArguments: expect.objectContaining({
              latitude: 22.5431,
              longitude: 114.0579,
            }),
          }),
        }),
      }),
    });
  });

  it("activates only a pre-planned V3 fallback whose failure code matches", async () => {
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-fallback" });
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        {
          id: "step-primary",
          kind: "MCP",
          sequence: 1,
          status: "RUNNING",
          dependsOnStepIds: [],
          inputSnapshot: {},
        },
        {
          id: "step-fallback",
          kind: "MCP",
          sequence: 2,
          status: "DRAFT",
          dependsOnStepIds: ["step-primary"],
          inputSnapshot: {
            request: {
              capability: "mcp",
              bindingId: "binding-fallback",
              toolName: "lookup_backup",
              toolArguments: { id: "123" },
              displayTarget: "fallback lookup",
              hasPaidEntitlement: false,
              browserMode: "deterministic",
              maxSteps: 1,
              allowMutations: false,
            },
          },
        },
      ],
      generationRuns: [{
        id: "run-primary",
        delegationTaskStepId: "step-primary",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    mockPrisma.conversationPlanAction.findMany.mockResolvedValueOnce([
      {
        id: "action-primary",
        delegationTaskStepId: "step-primary",
        status: "FAILED",
        failurePolicy: {
          strategy: "try_planned_alternatives",
          alternativeActionIds: ["action-fallback"],
        },
        activationPolicy: { mode: "primary" },
        actionResults: [{ failure: { code: "primary_unavailable" } }],
      },
      {
        id: "action-fallback",
        delegationTaskStepId: "step-fallback",
        status: "PLANNED",
        failurePolicy: { strategy: "stop" },
        activationPolicy: {
          mode: "on_failure",
          sourceActionId: "action-primary",
          allowedFailureCodes: ["primary_unavailable"],
          priority: 1,
        },
        actionResults: [],
      },
    ]);
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-primary",
      generationRunId: "run-primary",
      outcome: "failed",
      failureReason: "primary_unavailable",
    });

    expect(result).toMatchObject({
      status: "READY",
      hasMoreSteps: true,
      nextGenerationRunId: "run-fallback",
    });
    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskStepId: "step-fallback",
        idempotencyKey: "delegation-step:task-1:step-fallback",
      }),
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "task.fallback_activated",
        payload: expect.objectContaining({ activation: "on_failure" }),
      }),
    });
  });

  it("continues a three-candidate V3 fallback group after the current fallback fails", async () => {
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-fallback-3" });
    const fallbackRequest = (toolName: string) => ({
      request: {
        capability: "mcp",
        bindingId: "binding-fallback",
        toolName,
        toolArguments: { id: "123" },
        displayTarget: toolName,
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
      },
    });
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        {
          id: "step-primary",
          kind: "MCP",
          sequence: 1,
          status: "FAILED",
          dependsOnStepIds: [],
          inputSnapshot: {},
        },
        {
          id: "step-fallback-1",
          kind: "MCP",
          sequence: 2,
          status: "FAILED",
          dependsOnStepIds: ["step-primary"],
          inputSnapshot: fallbackRequest("lookup_backup_1"),
        },
        {
          id: "step-fallback-2",
          kind: "MCP",
          sequence: 3,
          status: "RUNNING",
          dependsOnStepIds: ["step-primary"],
          inputSnapshot: fallbackRequest("lookup_backup_2"),
        },
        {
          id: "step-fallback-3",
          kind: "MCP",
          sequence: 4,
          status: "DRAFT",
          dependsOnStepIds: ["step-primary"],
          inputSnapshot: fallbackRequest("lookup_backup_3"),
        },
      ],
      generationRuns: [{
        id: "run-fallback-2",
        delegationTaskStepId: "step-fallback-2",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    mockPrisma.conversationPlanAction.findMany.mockResolvedValueOnce([
      {
        id: "action-primary",
        delegationTaskStepId: "step-primary",
        status: "FAILED",
        failurePolicy: {
          strategy: "try_planned_alternatives",
          alternativeActionIds: [
            "action-fallback-1",
            "action-fallback-2",
            "action-fallback-3",
          ],
        },
        activationPolicy: { mode: "primary" },
        actionResults: [{ failure: { code: "primary_unavailable" } }],
      },
      ...[1, 2, 3].map((priority) => ({
        id: `action-fallback-${priority}`,
        delegationTaskStepId: `step-fallback-${priority}`,
        status: priority < 3 ? "FAILED" : "PLANNED",
        failurePolicy: { strategy: "stop" },
        activationPolicy: {
          mode: "on_failure",
          sourceActionId: "action-primary",
          allowedFailureCodes: ["primary_unavailable"],
          fallbackGroupKey: "repository-read",
          priority,
        },
        actionResults: priority === 2
          ? [{ failure: { code: "fallback_failed" } }]
          : [],
      })),
    ]);
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-fallback-2",
      generationRunId: "run-fallback-2",
      outcome: "failed",
      failureReason: "fallback_failed",
    });

    expect(result).toMatchObject({
      status: "READY",
      hasMoreSteps: true,
      nextGenerationRunId: "run-fallback-3",
    });
    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskStepId: "step-fallback-3",
        idempotencyKey: "delegation-step:task-1:step-fallback-3",
      }),
    });
  });

  it("settles the single task reservation only after the second approved step succeeds", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "AWAITING_APPROVAL",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        {
          id: "step-1",
          kind: "COMPUTE",
          sequence: 1,
          status: "COMPLETED",
          dependsOnStepIds: [],
          inputSnapshot: {},
        },
        {
          id: "step-2",
          kind: "COMPUTE",
          sequence: 2,
          status: "WAITING_APPROVAL",
          dependsOnStepIds: ["step-1"],
          inputSnapshot: {},
        },
      ],
      generationRuns: [
        {
          id: "run-step-2",
          delegationTaskStepId: "step-2",
          conversationId: "conversation-1",
          episodeId: "episode-1",
          inputMessageId: "message-1",
          runtimePolicySnapshot: {
            billingMode: "service_credit",
            walletReservation: {
              usageChargeId: "usage-task-1",
              tokenAmount: 1,
            },
          },
        },
        {
          id: "run-step-1",
          delegationTaskStepId: "step-1",
          conversationId: "conversation-1",
          episodeId: "episode-1",
          inputMessageId: "message-1",
          runtimePolicySnapshot: {
            billingMode: "service_credit_transferred",
            billingTransferredToGenerationRunId: "run-step-2",
          },
        },
      ],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-2",
      generationRunId: "run-step-2",
      outcome: "completed",
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      hasMoreSteps: false,
      completedStepId: "step-2",
    });
    expect(settleConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-task-1",
        expectedGenerationRunId: "run-step-2",
        settledTokenAmount: 1,
        provider: "compute",
        idempotencyKey: "delegation-task:task-1:settle",
      },
      mockPrisma,
    );
    expect(finalizeConversationEntitlementForGenerationRuns).toHaveBeenCalledWith(
      {
        generationRunIds: ["run-step-2", "run-step-1"],
        outcome: "consume",
        reason: "delegation_task_completed",
      },
      mockPrisma,
    );
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mockPrisma.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-step-2" },
      data: {
        runtimePolicySnapshot: expect.objectContaining({
          billingMode: "service_credit_settled",
          billingFinalizedAt: expect.any(String),
        }),
      },
    });
    expect(mockPrisma.conversation.update.mock.calls).not.toContainEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          freeRepliesUsed: expect.anything(),
        }),
      }),
    ]);
  });

  it("releases the single task reservation when the second approved step fails", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "AWAITING_APPROVAL",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        {
          id: "step-1",
          kind: "COMPUTE",
          sequence: 1,
          status: "COMPLETED",
          dependsOnStepIds: [],
          inputSnapshot: {},
        },
        {
          id: "step-2",
          kind: "COMPUTE",
          sequence: 2,
          status: "WAITING_APPROVAL",
          dependsOnStepIds: ["step-1"],
          inputSnapshot: {},
        },
      ],
      generationRuns: [{
        id: "run-step-2",
        delegationTaskStepId: "step-2",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-task-1",
            tokenAmount: 1,
          },
        },
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-2",
      generationRunId: "run-step-2",
      outcome: "failed",
      failureReason: "sandbox_failed",
    });

    expect(result).toMatchObject({
      status: "FAILED",
      hasMoreSteps: false,
      completedStepId: "step-2",
    });
    expect(releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-task-1",
        expectedGenerationRunId: "run-step-2",
        failed: true,
        reason: "delegation_task_failed",
        idempotencyKey: "delegation-task:task-1:release",
      },
      mockPrisma,
    );
    expect(finalizeConversationEntitlementForGenerationRuns).toHaveBeenCalledWith(
      {
        generationRunIds: ["run-step-2"],
        outcome: "release",
        reason: "delegation_task_failed",
      },
      mockPrisma,
    );
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mockPrisma.conversation.update.mock.calls).not.toContainEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          freeRepliesUsed: expect.anything(),
        }),
      }),
    ]);
  });

  it("consumes one free reply only when the full multi-step task succeeds", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-free",
      status: "AWAITING_APPROVAL",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        {
          id: "step-1",
          kind: "COMPUTE",
          sequence: 1,
          status: "COMPLETED",
          dependsOnStepIds: [],
          inputSnapshot: {},
        },
        {
          id: "step-2",
          kind: "COMPUTE",
          sequence: 2,
          status: "WAITING_APPROVAL",
          dependsOnStepIds: ["step-1"],
          inputSnapshot: {},
        },
      ],
      generationRuns: [{
        id: "run-free-step-2",
        delegationTaskStepId: "step-2",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        runtimePolicySnapshot: { billingMode: "free" },
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await finalizeComputeDelegationTask({
      taskId: "task-free",
      stepId: "step-2",
      generationRunId: "run-free-step-2",
      outcome: "completed",
    });

    expect(mockPrisma.conversation.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { freeRepliesUsed: { increment: 1 } },
    });
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("does not consume a free reply or service credit for an MCP-only task", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-mcp-free",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [{
        id: "step-mcp",
        kind: "MCP",
        sequence: 1,
        status: "RUNNING",
        dependsOnStepIds: [],
        inputSnapshot: {},
      }],
      generationRuns: [{
        id: "run-mcp-free",
        delegationTaskStepId: "step-mcp",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        runtimePolicySnapshot: {
          billingMode: "free",
          usageExemptReason: "mcp",
        },
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await finalizeComputeDelegationTask({
      taskId: "task-mcp-free",
      stepId: "step-mcp",
      generationRunId: "run-mcp-free",
      outcome: "completed",
    });

    expect(mockPrisma.conversation.update.mock.calls).not.toContainEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          freeRepliesUsed: expect.anything(),
        }),
      }),
    ]);
    expect(settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("fails the task instead of reporting completion when remaining step dependencies cannot be satisfied", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: "RUNNING",
      representativeId: "representative-1",
      representativeVersionId: "rep-version-1",
      steps: [
        { id: "step-1", sequence: 1, status: "RUNNING", dependsOnStepIds: [], inputSnapshot: {} },
        { id: "step-2", sequence: 2, status: "DRAFT", dependsOnStepIds: ["missing-step"], inputSnapshot: {} },
      ],
      generationRuns: [{
        id: "run-step-1",
        delegationTaskStepId: "step-1",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
      }],
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    const result = await finalizeComputeDelegationTask({
      taskId: "task-1",
      stepId: "step-1",
      generationRunId: "run-step-1",
      outcome: "completed",
    });

    expect(result).toMatchObject({ status: "FAILED", hasMoreSteps: false });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "FAILED",
        blockingReason: expect.stringContaining("没有满足依赖条件"),
      }),
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "task.failed", toStatus: "FAILED" }),
    });
  });

  it("safely retries a confirmed failed MCP effect from its captured request", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce({
      id: "effect-1",
      status: "FAILED",
      requestPayload: {
        request: {
          capability: "mcp",
          bindingSlug: "crm",
          toolName: "create_lead",
          toolArguments: { name: "Ada" },
          displayTarget: "Create CRM lead",
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        },
      },
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "FAILED",
        version: 4,
        representativeVersionId: "rep-version-1",
        generationRuns: [{
          id: "run-1",
          delegationTaskStepId: "step-1",
          conversationId: "conversation-1",
          episodeId: "episode-1",
          inputMessageId: "message-1",
        }],
      },
    });
    mockPrisma.generationRun.create.mockResolvedValueOnce({ id: "run-effect-retry" });
    mockPrisma.generationRun.findMany.mockResolvedValueOnce([
      { id: "run-1", status: "FAILED" },
    ]);
    mockPrisma.delegationTask.findFirst.mockResolvedValueOnce(null);
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-1",
      action: "retry",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        idempotencyKey: "external-effect-retry:effect-1:5",
      }),
    });
    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "PROPOSED", failureReason: null, reconciledAt: null },
    });
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        aggregateId: { in: ["run-1"] },
        status: { in: ["PENDING", "FAILED"] },
      }),
      data: expect.objectContaining({
        status: "PROCESSED",
        lastError: "delegation_attempt_superseded",
      }),
    });
  });

  it("does not retry one external effect while a sibling outcome is still uncertain", async () => {
    const failedEffect = {
      id: "effect-failed",
      status: "FAILED",
      requestPayload: {
        request: {
          capability: "mcp",
          bindingSlug: "crm",
          toolName: "create_lead",
          toolArguments: { name: "Ada" },
          displayTarget: "Create CRM lead",
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        },
      },
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "WAITING_FOR_OWNER",
        version: 4,
        representativeVersionId: "rep-version-1",
        generationRuns: [{
          id: "run-1",
          delegationTaskStepId: "step-1",
          conversationId: "conversation-1",
          episodeId: "episode-1",
          inputMessageId: "message-1",
        }],
      },
    };
    mockPrisma.delegationTaskExternalEffect.findFirst
      .mockResolvedValueOnce(failedEffect)
      .mockResolvedValueOnce({ id: "effect-uncertain-sibling" });
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-failed",
      action: "retry",
      actorId: "owner-1",
    })).rejects.toThrow("Reconcile every uncertain external effect");

    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskExternalEffect.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
  });

  it("requires evidence before resolving an unknown MCP outcome", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce({
      id: "effect-unknown",
      status: "RECONCILIATION_REQUIRED",
      requestPayload: null,
      responseSnapshot: null,
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "WAITING_FOR_OWNER",
        generationRuns: [],
      },
    });
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "reconcile",
      observedOutcome: "succeeded",
      actorId: "owner-1",
    })).rejects.toThrow("requires a note or external reference");

    expect(mockPrisma.delegationTaskExternalEffect.update).not.toHaveBeenCalled();
  });

  it("records evidence when the owner reconciles an unknown MCP outcome as successful", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce({
      id: "effect-unknown",
      status: "RECONCILIATION_REQUIRED",
      requestPayload: null,
      responseSnapshot: { outcome: "transport_error" },
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "WAITING_FOR_OWNER",
        generationRuns: [],
      },
    });
    mockPrisma.delegationTaskExternalEffect.findMany
      .mockResolvedValueOnce([{ status: "SUCCEEDED" }])
      .mockResolvedValueOnce([
        {
          id: "effect-unknown",
          status: "SUCCEEDED",
          responseSnapshot: { outcome: "transport_error" },
        },
      ]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildReconciliationTask(),
    );
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "reconcile",
      observedOutcome: "succeeded",
      note: "CRM audit log shows one completed create operation.",
      actorId: "owner-1",
    });

    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-unknown" },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        reconciledAt: expect.any(Date),
        responseSnapshot: expect.objectContaining({
          reconciliation: expect.objectContaining({
            observedOutcome: "succeeded",
            reconciledBy: "owner-1",
          }),
        }),
      }),
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "external_effect.reconciled_succeeded",
        actorType: "OWNER",
      }),
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        nextActionBy: "NONE",
      }),
    });
    expect(mockPrisma.delegationTaskExternalEffect.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "generation_run",
        aggregateId: "run-1",
        eventType: "generation.requested",
        idempotencyKey:
          "generation.requested:terminal-recovery:run-1:effect-unknown:reconciled_succeeded",
        payload: expect.objectContaining({
          runId: "run-1",
          taskId: "task-1",
          stepId: "step-1",
          effectId: "effect-unknown",
          terminalRecovery: true,
          resolution: "reconciled_succeeded",
        }),
      }),
    });
    expect(mockPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: "AI_QUEUED",
        lastMessageAt: expect.any(Date),
      },
    });
    expect(mockPrisma.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        deliveryStatus: "QUEUED",
        failureCode: null,
        failureReason: null,
      },
    });
    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
  });

  it("queues a terminal recovery conclusion after the owner confirms failure", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce(
      buildExternalEffect("RECONCILIATION_REQUIRED"),
    );
    mockPrisma.delegationTaskExternalEffect.findMany
      .mockResolvedValueOnce([{ status: "FAILED" }])
      .mockResolvedValueOnce([{
        id: "effect-unknown",
        status: "FAILED",
        responseSnapshot: { outcome: "transport_error" },
      }]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildReconciliationTask(),
    );
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "reconcile",
      observedOutcome: "failed",
      note: "CRM audit log confirms that the create operation failed.",
      actorId: "owner-1",
    });

    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "FAILED",
        nextActionBy: "NONE",
      }),
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "run-1",
        eventType: "generation.requested",
        idempotencyKey:
          "generation.requested:terminal-recovery:run-1:effect-unknown:reconciled_failed",
        payload: expect.objectContaining({
          terminalRecovery: true,
          resolution: "reconciled_failed",
        }),
      }),
    });
    expect(mockPrisma.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: expect.objectContaining({ deliveryStatus: "QUEUED" }),
    });
  });

  it("queues a terminal recovery conclusion after compensation is recorded", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce(
      buildExternalEffect("SUCCEEDED"),
    );
    mockPrisma.delegationTaskExternalEffect.findMany
      .mockResolvedValueOnce([{ status: "CANCELED" }])
      .mockResolvedValueOnce([{
        id: "effect-unknown",
        status: "CANCELED",
        responseSnapshot: { outcome: "completed" },
      }]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildReconciliationTask(),
    );
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "record_compensation",
      note: "The CRM lead was removed manually.",
      externalReferenceId: "crm-audit-42",
      actorId: "owner-1",
    });

    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-unknown" },
      data: expect.objectContaining({
        status: "CANCELED",
        reconciledAt: expect.any(Date),
        externalReferenceId: "crm-audit-42",
      }),
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "run-1",
        eventType: "generation.requested",
        idempotencyKey:
          "generation.requested:terminal-recovery:run-1:effect-unknown:compensated",
        payload: expect.objectContaining({
          terminalRecovery: true,
          resolution: "compensated",
        }),
      }),
    });
    expect(mockPrisma.delegationTaskOutput.updateMany).toHaveBeenCalledWith({
      where: { externalEffectId: "effect-unknown" },
      data: {
        summary: "compensated: The CRM lead was removed manually.",
        isFinal: true,
      },
    });
  });

  it("creates a dedicated recovery run instead of reusing a completed effect run", async () => {
    const completedTask = buildReconciliationTask();
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce({
      ...buildExternalEffect("SUCCEEDED"),
      delegationTask: {
        ...buildExternalEffect("SUCCEEDED").delegationTask,
        status: "COMPLETED",
      },
    });
    mockPrisma.delegationTaskExternalEffect.findMany.mockResolvedValueOnce([
      { status: "CANCELED" },
    ]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      ...completedTask,
      status: "COMPLETED",
      steps: [{
        ...completedTask.steps[0],
        status: "COMPLETED",
      }],
    });
    mockPrisma.generationRun.findFirst.mockResolvedValueOnce({
      id: "run-completed-effect",
      status: "COMPLETED",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-1",
      representativeVersionId: "rep-version-1",
    });
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "record_compensation",
      note: "The remote mutation was manually reversed.",
      actorId: "owner-1",
    });

    expect(mockPrisma.generationRun.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey:
          "delegation-terminal-recovery:run-completed-effect:effect-unknown:compensated",
      },
      update: {},
      create: expect.objectContaining({
        status: "QUEUED",
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        contextSnapshot: {
          source: "delegation_terminal_recovery",
          sourceGenerationRunId: "run-completed-effect",
          effectId: "effect-unknown",
          resolution: "compensated",
        },
      }),
      select: expect.any(Object),
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "run-terminal-recovery",
        idempotencyKey:
          "generation.requested:terminal-recovery:run-terminal-recovery:effect-unknown:compensated",
        payload: expect.objectContaining({
          terminalRecovery: true,
          resolution: "compensated",
        }),
      }),
    });
    expect(mockPrisma.generationRun.create).not.toHaveBeenCalled();
  });

  it("records the terminal conclusion in conversation history without taking human control", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce(
      buildExternalEffect("RECONCILIATION_REQUIRED"),
    );
    mockPrisma.delegationTaskExternalEffect.findMany
      .mockResolvedValueOnce([{ status: "SUCCEEDED" }])
      .mockResolvedValueOnce([{
        id: "effect-unknown",
        status: "SUCCEEDED",
        responseSnapshot: { outcome: "transport_error" },
      }]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildReconciliationTask(),
    );
    mockPrisma.conversation.findUnique.mockResolvedValueOnce({
      state: "HUMAN_ACTIVE",
    });
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "reconcile",
      observedOutcome: "succeeded",
      note: "CRM audit log confirms success.",
      actorId: "owner-1",
    });

    expect(mockPrisma.message.upsert).toHaveBeenCalledWith({
      where: {
        conversationId_clientMessageId: {
          conversationId: "conversation-1",
          clientMessageId:
            "delegation-external-effect-conclusion:effect-unknown:reconciled_succeeded:run-1",
        },
      },
      create: expect.objectContaining({
        conversationId: "conversation-1",
        delegationTaskId: "task-1",
        senderType: "SYSTEM",
        deliveryStatus: "QUEUED",
        text: expect.stringContaining("确认外部操作成功"),
      }),
      update: {},
    });
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey:
          "conversation.message.requested:task-system-message-1",
      },
      create: expect.objectContaining({
        aggregateType: "conversation_message",
        aggregateId: "task-system-message-1",
        eventType: "conversation.message.requested",
        payload: expect.objectContaining({
          deliveryKind: "delegation_task_status",
          messageId: "task-system-message-1",
        }),
      }),
      update: {},
    });
    expect(mockPrisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.update).toHaveBeenCalledWith({
      where: { id: "task-system-message-1" },
      data: expect.objectContaining({ deliveryStatus: "QUEUED" }),
    });
  });

  it("reuses an existing pending terminal recovery outbox idempotently", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce(
      buildExternalEffect("RECONCILIATION_REQUIRED"),
    );
    mockPrisma.delegationTaskExternalEffect.findMany
      .mockResolvedValueOnce([{ status: "SUCCEEDED" }])
      .mockResolvedValueOnce([{
        id: "effect-unknown",
        status: "SUCCEEDED",
        responseSnapshot: { outcome: "transport_error" },
      }]);
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildReconciliationTask(),
    );
    mockPrisma.outboxEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "outbox-terminal-recovery",
        status: "PENDING",
        attemptCount: 1,
        availableAt: new Date(Date.now() - 1_000),
      });
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown",
      action: "reconcile",
      observedOutcome: "succeeded",
      note: "CRM audit log confirms success.",
      actorId: "owner-1",
    });

    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-terminal-recovery",
        status: "PENDING",
        attemptCount: 1,
      },
      data: {
        status: "PENDING",
        availableAt: expect.any(Date),
        processedAt: null,
        lastError: null,
      },
    });
  });

  it("keeps the task waiting until every external effect is reconciled", async () => {
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce({
      id: "effect-unknown-1",
      status: "RECONCILIATION_REQUIRED",
      requestPayload: null,
      responseSnapshot: { outcome: "transport_error" },
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "WAITING_FOR_OWNER",
        generationRuns: [],
      },
    });
    mockPrisma.delegationTaskExternalEffect.findMany.mockResolvedValueOnce([
      { status: "SUCCEEDED" },
      { status: "RECONCILIATION_REQUIRED" },
    ]);
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: "effect-unknown-1",
      action: "reconcile",
      observedOutcome: "succeeded",
      note: "First remote operation is confirmed.",
      actorId: "owner-1",
    });

    expect(mockPrisma.delegationTask.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskStep.update).not.toHaveBeenCalled();
  });

  it("keeps effect evidence and task finalization in one transaction", async () => {
    const effect = {
      id: "effect-unknown",
      status: "RECONCILIATION_REQUIRED",
      requestPayload: null,
      responseSnapshot: { outcome: "transport_error" },
      delegationTaskStepId: "step-1",
      delegationTaskStep: { id: "step-1" },
      delegationTask: {
        id: "task-1",
        status: "WAITING_FOR_OWNER",
        generationRuns: [],
      },
    };
    mockPrisma.delegationTaskExternalEffect.findFirst.mockResolvedValueOnce(effect);
    mockPrisma.delegationTaskExternalEffect.findMany.mockResolvedValueOnce([
      { status: "SUCCEEDED" },
    ]);
    mockPrisma.delegationTask.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    const { applyRepresentativeDelegationExternalEffectAction } = await import("../src/delegation-tasks");

    await expect(applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: "sktone",
      taskId: "task-1",
      effectId: effect.id,
      action: "reconcile",
      observedOutcome: "succeeded",
      note: "CRM audit log confirms success.",
      actorId: "owner-1",
    })).rejects.toThrow("database unavailable");

    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenCalledWith({
      where: { id: effect.id },
      data: expect.objectContaining({ status: "SUCCEEDED" }),
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("atomically aborts a delegation task when generation preflight fails", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildGenerationPreflightTask("RUNNING"),
    );
    const {
      abortDelegationTaskForGenerationFailureInTransaction,
    } = await import("../src/delegation-tasks");

    const result =
      await abortDelegationTaskForGenerationFailureInTransaction(
        mockPrisma as never,
        {
          taskId: "task-preflight",
          generationRunId: "run-current",
          stepId: "step-current",
          failureReason: "Representative version context is invalid.",
        },
      );

    expect(result).toEqual({
      taskId: "task-preflight",
      status: "FAILED",
      aborted: true,
    });
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: { in: ["run-queued-other"] },
        eventType: "generation.requested",
        status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: "delegation_task_generation_preflight_failed",
      },
    });
    expect(mockPrisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["run-queued-other"] },
        status: "QUEUED",
      },
      data: {
        status: "CANCELED",
        errorCode: "delegation_task_generation_preflight_failed",
        errorMessage:
          "Generation was canceled because another task attempt failed preflight.",
        canceledAt: expect.any(Date),
      },
    });
    expect(mockPrisma.delegationTaskStep.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          id: "step-current",
          delegationTaskId: "task-preflight",
          status: {
            notIn: [
              "COMPLETED",
              "FAILED",
              "BLOCKED",
              "CANCELED",
              "SKIPPED",
            ],
          },
        },
        data: {
          status: "FAILED",
          outputSnapshot: {
            outcome: "failed",
            failureReason: "Representative version context is invalid.",
            source: "generation_preflight",
          },
          failedAt: expect.any(Date),
        },
      },
    );
    expect(mockPrisma.delegationTaskStep.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          delegationTaskId: "task-preflight",
          id: { not: "step-current" },
          status: {
            notIn: [
              "COMPLETED",
              "FAILED",
              "BLOCKED",
              "CANCELED",
              "SKIPPED",
            ],
          },
        },
        data: { status: "BLOCKED" },
      },
    );
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-preflight" },
      data: expect.objectContaining({
        status: "FAILED",
        nextActionBy: "NONE",
        blockingReason: "Representative version context is invalid.",
        failedAt: expect.any(Date),
      }),
    });
    expect(releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-preflight",
        expectedGenerationRunId: "run-current",
        failed: true,
        reason: "delegation_task_failed",
        idempotencyKey: "delegation-task:task-preflight:release",
      },
      mockPrisma,
    );
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: "task-preflight",
        eventType: "task.generation_preflight_failed",
        actorType: "SYSTEM",
        fromStatus: "RUNNING",
        toStatus: "FAILED",
        payload: {
          generationRunId: "run-current",
          stepId: "step-current",
          failureReason: "Representative version context is invalid.",
        },
      }),
    });
    expect(mockPrisma.message.upsert).toHaveBeenCalledWith({
      where: {
        conversationId_clientMessageId: {
          conversationId: "conversation-1",
          clientMessageId:
            "delegation-task-generation-preflight-failed:task-preflight:8",
        },
      },
      create: expect.objectContaining({
        delegationTaskId: "task-preflight",
        senderType: "SYSTEM",
        text: expect.stringContaining("Representative version context is invalid."),
      }),
      update: {},
    });
  });

  it("leaves an already terminal task unchanged when preflight abort is retried", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce(
      buildGenerationPreflightTask("FAILED"),
    );
    const {
      abortDelegationTaskForGenerationFailureInTransaction,
    } = await import("../src/delegation-tasks");

    const result =
      await abortDelegationTaskForGenerationFailureInTransaction(
        mockPrisma as never,
        {
          taskId: "task-preflight",
          generationRunId: "run-current",
          failureReason: "Repeated preflight failure.",
        },
      );

    expect(result).toEqual({
      taskId: "task-preflight",
      status: "FAILED",
      aborted: false,
    });
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskStep.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskOutput.create).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.upsert).not.toHaveBeenCalled();
  });

  it("preserves billing and requires owner reconciliation when an external outcome is unknown", async () => {
    const task = buildGenerationPreflightTask("RUNNING");
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      ...task,
      externalEffects: [{
        id: "effect-executing",
        status: "EXECUTING",
      }],
    });
    const {
      abortDelegationTaskForGenerationFailureInTransaction,
    } = await import("../src/delegation-tasks");

    const result =
      await abortDelegationTaskForGenerationFailureInTransaction(
        mockPrisma as never,
        {
          taskId: "task-preflight",
          generationRunId: "run-current",
          stepId: "step-current",
          failureReason: "Representative version context is invalid.",
        },
      );

    expect(result).toEqual({
      taskId: "task-preflight",
      status: "WAITING_FOR_OWNER",
      aborted: false,
    });
    expect(mockPrisma.delegationTaskExternalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["effect-executing"] },
        status: "EXECUTING",
      },
      data: {
        status: "RECONCILIATION_REQUIRED",
        failureReason:
          "generation_preflight_failed_while_external_effect_outcome_unknown",
      },
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-preflight" },
      data: {
        status: "WAITING_FOR_OWNER",
        nextActionBy: "OWNER",
        blockingReason: expect.stringContaining(
          "Representative version context is invalid.",
        ),
        version: { increment: 1 },
      },
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "task.reconciliation_required",
        fromStatus: "RUNNING",
        toStatus: "WAITING_FOR_OWNER",
        payload: expect.objectContaining({
          uncertainExternalEffectIds: ["effect-executing"],
        }),
      }),
    });
    expect(mockPrisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskStep.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskOutput.create).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("idempotently leaves an existing reconciliation hold unchanged", async () => {
    const task = buildGenerationPreflightTask("WAITING_FOR_OWNER");
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
      ...task,
      externalEffects: [{
        id: "effect-unknown",
        status: "RECONCILIATION_REQUIRED",
      }],
    });
    const {
      abortDelegationTaskForGenerationFailureInTransaction,
    } = await import("../src/delegation-tasks");

    const result =
      await abortDelegationTaskForGenerationFailureInTransaction(
        mockPrisma as never,
        {
          taskId: "task-preflight",
          generationRunId: "run-current",
          failureReason: "Repeated version preflight failure.",
        },
      );

    expect(result).toEqual({
      taskId: "task-preflight",
      status: "WAITING_FOR_OWNER",
      aborted: false,
    });
    expect(mockPrisma.delegationTaskExternalEffect.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.upsert).not.toHaveBeenCalled();
    expect(releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("does not record the same clarification message twice when delivery is retried", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValue({
      id: "task-clarifying",
      status: "CLARIFYING",
      contactId: "contact-1",
      originConversationId: "conversation-1",
      blockingReason: "请补充路径",
      steps: [{ id: "step-clarifying", kind: "CLARIFICATION", status: "WAITING_INPUT" }],
      resourcePolicy: null,
    });
    mockPrisma.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-clarifying",
      conversationId: "conversation-1",
      inputMessageId: "message-supplement",
      inputMessage: { text: "路径：notes/report.md" },
    });
    mockPrisma.delegationTaskInput.findFirst.mockResolvedValueOnce({ id: "input-existing" });
    const { continueClarifyingDelegationTask } = await import("../src/delegation-tasks");

    const result = await continueClarifyingDelegationTask({
      taskId: "task-clarifying",
      generationRunId: "run-clarifying",
      inputMessageId: "message-supplement",
      contactId: "contact-1",
      question: "请补充路径",
      missingFields: ["path"],
    });

    expect(result).toMatchObject({ ready: false, question: "请补充路径" });
    expect(mockPrisma.delegationTaskInput.create).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTaskEvent.create).not.toHaveBeenCalled();
  });

  it("persists a clarified execution request on the generation run for safe retries", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValue({
      id: "task-clarifying",
      status: "CLARIFYING",
      contactId: "contact-1",
      originConversationId: "conversation-1",
      blockingReason: "请补充报告要求",
      planSummary: "生成报告",
      steps: [{ id: "step-clarifying", kind: "CLARIFICATION", status: "WAITING_INPUT" }],
      resourcePolicy: { maxDurationMinutes: 15 },
    });
    mockPrisma.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-clarifying",
      conversationId: "conversation-1",
      inputMessageId: "message-supplement",
      inputMessage: { text: "生成面向管理层的季度销售报告" },
    });
    mockPrisma.delegationTaskInput.findFirst.mockResolvedValueOnce(null);
    mockPrisma.delegationTaskStep.create.mockResolvedValueOnce({ id: "step-report", sequence: 2 });
    const request = {
      capability: "write" as const,
      path: "outputs/report-abcd1234.md",
      content: "# 季度销售报告",
      displayTarget: "生成季度销售报告",
      hasPaidEntitlement: false,
      browserMode: "deterministic" as const,
      maxSteps: 1,
      allowMutations: false,
    };
    const { continueClarifyingDelegationTask } = await import("../src/delegation-tasks");

    await continueClarifyingDelegationTask({
      taskId: "task-clarifying",
      generationRunId: "run-clarifying",
      inputMessageId: "message-supplement",
      contactId: "contact-1",
      planSummary: "生成季度销售报告",
      planSteps: [{ summary: "生成季度销售报告", request }],
    });

    expect(mockPrisma.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-clarifying" },
      data: {
        delegationTaskId: "task-clarifying",
        delegationTaskStepId: "step-report",
        contextSnapshot: {
          source: "delegation_plan_step",
          request,
        },
      },
    });
  });
});

function buildTask(status: string) {
  return {
    id: "task-1",
    status,
    kind: "COMPUTE",
    version: 3,
    representativeVersionId: "rep-version-1",
    originConversationId: "conversation-1",
    originEpisodeId: "episode-1",
    generationRuns: [{
      id: "run-1",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-1",
      status: "FAILED",
    }],
    steps: [{
      id: "step-1",
      kind: "COMPUTE",
      sequence: 1,
      status: status === "FAILED" ? "FAILED" : "READY",
      dependsOnStepIds: [],
      inputSnapshot: {
        request: {
          capability: "read",
          path: "notes/source.txt",
          displayTarget: "读取 notes/source.txt",
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        },
      },
    }],
    approvalRequests: [],
    externalEffects: [],
  };
}

function buildReconciliationTask() {
  return {
    id: "task-1",
    status: "WAITING_FOR_OWNER",
    representativeId: "representative-1",
    representativeVersionId: "rep-version-1",
    steps: [{
      id: "step-1",
      kind: "MCP",
      sequence: 1,
      status: "FAILED",
      dependsOnStepIds: [],
      inputSnapshot: {},
    }],
    generationRuns: [{
      id: "run-1",
      delegationTaskStepId: "step-1",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-1",
      runtimePolicySnapshot: null,
    }],
  };
}

function buildExternalEffect(status: string) {
  return {
    id: "effect-unknown",
    status,
    requestPayload: null,
    responseSnapshot: { outcome: "transport_error" },
    delegationTaskStepId: "step-1",
    delegationTaskStep: { id: "step-1" },
    delegationTask: {
      id: "task-1",
      status: "WAITING_FOR_OWNER",
      originConversationId: "conversation-1",
      generationRuns: [],
    },
  };
}

function buildGenerationPreflightTask(status: string) {
  return {
    id: "task-preflight",
    status,
    version: 7,
    originConversationId: "conversation-1",
    originEpisodeId: "episode-1",
    steps: [
      {
        id: "step-current",
        kind: "MCP",
        sequence: 1,
        status: "RUNNING",
        dependsOnStepIds: [],
        inputSnapshot: {},
      },
      {
        id: "step-next",
        kind: "COMPUTE",
        sequence: 2,
        status: "READY",
        dependsOnStepIds: ["step-current"],
        inputSnapshot: {},
      },
    ],
    generationRuns: [
      {
        id: "run-current",
        status: "PROCESSING",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        delegationTaskStepId: "step-current",
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-preflight",
            tokenAmount: 1,
          },
        },
      },
      {
        id: "run-queued-other",
        status: "QUEUED",
        conversationId: "conversation-1",
        episodeId: "episode-1",
        inputMessageId: "message-1",
        delegationTaskStepId: "step-next",
        runtimePolicySnapshot: null,
      },
    ],
    externalEffects: [],
  };
}
