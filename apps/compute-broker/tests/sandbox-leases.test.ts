import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    contact: {
      findUnique: vi.fn(),
    },
    sandboxIdentity: {
      upsert: vi.fn(),
    },
    sandboxLease: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    computeSession: {
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  prismaMock.$transaction.mockImplementation(async (callback: unknown) => {
    return (callback as (client: typeof prismaMock) => unknown)(prismaMock);
  });

  return { mockPrisma: prismaMock };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("ensureUserSandboxLease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => {
      return (callback as (client: typeof mockPrisma) => unknown)(mockPrisma);
    });
    mockPrisma.contact.findUnique.mockResolvedValue({ audienceIdentityId: "audience-identity-1" });
    mockPrisma.sandboxIdentity.upsert.mockResolvedValue(buildIdentity());
    mockPrisma.sandboxLease.findFirst.mockResolvedValue(null);
    mockPrisma.sandboxLease.create.mockResolvedValue(buildLease({ status: "STARTING" }));
    mockPrisma.sandboxLease.update.mockResolvedValue(buildLease({ status: "RUNNING" }));
    mockPrisma.computeSession.update.mockResolvedValue({ id: "session-1" });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
  });

  it("uses the representative/contact unique key and creates one running lease", async () => {
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    const result = await ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: "/workspace",
      provider,
      providerKind: "docker",
      idleStopMinutes: 15,
    });

    expect(mockPrisma.sandboxIdentity.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        representativeId_contactId: {
          representativeId: "rep-1",
          contactId: "contact-1",
        },
      },
      update: expect.objectContaining({
        audienceIdentityId: "audience-identity-1",
      }),
      create: expect.objectContaining({
        audienceIdentityId: "audience-identity-1",
      }),
    }));
    expect(mockPrisma.sandboxLease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sandboxIdentityId: "identity-1",
        provider: "DOCKER",
        status: "STARTING",
      }),
    });
    expect(provider.start).toHaveBeenCalledWith(expect.objectContaining({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      sessionId: "session-1",
    }));
    expect(mockPrisma.computeSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: expect.objectContaining({
        sandboxLeaseId: "lease-1",
        runnerLeaseId: "provider-lease-1",
        containerId: "container-1",
      }),
    });
    expect(result.identity.id).toBe("identity-1");
    expect(result.lease.status).toBe("RUNNING");
  });

  it("restarts a stopped lease without creating a second identity", async () => {
    mockPrisma.sandboxLease.findFirst.mockResolvedValue(buildLease({
      status: "STOPPED",
      providerSandboxId: "provider-sandbox-existing",
    }));
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: "/workspace",
      provider,
      providerKind: "docker",
      idleStopMinutes: 15,
    });

    expect(mockPrisma.sandboxIdentity.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.sandboxLease.create).not.toHaveBeenCalled();
    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({ status: "STARTING" }),
    });
    expect(provider.start).toHaveBeenCalledWith(expect.objectContaining({
      providerSandboxId: "provider-sandbox-existing",
    }));
  });

  it("marks the lease as error when the provider fails to start", async () => {
    const provider = buildProvider();
    provider.start.mockRejectedValue(new Error("provider unavailable"));
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await expect(ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: "/workspace",
      provider,
      providerKind: "docker",
      idleStopMinutes: 15,
    })).rejects.toThrow("provider unavailable");

    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({
        status: "ERROR",
        errorReason: "provider unavailable",
      }),
    });
  });
});

function buildProvider() {
  return {
    kind: "docker" as const,
    start: vi.fn(async () => ({
      runnerType: "docker" as const,
      id: "lease-1",
      provider: "docker" as const,
      leaseId: "provider-lease-1",
      providerSandboxId: "provider-sandbox-1",
      containerId: "container-1",
      containerName: "container-1",
      sessionRoot: "/delegate-session",
    })),
    execute: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
  };
}

function buildSession() {
  return {
    id: "session-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    baseImage: "debian:bookworm-slim",
    runnerType: "DOCKER",
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
  };
}

function buildIdentity() {
  return {
    id: "identity-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    provider: "DOCKER",
    status: "ACTIVE",
  };
}

function buildLease(overrides: Partial<{
  status: string;
  providerSandboxId: string | null;
}> = {}) {
  return {
    id: "lease-1",
    sandboxIdentityId: "identity-1",
    provider: "DOCKER",
    providerSandboxId: overrides.providerSandboxId ?? null,
    status: overrides.status ?? "STARTING",
    runnerLeaseId: null,
    containerId: null,
    sessionRoot: null,
    errorReason: null,
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
  };
}
