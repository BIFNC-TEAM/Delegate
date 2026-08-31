import { describe, expect, it, vi } from "vitest";

import {
  buildSandboxCreationKey,
  createSandboxProviderOperation,
  markSandboxProviderOperationBound,
  markSandboxProviderOperationCalled,
  markSandboxProviderOperationFailed,
  markSandboxProviderOperationResolved,
  quarantineExpiredSandboxProviderOperations,
} from "../src/sandbox-provider-operations";

const { mockUpdateMany } = vi.hoisted(() => ({ mockUpdateMany: vi.fn() }));

vi.mock("../src/prisma", () => ({
  prisma: { sandboxProviderOperation: { updateMany: mockUpdateMany } },
}));

describe("sandbox provider operation journal", () => {
  it("derives a stable unique creation key from lease and attempt", () => {
    expect(buildSandboxCreationKey("lease-1", 1)).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildSandboxCreationKey("lease-1", 1)).toBe(buildSandboxCreationKey("lease-1", 1));
    expect(buildSandboxCreationKey("lease-1", 2)).not.toBe(buildSandboxCreationKey("lease-1", 1));
  });

  it("creates a bounded PENDING operation", async () => {
    const create = vi.fn(async ({ data }) => ({ id: "operation-1", ...data }));
    const tx = { sandboxProviderOperation: { create } };
    const now = new Date("2026-08-28T00:00:00.000Z");

    await createSandboxProviderOperation(tx as never, {
      sandboxLeaseId: "lease-1",
      provider: "TENCENT",
      attemptNumber: 1,
      now,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sandboxLeaseId: "lease-1",
        provider: "TENCENT",
        state: "PENDING",
        deadlineAt: new Date("2026-08-28T00:02:00.000Z"),
      }),
    });
  });

  it("distinguishes definite failure from ambiguous outcome", () => {
    expect(markSandboxProviderOperationFailed({
      operationId: "operation-1",
      errorCode: "AUTH_INVALID",
      ambiguous: false,
    }).data).toMatchObject({ state: "FAILED", lastErrorCode: "AUTH_INVALID" });
    expect(markSandboxProviderOperationFailed({
      operationId: "operation-1",
      errorCode: "AMBIGUOUS_CREATE",
      ambiguous: true,
    }).data).toMatchObject({ state: "UNKNOWN", lastErrorCode: "AMBIGUOUS_CREATE" });
  });

  it("defines called, bound, and resolved transitions", () => {
    expect(markSandboxProviderOperationCalled("operation-1").data.state).toBe("CALLED");
    expect(markSandboxProviderOperationBound({
      operationId: "operation-1",
      providerSandboxId: "sandbox-1",
    }).data).toMatchObject({ state: "BOUND", providerSandboxId: "sandbox-1" });
    expect(markSandboxProviderOperationResolved("operation-1").data.state).toBe("RESOLVED");
  });

  it("quarantines unresolved operations after their persisted deadline", async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-08-28T00:02:00.000Z");
    await quarantineExpiredSandboxProviderOperations(now);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        state: { in: ["PENDING", "CALLED", "UNKNOWN"] },
        deadlineAt: { lte: now },
      },
      data: {
        state: "QUARANTINED",
        ownerTokenHash: null,
        ownerLeaseExpiresAt: null,
      },
    });
  });
});
