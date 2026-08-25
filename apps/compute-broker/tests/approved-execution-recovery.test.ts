import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    toolExecution: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    computeSession: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/executions", () => ({
  processNextApprovedExecution: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: vi.fn(),
}));

describe("approved execution recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.toolExecution.findMany.mockResolvedValue([]);
    mockPrisma.toolExecution.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 1 });
  });

  it("never immediately requeues a freshly claimed execution", async () => {
    const { recoverInterruptedApprovedExecutions } = await import(
      "../src/approved-execution-loop"
    );

    await recoverInterruptedApprovedExecutions();

    expect(mockPrisma.toolExecution.findMany).toHaveBeenCalledWith({
      where: {
        status: "RUNNING",
        approvalRequestId: { not: null },
        planActionId: null,
        AND: [
          {
            OR: [
              { startedAt: { lt: expect.any(Date) } },
              {
                startedAt: null,
                createdAt: { lt: expect.any(Date) },
              },
            ],
          },
          {
            session: {
              expiresAt: { lte: expect.any(Date) },
            },
          },
        ],
      },
      select: {
        id: true,
        sessionId: true,
        executionLeaseToken: true,
      },
      take: 20,
    });
    expect(mockPrisma.toolExecution.updateMany).not.toHaveBeenCalled();
  });

  it("fences an actually stale execution and marks its result unknown", async () => {
    mockPrisma.toolExecution.findMany.mockResolvedValue([
      {
        id: "execution-1",
        sessionId: "session-1",
        executionLeaseToken: "lease-token-1",
      },
    ]);
    const { recoverInterruptedApprovedExecutions } = await import(
      "../src/approved-execution-loop"
    );

    await recoverInterruptedApprovedExecutions();

    expect(mockPrisma.toolExecution.updateMany).toHaveBeenCalledWith({
      where: {
        id: "execution-1",
        status: "RUNNING",
        executionLeaseToken: "lease-token-1",
      },
      data: {
        status: "FAILED",
        finishedAt: expect.any(Date),
        executionLeaseToken: null,
      },
    });
    expect(mockPrisma.computeSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: {
        status: "IDLE",
        failureReason: "approved_execution_result_unknown",
        lastHeartbeatAt: expect.any(Date),
      },
    });
  });
});
