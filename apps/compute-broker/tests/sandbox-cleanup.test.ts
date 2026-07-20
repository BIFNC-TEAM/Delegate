import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    sandboxLease: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  };

  return { mockPrisma: prismaMock };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("sandbox cleanup lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
    mockPrisma.sandboxLease.findUnique.mockResolvedValue(buildLease({ status: "RUNNING" }));
    mockPrisma.sandboxLease.findMany.mockResolvedValue([buildLease({ status: "RUNNING" })]);
    mockPrisma.sandboxLease.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...buildLease({ status: String(data.status ?? "RUNNING") }),
      ...data,
    }));
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
  });

  it("stops idle running leases without deleting their identity", async () => {
    const provider = buildProvider();
    const { cleanupIdleSandboxLeases } = await import("../src/sandbox-leases");

    const result = await cleanupIdleSandboxLeases({
      now: new Date("2026-07-04T12:30:00.000Z"),
      idleStopMinutes: 15,
      providerFactory: async () => provider,
    });

    expect(mockPrisma.sandboxLease.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "RUNNING",
      }),
    }));
    expect(provider.stop).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({
        id: "lease-1",
        providerSandboxId: "identity-1",
      }),
    }));
    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({
        status: "STOPPED",
        stoppedAt: expect.any(Date),
      }),
    });
    expect(result).toEqual({ stopped: 1, failed: 0, skipped: 0 });
  });

  it("does not stop a lease that is already stopped", async () => {
    mockPrisma.sandboxLease.findUnique.mockResolvedValue(buildLease({ status: "STOPPED" }));
    const provider = buildProvider();
    const { stopSandboxLease } = await import("../src/sandbox-leases");

    const result = await stopSandboxLease({
      leaseId: "lease-1",
      reason: "idempotency_check",
      providerFactory: async () => provider,
    });

    expect(provider.stop).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
  });

  it("marks the lease as error when provider stop fails", async () => {
    const provider = buildProvider();
    provider.stop.mockRejectedValue(new Error("provider stop failed"));
    const { stopSandboxLease } = await import("../src/sandbox-leases");

    await expect(stopSandboxLease({
      leaseId: "lease-1",
      reason: "cleanup",
      providerFactory: async () => provider,
    })).rejects.toThrow("provider stop failed");

    expect(mockPrisma.sandboxLease.update).toHaveBeenCalledWith({
      where: { id: "lease-1" },
      data: expect.objectContaining({
        status: "ERROR",
        errorReason: "provider stop failed",
      }),
    });
  });
});

function buildProvider() {
  return {
    kind: "docker" as const,
    start: vi.fn(),
    execute: vi.fn(),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(),
  };
}

function buildLease(overrides: { status: string }) {
  return {
    id: "lease-1",
    sandboxIdentityId: "identity-1",
    provider: "DOCKER",
    providerSandboxId: "identity-1",
    runnerLeaseId: "runner-lease-1",
    containerId: "container-1",
    sessionRoot: "/delegate-session",
    status: overrides.status,
    lastUsedAt: new Date("2026-07-04T12:00:00.000Z"),
    expiresAt: new Date("2026-07-04T12:15:00.000Z"),
    stoppedAt: null,
    errorReason: null,
    sandboxIdentity: {
      representativeId: "rep-1",
      contactId: "contact-1",
    },
  };
}
