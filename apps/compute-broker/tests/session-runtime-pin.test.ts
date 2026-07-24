import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadComputeRuntimeAuthority,
  mockPrisma,
  mockRequireAudienceGenerationRunAuthorization,
} = vi.hoisted(() => ({
  mockLoadComputeRuntimeAuthority: vi.fn(),
  mockRequireAudienceGenerationRunAuthorization: vi.fn(),
  mockPrisma: {
    representative: { findUnique: vi.fn() },
    delegationTask: { findUnique: vi.fn() },
    computeSession: { create: vi.fn() },
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
        autoApproveBudgetCents: 0,
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
        maxCostCents: 0,
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
