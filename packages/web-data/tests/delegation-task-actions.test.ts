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
    delegationTaskExternalEffect: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    delegationTaskInput: { findFirst: vi.fn(), create: vi.fn() },
    delegationTaskOutput: { count: vi.fn(), create: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    delegationTaskStep: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    delegationTaskResourcePolicy: { update: vi.fn() },
    generationRun: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    message: { update: vi.fn(), upsert: vi.fn() },
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
    mockPrisma.delegationTaskOutput.count.mockResolvedValue(0);
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
        { id: "step-1", sequence: 1, status: "RUNNING", dependsOnStepIds: [], inputSnapshot: {} },
        {
          id: "step-2",
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
      }),
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ aggregateId: "run-step-2", eventType: "generation.requested" }),
    });
    expect(mockPrisma.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "READY", nextActionBy: "SYSTEM" }),
    });
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
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({ id: "task-1", status: "COMPLETED" });
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
  });

  it("restores an MCP effect to reconciliation-required when task finalization fails", async () => {
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
    mockPrisma.delegationTaskExternalEffect.findFirst
      .mockResolvedValueOnce(effect)
      .mockResolvedValueOnce({
        id: effect.id,
        status: "SUCCEEDED",
        delegationTask: { status: "WAITING_FOR_OWNER" },
      });
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

    expect(mockPrisma.delegationTaskExternalEffect.update).toHaveBeenLastCalledWith({
      where: { id: effect.id },
      data: {
        status: "RECONCILIATION_REQUIRED",
        failureReason: "reconciliation_finalization_failed",
      },
    });
    expect(mockPrisma.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "external_effect.reconciliation_finalization_failed",
        actorType: "SYSTEM",
      }),
    });
  });

  it("does not record the same clarification message twice when delivery is retried", async () => {
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
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
    mockPrisma.delegationTask.findUnique.mockResolvedValueOnce({
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
    steps: [{ id: "step-1" }],
    approvalRequests: [],
    externalEffects: [],
  };
}
