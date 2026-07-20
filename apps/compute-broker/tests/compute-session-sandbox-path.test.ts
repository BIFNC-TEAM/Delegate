import { beforeEach, describe, expect, it, vi } from "vitest";

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
  ensureUserSandboxLease: mockEnsureUserSandboxLease,
  stopSandboxLease: mockStopSandboxLease,
}));

describe("compute session sandbox path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
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
      providerKind: "docker",
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

  it("keeps the legacy per-session runner path when no contact identity exists", async () => {
    const { ensureComputeSessionLease } = await import("../src/leases");

    await ensureComputeSessionLease({
      session: buildSession({ contactId: null }),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
    });

    expect(mockEnsureUserSandboxLease).not.toHaveBeenCalled();
    expect(mockAcquireRunnerLease).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
    }));
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
});

function buildSession(overrides: { contactId: string | null }) {
  return {
    id: "session-1",
    representativeId: "rep-1",
    contactId: overrides.contactId,
    conversationId: "conversation-1",
    generationRunId: null,
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
