import { HandoffStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    $transaction: vi.fn(),
    handoffRequest: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    workflowCommandOutbox: {
      create: vi.fn(),
    },
    workflowRun: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };

  prismaMock.$transaction.mockImplementation(async (callback: unknown) => {
    return (callback as (client: typeof prismaMock) => unknown)(prismaMock);
  });

  return {
    mockPrisma: prismaMock,
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("owner dashboard handoff cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/delegate";
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => {
      return (callback as (client: typeof mockPrisma) => unknown)(mockPrisma);
    });
    mockPrisma.handoffRequest.findFirst.mockResolvedValue(buildHandoff(HandoffStatus.OPEN));
    mockPrisma.handoffRequest.update.mockResolvedValue(buildHandoff(HandoffStatus.CLOSED));
    mockPrisma.workflowRun.findMany.mockResolvedValue([
      {
        id: "workflow-handoff-1",
        engine: "TEMPORAL",
        externalWorkflowId: "delegate:lin-founder-rep:handoff_follow_up:handoff-1",
      },
    ]);
    mockPrisma.workflowRun.update.mockResolvedValue({ id: "workflow-handoff-1" });
    mockPrisma.workflowCommandOutbox.create.mockResolvedValue({ id: "cmd-cancel-1" });
  });

  it("queues a CANCEL command when a handoff is closed", async () => {
    const { setHandoffRequestStatus } = await import("../src/owner-dashboard");

    const result = await setHandoffRequestStatus({
      representativeSlug: "lin-founder-rep",
      handoffId: "handoff-1",
      status: "closed",
    });

    expect(result.status).toBe("closed");
    expect(mockPrisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-handoff-1" },
      data: expect.objectContaining({
        status: "CANCELED",
        enginePhase: "CANCEL_REQUESTED",
        nextWakeAt: null,
        cancelRequestedAt: expect.any(Date),
        output: {
          outcome: "canceled_after_handoff_resolution",
        },
      }),
    });
    expect(mockPrisma.workflowCommandOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowRunId: "workflow-handoff-1",
        commandType: "CANCEL",
        payload: expect.objectContaining({
          source: "canceled_after_handoff_resolution",
          requestedAt: expect.any(String),
        }),
      }),
    });
  });
});

function buildHandoff(status: HandoffStatus) {
  return {
    id: "handoff-1",
    summary: "Needs owner follow-up.",
    recommendedPriority: 80,
    recommendedOwnerAction: "Reply to the lead.",
    reason: "partnership",
    status,
    createdAt: new Date("2026-04-05T12:00:00.000Z"),
    contact: {
      displayName: "Acme",
      username: null,
      telegramUserId: "123",
      isPaid: false,
    },
  };
}
