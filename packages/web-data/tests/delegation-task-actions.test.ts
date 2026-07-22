import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const client = {
    $executeRaw: vi.fn(),
    approvalRequest: {},
    conversation: { update: vi.fn() },
    conversationEpisode: { updateMany: vi.fn() },
    artifact: { findMany: vi.fn(), updateMany: vi.fn() },
    delegationTask: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    delegationTaskEvent: { findFirst: vi.fn(), create: vi.fn() },
    delegationTaskExternalEffect: { findMany: vi.fn(), updateMany: vi.fn() },
    delegationTaskOutput: { create: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    delegationTaskStep: { update: vi.fn(), updateMany: vi.fn() },
    generationRun: { create: vi.fn(), updateMany: vi.fn() },
    message: { upsert: vi.fn() },
    outboxEvent: { create: vi.fn(), updateMany: vi.fn() },
  };
  return {
    mockPrisma: {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

describe("delegation task owner actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma));
    mockPrisma.delegationTaskEvent.findFirst.mockResolvedValue(null);
    mockPrisma.delegationTaskEvent.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.generationRun.create.mockResolvedValue({ id: "run-retry-1" });
    mockPrisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.delegationTaskExternalEffect.findMany.mockResolvedValue([]);
  });

  it("queues a new generation attempt on the same failed task", async () => {
    mockPrisma.delegationTask.findFirst
      .mockResolvedValueOnce(buildTask("FAILED"))
      .mockResolvedValueOnce(null);
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
      }),
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "generation_run",
        aggregateId: "run-retry-1",
        eventType: "generation.requested",
      }),
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
    });
    const { finalizeComputeDelegationTask } = await import("../src/delegation-tasks");

    await finalizeComputeDelegationTask({
      taskId: "task-1",
      outcome: "completed",
      actualCredits: 4,
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
    steps: [{ id: "step-1" }],
    approvalRequests: [],
  };
}
