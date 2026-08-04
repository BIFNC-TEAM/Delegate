import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRepresentativeOpenVikingOverviewMetrics, mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    $transaction: vi.fn(),
    conversation: {
      count: vi.fn(),
    },
    handoffRequest: {
      count: vi.fn(),
    },
    invoice: {
      count: vi.fn(),
    },
    representative: {
      findUnique: vi.fn(),
    },
    workflowRun: {
      count: vi.fn(),
    },
  };

  prismaMock.$transaction.mockImplementation(async (values: unknown) => {
    if (Array.isArray(values)) {
      return Promise.all(values);
    }
    return values;
  });

  return {
    mockGetRepresentativeOpenVikingOverviewMetrics: vi.fn(),
    mockPrisma: prismaMock,
  };
});

vi.mock("../src/openviking", () => ({
  getRepresentativeOpenVikingOverviewMetrics:
    mockGetRepresentativeOpenVikingOverviewMetrics,
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("owner dashboard workflow observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/delegate";
    mockPrisma.$transaction.mockImplementation(async (values: unknown) => {
      if (Array.isArray(values)) {
        return Promise.all(values);
      }
      return values;
    });
    mockPrisma.representative.findUnique.mockResolvedValue({
      id: "rep-1",
      slug: "lin-founder-rep",
      displayName: "Lin Founder Rep",
      roleSummary: "Answers and routes work.",
      owner: {
        wallet: {
          starsBalance: 120,
          sponsorPoolCredit: 40,
          balanceCredits: 20,
        },
      },
      handoffRequests: [],
      invoices: [],
      workflowRuns: [
        {
          id: "workflow-1",
          kind: "HANDOFF_FOLLOW_UP",
          engine: "TEMPORAL",
          status: "RUNNING",
          enginePhase: "WAITING_TIMER",
          scheduledAt: new Date("2026-04-05T12:00:00.000Z"),
          nextWakeAt: new Date("2026-04-05T12:00:00.000Z"),
          externalWorkflowId: "delegate:lin-founder-rep:handoff_follow_up:handoff-1",
          externalRunId: "temporal-run-1",
          cancelRequestedAt: null,
          completedAt: null,
          lastError: null,
          output: null,
        },
      ],
    });
    mockPrisma.conversation.count.mockResolvedValue(0);
    mockPrisma.handoffRequest.count.mockResolvedValue(0);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.workflowRun.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    mockGetRepresentativeOpenVikingOverviewMetrics.mockResolvedValue(null);
  });

  it("serializes phase-aware workflow metrics and recent workflow fields", async () => {
    const { getDashboardOverviewSnapshot } = await import("../src/owner-dashboard");

    const snapshot = await getDashboardOverviewSnapshot("lin-founder-rep", "en");

    expect(snapshot?.workflowMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pending workflows", value: "2" }),
        expect.objectContaining({ label: "Dispatch pending", value: "1" }),
        expect.objectContaining({ label: "Waiting on timer", value: "1" }),
        expect.objectContaining({ label: "Cancel requested", value: "0" }),
        expect.objectContaining({ label: "Failed workflows", value: "1" }),
      ]),
    );
    expect(mockPrisma.workflowRun.count).toHaveBeenNthCalledWith(1, {
      where: {
        representativeId: "rep-1",
        status: {
          in: ["QUEUED", "RUNNING"],
        },
      },
    });
    expect(mockPrisma.workflowRun.count).toHaveBeenNthCalledWith(2, {
      where: {
        representativeId: "rep-1",
        enginePhase: "DISPATCH_PENDING",
      },
    });
    expect(snapshot?.recentWorkflows[0]).toMatchObject({
      id: "workflow-1",
      engine: "temporal",
      status: "running",
      enginePhase: "waiting_timer",
      scheduledAt: "2026-04-05T12:00:00.000Z",
      nextWakeAt: "2026-04-05T12:00:00.000Z",
      externalWorkflowId: "delegate:lin-founder-rep:handoff_follow_up:handoff-1",
      externalRunId: "temporal-run-1",
    });
  });
});
