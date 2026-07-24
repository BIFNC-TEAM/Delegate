import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockEvaluateExecutionRequest,
  mockFinalizeApproval,
  mockValidateDelegatedExecution,
  executionState,
} = vi.hoisted(() => {
  const executionState = buildQueuedExecution();
  const approval = buildApprovedApproval();
  const toolExecution = {
    findMany: vi.fn(),
    findUnique: vi.fn(async () => ({ ...executionState })),
    findUniqueOrThrow: vi.fn(async () => ({ ...executionState })),
    updateMany: vi.fn(async ({ where, data }: {
      where: {
        id?: string;
        status?: string;
        approvalRequestId?: string;
        executionLeaseToken?: string;
      };
      data: Record<string, unknown>;
    }) => {
      if (
        (where.id && where.id !== executionState.id)
        || (where.status && where.status !== executionState.status)
        || (
          where.approvalRequestId
          && where.approvalRequestId !== executionState.approvalRequestId
        )
        || (
          where.executionLeaseToken
          && where.executionLeaseToken !== executionState.executionLeaseToken
        )
      ) {
        return { count: 0 };
      }
      Object.assign(executionState, data);
      return { count: 1 };
    }),
  };
  const client = {
    toolExecution,
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(approval),
    },
    computeSession: {
      update: vi.fn().mockResolvedValue({ id: "session-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    delegationTaskExternalEffect: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    executionState,
    mockEvaluateExecutionRequest: vi.fn(),
    mockFinalizeApproval: vi.fn(),
    mockValidateDelegatedExecution: vi.fn(),
    mockPrisma: {
      ...client,
      $transaction: vi.fn(
        async (callback: (tx: typeof client) => unknown) => callback(client),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/policy", () => ({
  evaluateExecutionRequest: mockEvaluateExecutionRequest,
  loadSessionPolicyContext: vi.fn(),
}));

vi.mock("../src/lifecycle-hooks", () => ({
  computeLifecycleHooks: {
    emit: vi.fn(),
  },
}));

vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: mockFinalizeApproval,
  markDelegationTaskRunningAfterApprovalInTransaction: vi.fn(),
  validateDelegationApprovedExecutionInTransaction:
    mockValidateDelegatedExecution,
}));

describe("approved execution claim fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(executionState, buildQueuedExecution());
    mockPrisma.toolExecution.findMany.mockResolvedValue([
      { ...executionState },
    ]);
    mockPrisma.approvalRequest.findUnique.mockResolvedValue(
      buildApprovedApproval(),
    );
    mockValidateDelegatedExecution.mockResolvedValue({ ready: true });
    mockEvaluateExecutionRequest.mockResolvedValue(
      buildEvaluatedRequest("deny"),
    );
    mockPrisma.computeSession.update.mockResolvedValue({ id: "session-1" });
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.delegationTaskExternalEffect.updateMany.mockResolvedValue({
      count: 1,
    });
  });

  it("claims RUNNING, startedAt, and a lease token in one CAS", async () => {
    const { processNextApprovedExecution } = await import("../src/executions");

    await expect(processNextApprovedExecution()).resolves.toBe(true);

    const claimCall = mockPrisma.toolExecution.updateMany.mock.calls[0]![0];
    const executionLeaseToken = claimCall.data.executionLeaseToken;
    expect(claimCall).toEqual({
      where: {
        id: "execution-1",
        status: "QUEUED",
        approvalRequestId: "approval-1",
      },
      data: {
        status: "RUNNING",
        startedAt: expect.any(Date),
        finishedAt: null,
        executionLeaseToken: expect.any(String),
      },
    });
    expect(executionLeaseToken).toHaveLength(48);
    expect(mockPrisma.toolExecution.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "execution-1",
        status: "RUNNING",
        executionLeaseToken,
      },
      data: {
        status: "CANCELED",
        finishedAt: expect.any(Date),
        policyDecision: "DENY",
        executionLeaseToken: null,
      },
    });
    expect(mockFinalizeApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      outcome: "policy_denied",
      failureReason: "policy_revoked",
    });
  });

  it("revalidates the delegated state immediately before execution", async () => {
    mockEvaluateExecutionRequest.mockResolvedValue(
      buildEvaluatedRequest("allow"),
    );
    mockValidateDelegatedExecution
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({
        ready: false,
        reason: "delegation_conversation_human_controlled",
      });
    const { processNextApprovedExecution } = await import("../src/executions");

    await expect(processNextApprovedExecution()).resolves.toBe(true);

    expect(mockValidateDelegatedExecution).toHaveBeenCalledTimes(2);
    const executionLeaseToken =
      mockPrisma.toolExecution.updateMany.mock.calls[0]![0].data
        .executionLeaseToken;
    expect(mockPrisma.toolExecution.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "execution-1",
        status: "RUNNING",
        executionLeaseToken,
      },
      data: {
        status: "FAILED",
        finishedAt: expect.any(Date),
        executionLeaseToken: null,
      },
    });
    expect(mockFinalizeApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      outcome: "failed",
      failureReason: "delegation_conversation_human_controlled",
    });
  });
});

function buildQueuedExecution() {
  return {
    id: "execution-1",
    sessionId: "session-1",
    mcpBindingId: null,
    capability: "WRITE",
    subagentId: "compute-agent",
    delegationTaskId: "task-1",
    delegationTaskStepId: "step-1",
    generationOutboxId: "outbox-1",
    generationLeaseAttempt: 1,
    requestPayloadHash: "request-hash",
    responseSnapshot: null,
    executionLeaseToken: null as string | null,
    billingFinalizedAt: null,
    billingSnapshot: null,
    status: "QUEUED",
    requestedCommand: "report body",
    requestedPath: "outputs/report.txt",
    requestPayload: null,
    workingDirectory: "/workspace",
    policyDecision: "ASK",
    approvalRequestId: "approval-1",
    startedAt: null as Date | null,
    finishedAt: null as Date | null,
    exitCode: null,
    cpuMs: null,
    wallMs: null,
    bytesRead: null,
    bytesWritten: null,
    createdAt: new Date("2026-07-24T08:00:00.000Z"),
  };
}

function buildApprovedApproval() {
  return {
    id: "approval-1",
    representativeId: "representative-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    generationRunId: "run-1",
    delegationTaskId: "task-1",
    delegationTaskStepId: "step-1",
    sessionId: "session-1",
    toolExecutionId: "execution-1",
    subagentId: "compute-agent",
    workspaceSkillReleaseId: null,
    status: "APPROVED",
    reason: "human_approval_required",
    requestedActionSummary: "write report",
    riskSummary: "owner review required",
    requestPayloadHash: null,
    matchedPolicyRuleId: null,
    requestedAt: new Date("2026-07-24T08:00:00.000Z"),
    expiresAt: new Date("2026-07-24T09:00:00.000Z"),
    resolvedAt: new Date("2026-07-24T08:05:00.000Z"),
    resolvedBy: "owner-1",
    decisionNote: null,
  };
}

function buildEvaluatedRequest(decision: "allow" | "deny") {
  return {
    input: {
      capability: "write",
      subagentId: "compute-agent",
      path: "outputs/report.txt",
      content: "report body",
      workingDirectory: "/workspace",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    },
    mcpBinding: null,
    decision: {
      decision,
      reason: decision === "deny" ? "policy_revoked" : "approved",
    },
    context: {
      session: {
        representative: {
          owner: {
            wallet: {
              balanceCredits: 100,
              sponsorPoolCredit: 0,
            },
          },
        },
        conversation: {
          computeBudgetRemainingCredits: 100,
        },
      },
      profile: {
        networkMode: "no_network",
        filesystemMode: "workspace_only",
        networkAllowlist: [],
      },
      runtimeAuthority: {
        compute: {
          autoApproveBudgetCents: 100,
        },
      },
    },
  };
}
