import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockFinalizeComputeApprovalConversation } = vi.hoisted(() => {
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
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: mockFinalizeComputeApprovalConversation,
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
    mockPrisma.toolExecution.updateMany.mockResolvedValue({ count: 1 });
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
    sessionId: null,
    toolExecutionId: null,
    subagentId: "compute-agent",
    status,
    reason: "policy_requires_approval",
    requestedActionSummary: "Run command",
    riskSummary: "Sensitive operation",
    requestedAt: new Date("2026-04-05T12:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
  };
}
