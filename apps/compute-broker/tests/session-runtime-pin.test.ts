import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadComputeRuntimeAuthority,
  mockPrisma,
  mockRequireAudienceGenerationRunAuthorization,
} = vi.hoisted(() => ({
  mockLoadComputeRuntimeAuthority: vi.fn(),
  mockRequireAudienceGenerationRunAuthorization: vi.fn(),
  mockPrisma: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    representative: { findUnique: vi.fn() },
    delegationTask: { findUnique: vi.fn() },
    computeSession: { create: vi.fn(), updateMany: vi.fn() },
    toolExecution: { findUnique: vi.fn(), update: vi.fn() },
    approvalRequest: { findUnique: vi.fn(), update: vi.fn() },
    eventAudit: { create: vi.fn() },
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/runtime-authority", () => ({
  loadComputeRuntimeAuthority: mockLoadComputeRuntimeAuthority,
}));

vi.mock("../src/entitlements", () => ({
  requireAudienceGenerationRunAuthorization:
    mockRequireAudienceGenerationRunAuthorization,
}));

vi.mock("../src/lifecycle-hooks", () => ({
  computeLifecycleHooks: { emit: vi.fn() },
}));

process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";

describe("compute session runtime pin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T10:00:00.000Z"));
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma),
    );
    mockPrisma.representative.findUnique.mockResolvedValue({
      id: "rep-1",
      slug: "rep-one",
      activeVersionId: "version-active-at-creation",
      computeEnabled: true,
      capabilityProfiles: [{
        id: "profile-1",
        networkMode: "NO_NETWORK",
        filesystemMode: "WORKSPACE_ONLY",
      }],
    });
    mockLoadComputeRuntimeAuthority.mockResolvedValue({
      representativeVersionId: "version-active-at-creation",
      compute: {
        enabled: true,
        defaultPolicyMode: "ask",
        baseImage: "pinned-image:1",
        maxSessionMinutes: 5,
        autoApproveTokenLimit: 0,
        artifactRetentionDays: 7,
        networkMode: "no_network",
        networkAllowlist: [],
        filesystemMode: "workspace_only",
        capabilityModes: {
          exec: "allow",
          read: "allow",
          write: "ask",
          process: "ask",
          browser: "deny",
          mcp: "deny",
        },
      },
      delegation: {
        enabled: false,
        naturalLanguageEnabled: false,
        explicitComputeEnabled: false,
        maxSteps: 1,
        maxEstimatedTokens: 0,
        knowledgeScope: "user_input_only",
      },
      mcpBindings: [],
    });
    mockPrisma.computeSession.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "session-1",
        ...data,
        sandboxLeaseId: null,
        leaseStatus: "REQUESTED",
        runnerLeaseId: null,
        containerId: null,
        leaseAcquiredAt: null,
        leaseLastUsedAt: null,
        leaseReleasedAt: null,
        startedAt: null,
        lastHeartbeatAt: null,
        endedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockRequireAudienceGenerationRunAuthorization.mockImplementation(
      async (input: { requestedBy: string; generationRunId?: string }) => {
        if (input.requestedBy === "audience" && !input.generationRunId) {
          throw new Error("audience_generation_run_required");
        }
        return null;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists the evaluated version and its absolute duration ceiling", async () => {
    const { createComputeSession } = await import("../src/sessions");

    const result = await createComputeSession({
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      subagentId: "compute-agent",
      requestedBy: "audience",
      requestedCapabilities: ["exec"],
      reason: "run a published workflow",
    });

    expect(mockLoadComputeRuntimeAuthority).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "rep-one",
      activeVersionId: "version-active-at-creation",
      requestedBy: "audience",
      contactId: "contact-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
    });
    expect(mockPrisma.computeSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeVersionId: "version-active-at-creation",
        baseImage: "pinned-image:1",
        expiresAt: new Date("2026-07-23T10:05:00.000Z"),
      }),
    });
    expect(result.session.representativeVersionId).toBe(
      "version-active-at-creation",
    );
    expect(result.session.expiresAt).toBe("2026-07-23T10:05:00.000Z");
  }, 15_000);

  it("creates a fresh V3 execution session after approval instead of reviving the old one", async () => {
    const oldSession = {
      id: "session-old",
      representativeId: "rep-1",
      representativeVersionId: "version-active-at-creation",
      contactId: "contact-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      subagentId: "compute-agent",
      requestedBy: "AUDIENCE",
    };
    mockPrisma.toolExecution.findUnique
      .mockResolvedValueOnce({
        id: "execution-1",
        capability: "WRITE",
        status: "RUNNING",
        executionLeaseToken: "lease-1",
        approvalRequestId: "approval-1",
        session: oldSession,
        planAction: {
          turnPlan: {
            id: "plan-1",
            revision: 2,
            executionEpoch: 4,
            activeExecutionFence: {
              activePlanId: "plan-1",
              activeRevision: 2,
              executionEpoch: 4,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        id: "execution-1",
        status: "RUNNING",
        executionLeaseToken: "lease-1",
        approvalRequestId: "approval-1",
        planAction: {
          turnPlan: {
            id: "plan-1",
            revision: 2,
            executionEpoch: 4,
            activeExecutionFence: {
              activePlanId: "plan-1",
              activeRevision: 2,
              executionEpoch: 4,
            },
          },
        },
      });
    mockPrisma.approvalRequest.findUnique.mockResolvedValue({
      id: "approval-1",
      status: "APPROVED",
      toolExecutionId: "execution-1",
    });
    mockPrisma.toolExecution.update.mockResolvedValue({
      id: "execution-1",
      sessionId: "session-1",
    });
    mockPrisma.approvalRequest.update.mockResolvedValue({});
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 1 });
    const { replaceApprovedV3ExecutionSession } = await import("../src/sessions");

    await replaceApprovedV3ExecutionSession({
      executionId: "execution-1",
      approvalId: "approval-1",
      executionLeaseToken: "lease-1",
    });

    expect(mockPrisma.computeSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: "run-1",
        delegationTaskId: "task-1",
        expiresAt: new Date("2026-07-23T10:05:00.000Z"),
      }),
    });
    expect(mockPrisma.toolExecution.update).toHaveBeenCalledWith({
      where: { id: "execution-1" },
      data: { sessionId: "session-1" },
    });
    expect(mockPrisma.computeSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-old", endedAt: null },
      data: expect.objectContaining({
        status: "EXPIRED",
        failureReason: "superseded_by_post_approval_execution_lease",
      }),
    });
  });

  it("rejects an audience session before persistence when generationRunId is absent", async () => {
    const { createComputeSession } = await import("../src/sessions");

    await expect(
      createComputeSession({
        representativeId: "rep-1",
        contactId: "contact-1",
        conversationId: "conversation-1",
        subagentId: "compute-agent",
        requestedBy: "audience",
        requestedCapabilities: ["exec"],
        reason: "run without a server-owned authorization",
      }),
    ).rejects.toThrow("audience_generation_run_required");

    expect(mockRequireAudienceGenerationRunAuthorization).toHaveBeenCalledWith({
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      requestedBy: "audience",
    });
    expect(mockLoadComputeRuntimeAuthority).not.toHaveBeenCalled();
    expect(mockPrisma.computeSession.create).not.toHaveBeenCalled();
  });
});
