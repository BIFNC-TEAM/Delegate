import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadComputeRuntimeAuthority, mockPrisma, state } = vi.hoisted(() => {
  const state = {
    currentAttempt: 1,
    session: null as Record<string, unknown> | null,
  };
  const materializeSession = (data: Record<string, unknown>) => {
    const now = new Date("2026-07-24T08:00:00.000Z");
    return {
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
      createdAt: now,
      updatedAt: now,
    };
  };
  const computeSession = {
    findUnique: vi.fn(async () => state.session),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.session = materializeSession(data);
      return state.session;
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.session = { ...state.session, ...data, updatedAt: new Date() };
      return state.session;
    }),
  };
  const prismaMock = {
    representative: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback(prismaMock)),
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values.includes("outbox-1")) {
        return values.includes(state.currentAttempt) ? 1 : 0;
      }
      return 1;
    }),
    delegationTask: { findUnique: vi.fn() },
    generationRun: { findUnique: vi.fn() },
    serviceEntitlementAccount: { findUnique: vi.fn() },
    serviceEntitlementLedgerEntry: { findMany: vi.fn() },
    computeSession,
    eventAudit: { create: vi.fn() },
  };
  return {
    mockLoadComputeRuntimeAuthority: vi.fn(),
    mockPrisma: prismaMock,
    state,
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/runtime-authority", () => ({
  loadComputeRuntimeAuthority: mockLoadComputeRuntimeAuthority,
}));

vi.mock("../src/lifecycle-hooks", () => ({
  computeLifecycleHooks: { emit: vi.fn() },
}));

process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";

describe("delegated compute session generation fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentAttempt = 1;
    state.session = null;
    mockPrisma.representative.findUnique.mockResolvedValue({
      id: "rep-1",
      slug: "rep-one",
      activeVersionId: "version-1",
      computeEnabled: true,
      capabilityProfiles: [{
        id: "profile-1",
        networkMode: "NO_NETWORK",
        filesystemMode: "WORKSPACE_ONLY",
      }],
    });
    mockPrisma.delegationTask.findUnique.mockResolvedValue({
      representativeId: "rep-1",
      contactId: "contact-1",
      originConversationId: "conversation-1",
      status: "RUNNING",
      generationRuns: [{
        id: "run-1",
        status: "PROCESSING",
        delegationTaskStepId: "step-1",
      }],
      resourcePolicy: { allowedCapabilities: ["WRITE"] },
      steps: [{ id: "step-1", capability: "WRITE", status: "RUNNING" }],
    });
    mockPrisma.generationRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "PROCESSING",
      conversationId: "conversation-1",
      runtimePolicySnapshot: { billingMode: "free" },
      conversation: {
        id: "conversation-1",
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        audienceIdentity: {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
        },
        contact: {
          id: "contact-1",
          audienceIdentityId: "audience-1",
          audienceIdentity: {
            id: "audience-1",
            status: "REGISTERED",
            mergedIntoId: null,
          },
        },
      },
    });
    mockLoadComputeRuntimeAuthority.mockResolvedValue({
      representativeVersionId: "version-1",
      compute: {
        enabled: true,
        baseImage: "pinned-image:1",
        maxSessionMinutes: 5,
        capabilityModes: { write: "allow" },
      },
    });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
  });

  it("reuses one session for attempt B and rejects attempt A after takeover", async () => {
    const { createComputeSession } = await import("../src/sessions");
    const request = {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      generationWorkLease: {
        outboxId: "outbox-1",
        leaseAttempt: 1,
      },
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      subagentId: "compute-agent",
      requestedBy: "audience",
      requestedCapabilities: ["write"],
      reason: "write a report",
    };

    const attemptA = await createComputeSession(request);
    expect(attemptA.session.id).toBe("session-1");

    state.currentAttempt = 2;
    const attemptB = await createComputeSession({
      ...request,
      generationWorkLease: {
        outboxId: "outbox-1",
        leaseAttempt: 2,
      },
    });
    expect(attemptB.session.id).toBe("session-1");
    expect(mockPrisma.computeSession.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventAudit.create).toHaveBeenCalledTimes(1);

    await expect(createComputeSession(request)).rejects.toThrow(
      "generation_work_lease_lost",
    );
    expect(mockPrisma.computeSession.create).toHaveBeenCalledTimes(1);
  });
});
