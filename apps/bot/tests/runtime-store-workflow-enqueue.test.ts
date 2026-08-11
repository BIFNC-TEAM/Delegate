import { HandoffStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    contact: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    handoffRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    handoffEntitlementGrant: {
      findMany: vi.fn(),
    },
    intakeSubmission: {
      create: vi.fn(),
    },
    representative: {
      findUnique: vi.fn(),
    },
    workflowRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
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

describe("handoff workflow enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => {
      return (callback as (client: typeof mockPrisma) => unknown)(mockPrisma);
    });
    mockPrisma.handoffRequest.findFirst.mockResolvedValue(null);
    mockPrisma.handoffEntitlementGrant.findMany.mockResolvedValue([]);
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.contact.findUnique.mockResolvedValue({
      representativeId: "rep-1",
      audienceIdentityId: "audience-1",
    });
    mockPrisma.intakeSubmission.create.mockResolvedValue({ id: "intake-1" });
    mockPrisma.handoffRequest.create.mockResolvedValue({
      id: "handoff-1",
      status: HandoffStatus.OPEN,
      recommendedPriority: 80,
    });
    mockPrisma.handoffRequest.update.mockResolvedValue({
      id: "handoff-1",
      status: HandoffStatus.OPEN,
      recommendedPriority: 80,
    });
    mockPrisma.contact.update.mockResolvedValue({ id: "contact-1" });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.workflowRun.findUnique.mockResolvedValue(null);
    mockPrisma.representative.findUnique.mockResolvedValue({
      humanInLoop: true,
      handoffAccessMode: "FREE",
      handoffWindowHours: 24,
    });
    mockPrisma.workflowRun.create.mockResolvedValue({ id: "workflow-1" });
  });

  afterEach(() => {
    delete process.env.WORKFLOW_ENGINE;
    delete process.env.WORKFLOW_TEMPORAL_ADDRESS;
    delete process.env.WORKFLOW_TEMPORAL_NAMESPACE;
    delete process.env.WORKFLOW_TEMPORAL_TASK_QUEUE;
  });

  it("writes WorkflowRun and START outbox intent in Temporal mode", async () => {
    process.env.WORKFLOW_ENGINE = "temporal";
    process.env.WORKFLOW_TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.WORKFLOW_TEMPORAL_NAMESPACE = "delegate";
    process.env.WORKFLOW_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";

    const { maybeCreateHandoffRequest } = await import("../src/runtime-store");

    await maybeCreateHandoffRequest({
      context: buildConversationContext(),
      plan: buildHandoffPlan(),
      text: "Please have the owner follow up.",
      prepared: {
        priority: 80,
        summary: "Owner follow-up requested.",
        ownerAction: "Review and reply.",
      },
    });

    expect(mockPrisma.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handoffRequestId: "handoff-1",
        kind: "HANDOFF_FOLLOW_UP",
        engine: "TEMPORAL",
        status: "QUEUED",
        enginePhase: "DISPATCH_PENDING",
        nextWakeAt: expect.any(Date),
        dedupeKey: "handoff_follow_up:handoff-1",
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:lin-founder-rep:handoff_follow_up:handoff-1",
        commandOutbox: {
          create: expect.objectContaining({
            commandType: "START",
            payload: expect.objectContaining({
              source: "handoff_follow_up_enqueue",
              scheduledAt: expect.any(String),
            }),
          }),
        },
      }),
    });
  }, 15_000);

  it("keeps local_runner enqueue free of Temporal outbox intent", async () => {
    process.env.WORKFLOW_ENGINE = "local_runner";

    const { maybeCreateHandoffRequest } = await import("../src/runtime-store");

    await maybeCreateHandoffRequest({
      context: buildConversationContext(),
      plan: buildHandoffPlan(),
      text: "Please have the owner follow up.",
      prepared: {
        priority: 80,
        summary: "Owner follow-up requested.",
        ownerAction: "Review and reply.",
      },
    });

    const workflowData = mockPrisma.workflowRun.create.mock.calls[0]?.[0]?.data;
    expect(workflowData).toEqual(expect.objectContaining({
      engine: "LOCAL_RUNNER",
      status: "QUEUED",
      dedupeKey: "handoff_follow_up:handoff-1",
    }));
    expect(workflowData).not.toHaveProperty("commandOutbox");
    expect(workflowData).not.toHaveProperty("enginePhase");
  });

  it("does not create duplicate workflow rows when the dedupe key already exists", async () => {
    process.env.WORKFLOW_ENGINE = "temporal";
    process.env.WORKFLOW_TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.WORKFLOW_TEMPORAL_NAMESPACE = "delegate";
    process.env.WORKFLOW_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";
    mockPrisma.workflowRun.findUnique.mockResolvedValue({ id: "workflow-existing" });

    const { maybeCreateHandoffRequest } = await import("../src/runtime-store");

    await maybeCreateHandoffRequest({
      context: buildConversationContext(),
      plan: buildHandoffPlan(),
      text: "Please have the owner follow up.",
      prepared: {
        priority: 80,
        summary: "Owner follow-up requested.",
        ownerAction: "Review and reply.",
      },
    });

    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("does not create a placeholder handoff when package access is missing", async () => {
    mockPrisma.representative.findUnique.mockResolvedValue({
      humanInLoop: true,
      handoffAccessMode: "PACKAGE_REQUIRED",
      handoffWindowHours: 24,
    });
    const { maybeCreateHandoffRequest } = await import("../src/runtime-store");

    const result = await maybeCreateHandoffRequest({
      context: buildConversationContext(),
      plan: buildHandoffPlan(),
      text: "Please have the owner follow up.",
    });

    expect(result).toBeNull();
    expect(mockPrisma.handoffRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.intakeSubmission.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });
});

function buildConversationContext() {
  return {
    representativeId: "rep-1",
    representativeSlug: "lin-founder-rep",
    audienceIdentityId: "audience-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
  } as never;
}

function buildHandoffPlan() {
  return {
    intent: "partnership",
    nextStep: "handoff",
    audienceRole: "PARTNER",
    suggestedPlan: "pass",
    reasons: ["Owner review is appropriate."],
  } as never;
}
