import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    contact: {
      findUnique: vi.fn(),
    },
    sandboxIdentity: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    sandboxLease: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    sandboxProviderOperation: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    computeSession: {
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
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
    mockPrisma.sandboxIdentity.findUnique.mockResolvedValue(null);
    mockPrisma.sandboxIdentity.findUniqueOrThrow.mockResolvedValue(buildIdentity());
    mockPrisma.sandboxIdentity.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.sandboxIdentity.update.mockResolvedValue(buildIdentity());
    mockPrisma.sandboxLease.findFirst.mockResolvedValue(null);
    mockPrisma.sandboxLease.create.mockResolvedValue(buildLease({ status: "STARTING" }));
    mockPrisma.sandboxLease.update.mockResolvedValue(buildLease({ status: "RUNNING" }));
    mockPrisma.sandboxLease.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.sandboxLease.findUniqueOrThrow.mockResolvedValue(buildLease({ status: "RUNNING" }));
    mockPrisma.sandboxProviderOperation.create.mockResolvedValue({
      id: "operation-1",
      creationKey: "a".repeat(64),
    });
    mockPrisma.sandboxProviderOperation.update.mockResolvedValue({ id: "operation-1" });
    mockPrisma.sandboxProviderOperation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.computeSession.update.mockResolvedValue({ id: "session-1" });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockPrisma.$queryRaw.mockResolvedValue([]);
  });

  it("uses the representative/contact/conversation scope and creates one running lease", async () => {
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    const result = await ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: "/workspace",
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
      idleStopMinutes: 15,
    });

    expect(mockPrisma.sandboxIdentity.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
          representativeId: "rep-1",
          contactId: "contact-1",
          scopeKey: "conversation:conversation-1",
        audienceIdentityId: "audience-identity-1",
        provider: "DOCKER",
      })],
      skipDuplicates: true,
    });
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
    mockPrisma.sandboxIdentity.findUnique.mockResolvedValue(buildIdentity());
    mockPrisma.sandboxIdentity.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.sandboxLease.findFirst.mockResolvedValue(buildLease({
      status: "STOPPED",
      providerSandboxId: "provider-sandbox-existing",
    }));
    mockPrisma.sandboxLease.update.mockResolvedValue(buildLease({
      status: "STARTING",
      providerSandboxId: "provider-sandbox-existing",
    }));
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: "/workspace",
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
      idleStopMinutes: 15,
    });

    expect(mockPrisma.sandboxIdentity.createMany).toHaveBeenCalledTimes(1);
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
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
      idleStopMinutes: 15,
    })).rejects.toThrow("provider unavailable");

    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({
        status: "ERROR",
        errorReason: "sandbox_provider_start_unknown",
      }),
    });
  });

  it("keeps the stored provider when current routing changes", async () => {
    const identity = buildIdentity({ provider: "DAYTONA" });
    const runningLease = buildLease({ status: "RUNNING", provider: "DAYTONA" });
    mockPrisma.sandboxIdentity.findUnique.mockResolvedValue(identity);
    mockPrisma.sandboxIdentity.findUniqueOrThrow.mockResolvedValue(identity);
    mockPrisma.sandboxIdentity.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.sandboxLease.findFirst.mockResolvedValue(runningLease);
    mockPrisma.sandboxLease.update.mockResolvedValue(runningLease);
    const provider = { ...buildProvider(), kind: "daytona" as const };
    const selectProviderForNewIdentity = vi.fn(async () => ({
      providerKind: "tencent" as const,
      decisionSource: "manual_override" as const,
    }));
    const providerFactory = vi.fn(async () => provider);
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    const result = await ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      providerFactory,
      selectProviderForNewIdentity,
    });

    expect(selectProviderForNewIdentity).not.toHaveBeenCalled();
    expect(providerFactory).toHaveBeenCalledWith("daytona");
    expect(mockPrisma.sandboxIdentity.update).toHaveBeenCalledWith({
      where: { id: "identity-1" },
      data: expect.not.objectContaining({ provider: expect.anything() }),
    });
    expect(result.identity.provider).toBe("DAYTONA");
  });

  it("records provider construction failure as definite FAILED, not UNKNOWN", async () => {
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");
    const { SandboxProviderError } = await import("../src/sandbox-provider");

    await expect(ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      providerFactory: async () => {
        throw new SandboxProviderError("CONFIG_INVALID", false);
      },
      selectProviderForNewIdentity: async () => ({
        providerKind: "tencent",
        decisionSource: "manual_override",
      }),
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect(mockPrisma.sandboxProviderOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: "FAILED",
        lastErrorCode: "config_invalid",
      }),
    }));
    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({
        status: "ERROR",
        errorReason: "config_invalid",
      }),
    });
  });

  it("re-reads identity status after acquiring the row lock", async () => {
    mockPrisma.sandboxIdentity.findUniqueOrThrow
      .mockResolvedValueOnce(buildIdentity())
      .mockResolvedValueOnce({ ...buildIdentity(), status: "ARCHIVED" });
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await expect(ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
    })).rejects.toThrow("sandbox_identity_archived");

    expect(provider.start).not.toHaveBeenCalled();
    expect(mockPrisma.sandboxLease.create).not.toHaveBeenCalled();
  });

  it("rejects a remote start that loses the identity lifecycle fence", async () => {
    mockPrisma.sandboxIdentity.findUniqueOrThrow
      .mockResolvedValueOnce(buildIdentity())
      .mockResolvedValueOnce(buildIdentity())
      .mockResolvedValueOnce({ ...buildIdentity(), lifecycleEpoch: 2 });
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await expect(ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
    })).rejects.toThrow("sandbox_identity_concurrent_change");

    expect(provider.stop).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ providerSandboxId: "provider-sandbox-1" }),
    }));
    expect(mockPrisma.sandboxProviderOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: "UNKNOWN" }),
    }));
  });

  it("rejects a provider response that arrives after the operation deadline fence", async () => {
    mockPrisma.sandboxProviderOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    const provider = buildProvider();
    const { ensureUserSandboxLease } = await import("../src/sandbox-leases");

    await expect(ensureUserSandboxLease({
      session: buildSession(),
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      providerFactory: async () => provider,
      selectProviderForNewIdentity: async () => ({
        providerKind: "docker",
        decisionSource: "legacy",
      }),
    })).rejects.toThrow("sandbox_provider_operation_fence_lost");

    expect(provider.stop).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ providerSandboxId: "provider-sandbox-1" }),
    }));
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
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function buildSession() {
  return {
    id: "session-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    baseImage: "debian:bookworm-slim",
    runtimeClass: "CODE",
    runnerType: "DOCKER",
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
  };
}

function buildIdentity(overrides: Partial<{ provider: "DOCKER" | "DAYTONA" | "TENCENT" }> = {}) {
  return {
    id: "identity-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    provider: overrides.provider ?? "DOCKER",
    status: "ACTIVE",
    lifecycleEpoch: 1,
  };
}

function buildLease(overrides: Partial<{
  status: string;
  providerSandboxId: string | null;
  provider: "DOCKER" | "DAYTONA" | "TENCENT";
}> = {}) {
  return {
    id: "lease-1",
    sandboxIdentityId: "identity-1",
    provider: overrides.provider ?? "DOCKER",
    providerSandboxId: overrides.providerSandboxId ?? null,
    status: overrides.status ?? "STARTING",
    runnerLeaseId: null,
    containerId: null,
    sessionRoot: null,
    errorReason: null,
    runtimeClass: "CODE",
    identityLifecycleEpoch: 1,
    lastUsedAt: new Date("2026-07-04T12:00:00.000Z"),
    stoppedAt: null,
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
  };
}
