import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockAcquireRunnerLease,
  mockReleaseRunnerLease,
  mockEnsureUserSandboxLease,
  mockStopSandboxLease,
} = vi.hoisted(() => {
  const prismaMock = {
    computeSession: {
      update: vi.fn(),
    },
    sandboxLease: {
      findUnique: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  };

  return {
    mockPrisma: prismaMock,
    mockAcquireRunnerLease: vi.fn(),
    mockReleaseRunnerLease: vi.fn(),
    mockEnsureUserSandboxLease: vi.fn(),
    mockStopSandboxLease: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/runner", async () => {
  const actual = await vi.importActual<typeof import("../src/runner")>("../src/runner");
  return {
    ...actual,
    acquireRunnerLease: mockAcquireRunnerLease,
    releaseRunnerLease: mockReleaseRunnerLease,
  };
});

vi.mock("../src/sandbox-leases", () => ({
  createConfiguredProviderRegistry: () => ({
    create: vi.fn(),
    configured: vi.fn(() => true),
    resolveLegacyProvider: vi.fn(() => "docker"),
  }),
  ensureUserSandboxLease: mockEnsureUserSandboxLease,
  stopSandboxLease: mockStopSandboxLease,
}));

describe("compute session sandbox path", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
    process.env.NODE_ENV = "test";
    mockAcquireRunnerLease.mockResolvedValue({
      runnerType: "docker",
      leaseId: "runner-lease-1",
      containerId: "container-1",
      containerName: "container-1",
      sessionRoot: "/delegate-session",
    });
    mockEnsureUserSandboxLease.mockResolvedValue({
      identity: { id: "identity-1" },
      lease: { id: "sandbox-lease-1", status: "RUNNING" },
      providerLease: {
        runnerType: "docker",
        leaseId: "runner-lease-identity-1",
        containerId: "container-identity-1",
        containerName: "container-identity-1",
        sessionRoot: "/delegate-session",
        providerSandboxId: "identity-1",
      },
    });
    mockPrisma.computeSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...buildSession({ contactId: "contact-1" }),
      ...data,
    }));
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockStopSandboxLease.mockResolvedValue({ status: "stopped", leaseId: "sandbox-lease-1" });
  });

  it.each([
    { baseImage: "debian:bookworm-slim", networkMode: "FULL", allowed: false },
    { baseImage: "tencent://ap-guangzhou.tencentags.com/old-aio?image=debian%3Abookworm-slim", networkMode: "FULL", allowed: false },
    { baseImage: "tencent://ap-guangzhou.tencentags.com/delegate-aio-pi-v1?image=debian%3Abookworm-slim", networkMode: "NO_NETWORK", allowed: false },
    { baseImage: "tencent://ap-guangzhou.tencentags.com/delegate-aio-pi-v1?image=debian%3Abookworm-slim", networkMode: "FULL", allowed: true },
  ])("checks the template and network before reusing a READY Tencent session: $allowed/$networkMode/$baseImage", async (lease) => {
    vi.stubEnv("TENCENT_AGS_ALL_IN_ONE_TOOL", "delegate-aio-pi-v1");
    vi.stubEnv("TENCENT_AGS_REGION", "ap-guangzhou");
    vi.stubEnv("TENCENT_AGS_DOMAIN", "");
    mockPrisma.sandboxLease.findUnique.mockResolvedValue({ provider: "TENCENT", ...lease });
    const { ensureComputeSessionLease } = await import("../src/leases");
    const session = {
      ...buildSession({ contactId: "contact-1" }), leaseStatus: "READY" as const,
      sandboxLeaseId: "lease", runnerLeaseId: "sandbox", containerId: "sandbox",
    };
    const result = ensureComputeSessionLease({ session, networkMode: "full", filesystemMode: "ephemeral_full" });
    if (lease.allowed) await expect(result).resolves.toBe(session);
    else await expect(result).rejects.toMatchObject({ statusCode: 409, message: "sandbox_template_changed_new_session_required" });
    expect(mockEnsureUserSandboxLease).not.toHaveBeenCalled();
  });

  it("keeps local Docker compatibility independent of Tencent All-in-One settings", async () => {
    vi.stubEnv("TENCENT_AGS_ALL_IN_ONE_TOOL", "delegate-aio-pi-v1");
    const { ensureComputeSessionLease } = await import("../src/leases");
    const session = { ...buildSession({ contactId: null }), leaseStatus: "READY" as const,
      runnerLeaseId: "local-docker", containerId: "local-docker" };
    await expect(ensureComputeSessionLease({ session, networkMode: "no_network", filesystemMode: "ephemeral_full" }))
      .resolves.toBe(session);
  });

  it("uses a per-user sandbox lease when the compute session has a contact", async () => {
    const { ensureComputeSessionLease } = await import("../src/leases");

    const updated = await ensureComputeSessionLease({
      session: buildSession({ contactId: "contact-1" }),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
    });

    expect(mockEnsureUserSandboxLease).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({
        id: "session-1",
        representativeId: "rep-1",
        contactId: "contact-1",
      }),
      providerFactory: expect.any(Function),
      selectProviderForNewIdentity: expect.any(Function),
    }));
    expect(mockAcquireRunnerLease).not.toHaveBeenCalled();
    expect(mockPrisma.computeSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: expect.objectContaining({
        leaseStatus: "READY",
        sandboxLeaseId: "sandbox-lease-1",
        runnerLeaseId: "runner-lease-identity-1",
        containerId: "container-identity-1",
      }),
    });
    expect(updated.sandboxLeaseId).toBe("sandbox-lease-1");
  });

  it("fails closed instead of acquiring Docker when no contact identity exists", async () => {
    const { ensureComputeSessionLease } = await import("../src/leases");

    await expect(ensureComputeSessionLease({
      session: buildSession({ contactId: null }),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
    })).rejects.toMatchObject({
      message: "cloud_sandbox_contact_required",
      statusCode: 409,
    });

    expect(mockEnsureUserSandboxLease).not.toHaveBeenCalled();
    expect(mockAcquireRunnerLease).not.toHaveBeenCalled();
  });

  it("stops the sandbox lease when a sandbox-backed compute session is released", async () => {
    const { releaseComputeSessionLease } = await import("../src/leases");

    await releaseComputeSessionLease({
      ...buildSession({ contactId: "contact-1" }),
      sandboxLeaseId: "sandbox-lease-1",
      runnerLeaseId: "runner-lease-identity-1",
      containerId: "container-identity-1",
    });

    expect(mockStopSandboxLease).toHaveBeenCalledWith({
      leaseId: "sandbox-lease-1",
      sessionId: "session-1",
      reason: "compute_session_release",
    });
    expect(mockReleaseRunnerLease).not.toHaveBeenCalled();
    expect(mockPrisma.computeSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: expect.objectContaining({
        leaseStatus: "RELEASED",
        containerId: null,
      }),
    });
  });

  it("blocks a ready direct-Docker session in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.SANDBOX_PROVIDER = "tencent";
    process.env.SANDBOX_ROUTING_MODE = "manual_poc";
    process.env.SANDBOX_PROVIDER_ROUTING_JSON = JSON.stringify({
      version: 1,
      default: "tencent",
      newIdentityEnabled: { docker: false, daytona: false, tencent: true },
      phase1AllowedRepresentativeIds: [],
      representatives: {},
    });
    process.env.TENCENT_AGS_API_KEY = "test-key";
    process.env.TENCENT_AGS_REGION = "ap-guangzhou";
    process.env.TENCENT_AGS_CODE_TOOL = "delegate-code-v1";
    const { ensureComputeSessionLease } = await import("../src/leases");

    await expect(ensureComputeSessionLease({
      session: {
        ...buildSession({ contactId: "contact-1" }),
        leaseStatus: "READY",
        runnerLeaseId: "legacy-docker-lease",
        containerId: "legacy-container",
      },
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
    })).rejects.toMatchObject({
      message: "sandbox_provider_migration_required",
      statusCode: 409,
    });
  });
});

function buildSession(overrides: { contactId: string | null }) {
  return {
    id: "session-1",
    representativeId: "rep-1",
    representativeVersionId: "rep-version-1",
    contactId: overrides.contactId,
    conversationId: "conversation-1",
    generationRunId: null,
    generationOutboxId: null,
    generationLeaseAttempt: null,
    delegationTaskId: null,
    delegationTaskStepId: null,
    subagentId: "browser-agent",
    policyProfileId: "policy-1",
    sandboxLeaseId: null,
    requestedBy: "AUDIENCE" as const,
    status: "STARTING" as const,
    leaseStatus: "REQUESTED" as const,
    runnerLeaseId: null,
    containerId: null,
    runnerType: "DOCKER" as const,
    baseImage: "debian:bookworm-slim",
    runtimeClass: "CODE" as const,
    leaseTokenHash: "hash",
    leaseAcquiredAt: null,
    leaseLastUsedAt: null,
    leaseReleasedAt: null,
    startedAt: null,
    lastHeartbeatAt: null,
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
    endedAt: null,
    failureReason: null,
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    updatedAt: new Date("2026-07-04T12:00:00.000Z"),
  };
}
