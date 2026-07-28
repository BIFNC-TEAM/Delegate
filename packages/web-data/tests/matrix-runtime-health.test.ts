import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    matrixVirtualUserBinding: {
      findFirst: vi.fn(),
    },
    representativeChannelBinding: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  checkMatrixRuntimePersistenceReadiness,
  recordMatrixRuntimeHealth,
} from "../src/matrix-runtime-health";

describe("Matrix runtime health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ "?column?": 1 }]);
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
        operation(mockPrisma),
    );
    mockPrisma.matrixVirtualUserBinding.findFirst.mockResolvedValue({
      representativeId: "representative-1",
    });
    mockPrisma.representativeChannelBinding.updateMany.mockResolvedValue({
      count: 1,
    });
  });

  it("reports persistence readiness only after a successful database probe", async () => {
    await expect(
      checkMatrixRuntimePersistenceReadiness(mockPrisma as never),
    ).resolves.toBe(true);
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith("SELECT 1");

    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      checkMatrixRuntimePersistenceReadiness(mockPrisma as never),
    ).resolves.toBe(false);
  });

  it("marks a managed representative channel connected after protocol success", async () => {
    const checkedAt = new Date("2026-07-28T04:00:00.000Z");

    await expect(recordMatrixRuntimeHealth({
      matrixUserId: "@_delegate_rep:EXAMPLE.ORG",
      status: "HEALTHY",
      checkedAt,
    })).resolves.toBe(true);

    expect(
      mockPrisma.matrixVirtualUserBinding.findFirst,
    ).toHaveBeenCalledWith({
      where: {
        matrixUserId: "@_delegate_rep:EXAMPLE.ORG",
        kind: "REPRESENTATIVE",
        enabled: true,
        representativeId: { not: null },
      },
      select: { representativeId: true },
    });
    expect(
      mockPrisma.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        representativeId: "representative-1",
        kind: "MATRIX",
        externalUserId: "@_delegate_rep:EXAMPLE.ORG",
        desiredState: { not: "DISCONNECTED" },
        status: { not: "DISCONNECTED" },
      },
      data: {
        healthStatus: "HEALTHY",
        lastHealthCheckAt: checkedAt,
        lastError: null,
        status: "CONNECTED",
      },
    });
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("records only a bounded error code for a failed Matrix join", async () => {
    await expect(recordMatrixRuntimeHealth({
      matrixUserId: "@_delegate_rep:example.org",
      status: "DEGRADED",
      errorCode: "Join https://secret.example/?access_token=secret returned 502",
    })).resolves.toBe(true);

    expect(
      mockPrisma.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        healthStatus: "DEGRADED",
        lastError: "matrix_runtime_error",
      }),
    }));
  });

  it("does not update an unknown or disabled virtual user", async () => {
    mockPrisma.matrixVirtualUserBinding.findFirst.mockResolvedValue(null);

    await expect(recordMatrixRuntimeHealth({
      matrixUserId: "@_delegate_missing:example.org",
      status: "UNHEALTHY",
      errorCode: "registration_failed",
    })).resolves.toBe(false);
    expect(
      mockPrisma.representativeChannelBinding.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("does not race a completed disconnect back to CONNECTED", async () => {
    mockPrisma.matrixVirtualUserBinding.findFirst
      .mockResolvedValueOnce({ representativeId: "representative-1" })
      .mockResolvedValueOnce(null);

    await expect(recordMatrixRuntimeHealth({
      matrixUserId: "@_delegate_rep:example.org",
      status: "HEALTHY",
    })).resolves.toBe(false);

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(
      mockPrisma.representativeChannelBinding.updateMany,
    ).not.toHaveBeenCalled();
  });
});
