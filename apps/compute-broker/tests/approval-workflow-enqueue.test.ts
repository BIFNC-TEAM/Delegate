import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    approvalRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    toolExecution: {
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    workflowRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
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

describe("approval workflow enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.WORKFLOW_APPROVAL_TIMEOUT_MINUTES = "30";
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => {
      return (callback as (client: typeof mockPrisma) => unknown)(mockPrisma);
    });
    mockPrisma.approvalRequest.create.mockResolvedValue({
      id: "approval-1",
      status: "PENDING",
    });
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(null);
    mockPrisma.toolExecution.update.mockResolvedValue({ id: "execution-1" });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.workflowRun.findUnique.mockResolvedValue(null);
    mockPrisma.workflowRun.create.mockResolvedValue({ id: "workflow-1" });
  });

  afterEach(() => {
    delete process.env.WORKFLOW_ENGINE;
    delete process.env.WORKFLOW_TEMPORAL_ADDRESS;
    delete process.env.WORKFLOW_TEMPORAL_NAMESPACE;
    delete process.env.WORKFLOW_TEMPORAL_TASK_QUEUE;
    delete process.env.WORKFLOW_APPROVAL_TIMEOUT_MINUTES;
  });

  it("writes WorkflowRun and START outbox intent in Temporal mode", async () => {
    process.env.WORKFLOW_ENGINE = "temporal";
    process.env.WORKFLOW_TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.WORKFLOW_TEMPORAL_NAMESPACE = "delegate";
    process.env.WORKFLOW_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";

    const { createApprovalRequestForExecution } =
      await import("../src/approvals");

    await createApprovalRequestForExecution(buildApprovalParams());

    expect(mockPrisma.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approvalRequestId: "approval-1",
        kind: "APPROVAL_EXPIRATION",
        engine: "TEMPORAL",
        status: "QUEUED",
        enginePhase: "DISPATCH_PENDING",
        nextWakeAt: expect.any(Date),
        dedupeKey: "approval_expiration:approval-1",
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:rep-1:approval_expiration:approval-1",
        commandOutbox: {
          create: expect.objectContaining({
            commandType: "START",
            payload: expect.objectContaining({
              source: "approval_expiration_enqueue",
              scheduledAt: expect.any(String),
            }),
          }),
        },
      }),
    });
  });

  it("keeps local_runner enqueue free of Temporal outbox intent", async () => {
    process.env.WORKFLOW_ENGINE = "local_runner";

    const { createApprovalRequestForExecution } = await import("../src/approvals");

    await createApprovalRequestForExecution(buildApprovalParams());

    const workflowData = mockPrisma.workflowRun.create.mock.calls[0]?.[0]?.data;
    expect(workflowData).toEqual(expect.objectContaining({
      engine: "LOCAL_RUNNER",
      status: "QUEUED",
      dedupeKey: "approval_expiration:approval-1",
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

    const { createApprovalRequestForExecution } = await import("../src/approvals");

    await createApprovalRequestForExecution(buildApprovalParams());

    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("reuses a matching approval for the same tool execution without duplicate side effects", async () => {
    const existingApproval = buildExistingApproval();
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(existingApproval);

    const { createApprovalRequestForExecution } = await import("../src/approvals");

    await expect(
      createApprovalRequestForExecution(buildApprovalParams()),
    ).resolves.toBe(existingApproval);

    expect(mockPrisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.toolExecution.update).not.toHaveBeenCalled();
    expect(mockPrisma.eventAudit.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowRun.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("recovers a matching approval after a concurrent toolExecutionId unique-key race", async () => {
    const existingApproval = buildExistingApproval();
    mockPrisma.$transaction.mockRejectedValueOnce({ code: "P2002" });
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(existingApproval);

    const { createApprovalRequestForExecution } = await import("../src/approvals");

    await expect(
      createApprovalRequestForExecution(buildApprovalParams()),
    ).resolves.toBe(existingApproval);

    expect(mockPrisma.approvalRequest.findUnique).toHaveBeenCalledWith({
      where: {
        toolExecutionId: "execution-1",
      },
    });
    expect(mockPrisma.eventAudit.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it.each([
    ["representativeId", "rep-other"],
    ["contactId", "contact-other"],
    ["conversationId", "conversation-other"],
    ["generationRunId", "run-other"],
    ["delegationTaskId", "task-other"],
    ["delegationTaskStepId", "step-other"],
    ["sessionId", "session-other"],
    ["toolExecutionId", "execution-other"],
    ["subagentId", "subagent-other"],
    ["reason", "different_reason"],
    ["requestedActionSummary", "Different action"],
    ["riskSummary", "Different risk"],
    ["requestPayloadHash", "payload-other"],
    ["matchedPolicyRuleId", "rule-other"],
  ] as const)(
    "rejects reuse when %s does not match",
    async (field, value) => {
      mockPrisma.approvalRequest.findUnique.mockResolvedValue({
        ...buildExistingApproval(),
        [field]: value,
      });

      const { createApprovalRequestForExecution } =
        await import("../src/approvals");
      const error = await createApprovalRequestForExecution(
        buildApprovalParams(),
      ).catch((caught) => caught);

      expect(error).toMatchObject({
        statusCode: 409,
        message: "approval_request_execution_context_mismatch",
      });
      expect(mockPrisma.approvalRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.eventAudit.create).not.toHaveBeenCalled();
      expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched approval recovered from a P2002 race", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce({ code: "P2002" });
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      ...buildExistingApproval(),
      requestPayloadHash: "payload-other",
    });

    const { createApprovalRequestForExecution } =
      await import("../src/approvals");
    const error = await createApprovalRequestForExecution(
      buildApprovalParams(),
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      statusCode: 409,
      message: "approval_request_execution_context_mismatch",
    });
    expect(mockPrisma.eventAudit.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated P2002 when no approval exists for the execution", async () => {
    const uniqueError = { code: "P2002", meta: { target: ["dedupeKey"] } };
    mockPrisma.$transaction.mockRejectedValueOnce(uniqueError);
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(null);

    const { createApprovalRequestForExecution } =
      await import("../src/approvals");

    await expect(
      createApprovalRequestForExecution(buildApprovalParams()),
    ).rejects.toBe(uniqueError);
  });
});

function buildApprovalParams() {
  return {
    representativeId: "rep-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    generationRunId: "run-1",
    delegationTaskId: "task-1",
    delegationTaskStepId: "step-1",
    sessionId: "session-1",
    executionId: "execution-1",
    subagentId: "subagent-1",
    reason: "policy_requires_approval",
    requestedActionSummary: "Run a sensitive command",
    riskSummary: "Touches a protected resource",
    requestPayloadHash: "payload-1",
    matchedPolicyRuleId: "rule-1",
  };
}

function buildExistingApproval() {
  return {
    id: "approval-existing",
    status: "PENDING",
    representativeId: "rep-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    generationRunId: "run-1",
    delegationTaskId: "task-1",
    delegationTaskStepId: "step-1",
    sessionId: "session-1",
    toolExecutionId: "execution-1",
    subagentId: "subagent-1",
    reason: "policy_requires_approval",
    requestedActionSummary: "Run a sensitive command",
    riskSummary: "Touches a protected resource",
    requestPayloadHash: "payload-1",
    matchedPolicyRuleId: "rule-1",
  };
}
