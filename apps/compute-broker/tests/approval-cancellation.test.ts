import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockFinalizeComputeApprovalConversation,
  mockMarkDelegationTaskRunningAfterApproval,
  mockValidateDelegationApprovedExecution,
} = vi.hoisted(() => {
  const prismaMock = {
    approvalRequest: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    contact: {
      update: vi.fn(),
    },
    computeSession: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    toolExecution: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowCommandOutbox: {
      create: vi.fn(),
    },
    workflowRun: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };

  prismaMock.$transaction.mockImplementation(async (value: unknown) => {
    if (typeof value === "function") {
      return (value as (client: typeof prismaMock) => unknown)(prismaMock);
    }
    if (Array.isArray(value)) {
      return Promise.all(value);
    }
    return value;
  });

  return {
    mockPrisma: prismaMock,
    mockFinalizeComputeApprovalConversation: vi.fn(),
    mockMarkDelegationTaskRunningAfterApproval: vi.fn(),
    mockValidateDelegationApprovedExecution: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: mockFinalizeComputeApprovalConversation,
  markDelegationTaskRunningAfterApprovalInTransaction:
    mockMarkDelegationTaskRunningAfterApproval,
  validateDelegationApprovedExecutionInTransaction:
    mockValidateDelegationApprovedExecution,
}));

vi.mock("../src/lifecycle-hooks", () => ({
  computeLifecycleHooks: {
    emit: vi.fn(),
  },
}));

describe("approval workflow cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
    mockPrisma.$transaction.mockImplementation(async (value: unknown) => {
      if (typeof value === "function") {
        return (value as (client: typeof mockPrisma) => unknown)(mockPrisma);
      }
      if (Array.isArray(value)) {
        return Promise.all(value);
      }
      return value;
    });
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(buildApproval("PENDING"));
    mockPrisma.approvalRequest.findUniqueOrThrow.mockResolvedValue(buildApproval("REJECTED"));
    mockPrisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.approvalRequest.update.mockImplementation(async ({ data }: { data: { status: string; resolvedAt: Date; resolvedBy: string } }) => ({
      ...buildApproval(data.status),
      resolvedAt: data.resolvedAt,
      resolvedBy: data.resolvedBy,
    }));
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.computeSession.update.mockResolvedValue({ id: "session-1" });
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.toolExecution.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockMarkDelegationTaskRunningAfterApproval.mockResolvedValue({
      transitioned: true,
    });
    mockValidateDelegationApprovedExecution.mockResolvedValue({ ready: true });
    mockPrisma.workflowRun.findMany.mockResolvedValue([
      {
        id: "workflow-temporal-1",
        engine: "TEMPORAL",
        externalWorkflowId: "delegate:rep-1:approval_expiration:approval-1",
      },
    ]);
    mockPrisma.workflowRun.update.mockResolvedValue({ id: "workflow-temporal-1" });
    mockPrisma.workflowCommandOutbox.create.mockResolvedValue({ id: "cmd-cancel-1" });
  });

  it("queues a CANCEL command when a pending approval is rejected", async () => {
    const { resolveApproval } = await import("../src/executions");

    await resolveApproval("approval-1", {
      resolution: "rejected",
      resolvedBy: "owner-dashboard",
    });

    expect(mockPrisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-temporal-1" },
      data: expect.objectContaining({
        status: "CANCELED",
        enginePhase: "CANCEL_REQUESTED",
        nextWakeAt: null,
        cancelRequestedAt: expect.any(Date),
        output: {
          outcome: "canceled_after_manual_rejection",
        },
      }),
    });
    expect(mockPrisma.workflowCommandOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowRunId: "workflow-temporal-1",
        commandType: "CANCEL",
        payload: expect.objectContaining({
          source: "canceled_after_manual_rejection",
          requestedAt: expect.any(String),
        }),
      }),
    });
  });

  it("rejects workspace skill decisions at the compute approval boundary", async () => {
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildApproval("PENDING"),
      workspaceSkillReleaseId: "release-1",
    });
    const { resolveApproval } = await import("../src/executions");

    await expect(resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    })).rejects.toMatchObject({
      message: "approval_request_domain_mismatch",
      statusCode: 409,
    });
    expect(mockPrisma.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an orphaned workspace skill decision at the compute approval boundary", async () => {
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildApproval("PENDING"),
      reason: "skill_version_update_review",
      workspaceSkillReleaseId: null,
    });
    const { resolveApproval } = await import("../src/executions");

    await expect(resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    })).rejects.toMatchObject({
      message: "approval_request_domain_mismatch",
      statusCode: 409,
    });
    expect(mockPrisma.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it("queues a CANCEL command when a pending approval is approved", async () => {
    mockPrisma.approvalRequest.findUniqueOrThrow.mockResolvedValue(buildApproval("APPROVED"));
    const { resolveApproval } = await import("../src/executions");

    await resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    });

    expect(mockPrisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-temporal-1" },
      data: expect.objectContaining({
        status: "CANCELED",
        enginePhase: "CANCEL_REQUESTED",
        output: {
          outcome: "canceled_after_manual_approval",
        },
      }),
    });
    expect(mockPrisma.workflowCommandOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowRunId: "workflow-temporal-1",
        commandType: "CANCEL",
        payload: expect.objectContaining({
          source: "canceled_after_manual_approval",
        }),
      }),
    });
  });

  it("atomically resumes a delegated task before queueing its approved execution", async () => {
    const pendingApproval = {
      ...buildApproval("PENDING"),
      conversationId: "conversation-1",
      generationRunId: "run-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      toolExecutionId: "execution-1",
    };
    const approvedApproval = {
      ...pendingApproval,
      status: "APPROVED",
    };
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(pendingApproval);
    mockPrisma.approvalRequest.findUniqueOrThrow.mockResolvedValue(
      approvedApproval,
    );
    mockPrisma.toolExecution.findUnique.mockResolvedValue(
      buildBlockedExecution(),
    );
    const { resolveApproval } = await import("../src/executions");

    await resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-1",
    });

    expect(
      mockMarkDelegationTaskRunningAfterApproval,
    ).toHaveBeenCalledWith(
      mockPrisma,
      {
        taskId: "task-1",
        stepId: "step-1",
        generationRunId: "run-1",
        originConversationId: "conversation-1",
        approvalId: "approval-1",
        actorId: "owner-1",
      },
    );
    expect(mockPrisma.toolExecution.updateMany).toHaveBeenCalledWith({
      where: { id: "execution-1", status: "BLOCKED" },
      data: expect.objectContaining({
        status: "QUEUED",
        startedAt: null,
        finishedAt: null,
        executionLeaseToken: null,
      }),
    });
    expect(
      mockPrisma.approvalRequest.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockMarkDelegationTaskRunningAfterApproval.mock.invocationCallOrder[0]!,
    );
    expect(
      mockMarkDelegationTaskRunningAfterApproval.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockPrisma.toolExecution.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("does not extend the compute session beyond its creation-time expiry", async () => {
    const existingExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildApproval("PENDING"),
      sessionId: "session-1",
      session: { expiresAt: existingExpiresAt },
      representative: { computeMaxSessionMinutes: 60 },
    });
    mockPrisma.approvalRequest.findUniqueOrThrow.mockResolvedValue(buildApproval("APPROVED"));
    const { resolveApproval } = await import("../src/executions");

    await resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    });

    expect(mockPrisma.computeSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: expect.objectContaining({
        lastHeartbeatAt: expect.any(Date),
        failureReason: null,
      }),
    });
    expect(
      mockPrisma.computeSession.update.mock.calls.at(-1)?.[0].data,
    ).not.toHaveProperty("expiresAt");
    const expiryUpdate =
      mockPrisma.computeSession.updateMany.mock.calls.at(-1)![0];
    expect(expiryUpdate.where).toEqual({
      id: "session-1",
      expiresAt: { gt: expiryUpdate.data.expiresAt },
    });
    expect(expiryUpdate.data.expiresAt.getTime()).toBeGreaterThan(
      existingExpiresAt.getTime(),
    );
  });

  it("allows current policy to shorten, but not lengthen, the stored expiry", async () => {
    const existingExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildApproval("PENDING"),
      sessionId: "session-1",
      session: { expiresAt: existingExpiresAt },
      representative: { computeMaxSessionMinutes: 5 },
    });
    mockPrisma.approvalRequest.findUniqueOrThrow.mockResolvedValue(buildApproval("APPROVED"));
    const { resolveApproval } = await import("../src/executions");

    await resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    });

    const heartbeatUpdate =
      mockPrisma.computeSession.update.mock.calls.at(-1)![0].data;
    const expiryUpdate =
      mockPrisma.computeSession.updateMany.mock.calls.at(-1)![0];
    expect(expiryUpdate.where).toEqual({
      id: "session-1",
      expiresAt: { gt: expiryUpdate.data.expiresAt },
    });
    expect(expiryUpdate.data.expiresAt.getTime()).toBe(
      heartbeatUpdate.lastHeartbeatAt.getTime() + 5 * 60 * 1000,
    );
  });

  it("fails closed when a legacy session has no stored expiry ceiling", async () => {
    const { resolveApprovalSessionExpiryCeiling } = await import(
      "../src/executions"
    );

    expect(() =>
      resolveApprovalSessionExpiryCeiling({
        existingExpiresAt: null,
        resolvedAt: new Date("2026-07-23T12:00:00.000Z"),
        currentMaxSessionMinutes: 15,
      }),
    ).toThrow("compute_session_expiry_missing");
  });

  it("expires an overdue approval instead of accepting a late decision", async () => {
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildApproval("PENDING"),
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const { resolveApproval } = await import("../src/executions");

    await expect(resolveApproval("approval-1", {
      resolution: "approved",
      resolvedBy: "owner-dashboard",
    })).rejects.toThrow("approval_request_expired");

    expect(mockPrisma.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "approval-1",
        status: "PENDING",
        expiresAt: { lte: expect.any(Date) },
      },
      data: {
        status: "EXPIRED",
        resolvedAt: expect.any(Date),
        resolvedBy: "compute-broker",
      },
    });
    expect(mockPrisma.toolExecution.updateMany).toHaveBeenCalledWith({
      where: { approvalRequestId: "approval-1", status: "BLOCKED" },
      data: { status: "CANCELED", finishedAt: expect.any(Date) },
    });
    expect(mockFinalizeComputeApprovalConversation).toHaveBeenCalledWith({
      approvalId: "approval-1",
      outcome: "expired",
    });
  });
});

function buildApproval(status: string) {
  return {
    id: "approval-1",
    representativeId: "rep-1",
    contactId: null,
    conversationId: null,
    generationRunId: null,
    delegationTaskId: null,
    delegationTaskStepId: null,
    sessionId: null,
    toolExecutionId: null,
    subagentId: "compute-agent",
    workspaceSkillReleaseId: null,
    status,
    reason: "policy_requires_approval",
    requestedActionSummary: "Run command",
    riskSummary: "Sensitive operation",
    requestedAt: new Date("2026-04-05T12:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
  };
}

function buildBlockedExecution() {
  return {
    id: "execution-1",
    sessionId: "session-1",
    mcpBindingId: null,
    capability: "WRITE",
    subagentId: "compute-agent",
    delegationTaskId: "task-1",
    delegationTaskStepId: "step-1",
    status: "BLOCKED",
    requestedCommand: "report",
    requestedPath: "outputs/report.txt",
    requestPayload: "{}",
    workingDirectory: "/workspace",
    policyDecision: "ASK",
    approvalRequestId: "approval-1",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    cpuMs: null,
    wallMs: null,
    bytesRead: null,
    bytesWritten: null,
    createdAt: new Date("2026-07-24T08:00:00.000Z"),
  };
}
