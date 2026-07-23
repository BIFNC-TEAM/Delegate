import { updateMcpBindingRequestSchema } from "@delegate/compute-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  McpBindingConflictError,
  updateMcpBindingWithOptimisticLock,
} from "../src/mcp-binding-concurrency";

describe("MCP binding optimistic concurrency", () => {
  it("requires the loaded timestamp on updates", () => {
    expect(updateMcpBindingRequestSchema.safeParse({
      enabled: false,
    }).success).toBe(false);
    expect(updateMcpBindingRequestSchema.safeParse({
      enabled: false,
      expectedUpdatedAt: "2026-07-23T04:00:00.000Z",
    }).success).toBe(true);
    expect(updateMcpBindingRequestSchema.safeParse({
      expectedUpdatedAt: "2026-07-23T04:00:00.000Z",
    }).success).toBe(false);
  });

  it("rejects a stale form before attempting the write", async () => {
    const claimUpdate = vi.fn();

    await expect(updateMcpBindingWithOptimisticLock({
      expectedUpdatedAt: "2026-07-23T04:00:00.000Z",
      loadCurrent: async () => ({
        id: "binding-1",
        updatedAt: new Date("2026-07-23T04:01:00.000Z"),
      }),
      claimUpdate,
      loadUpdated: async () => ({
        id: "binding-1",
        updatedAt: new Date("2026-07-23T04:01:00.000Z"),
      }),
    })).rejects.toBeInstanceOf(McpBindingConflictError);
    expect(claimUpdate).not.toHaveBeenCalled();
  });

  it("rejects a concurrent write that lands after the transactional read", async () => {
    const expectedUpdatedAt = "2026-07-23T04:00:00.000Z";
    const claimUpdate = vi.fn().mockResolvedValue({ count: 0 });

    await expect(updateMcpBindingWithOptimisticLock({
      expectedUpdatedAt,
      loadCurrent: async () => ({
        id: "binding-1",
        updatedAt: new Date(expectedUpdatedAt),
      }),
      claimUpdate,
      loadUpdated: async () => ({
        id: "binding-1",
        updatedAt: new Date("2026-07-23T04:01:00.000Z"),
      }),
    })).rejects.toBeInstanceOf(McpBindingConflictError);
    expect(claimUpdate).toHaveBeenCalledWith(new Date(expectedUpdatedAt));
  });

  it("returns both the audited prior row and the claimed update", async () => {
    const expectedUpdatedAt = "2026-07-23T04:00:00.000Z";
    const previous = {
      id: "binding-1",
      approvalRequired: true,
      updatedAt: new Date(expectedUpdatedAt),
    };
    const updated = {
      id: "binding-1",
      approvalRequired: false,
      updatedAt: new Date("2026-07-23T04:01:00.000Z"),
    };

    await expect(updateMcpBindingWithOptimisticLock({
      expectedUpdatedAt,
      loadCurrent: async () => previous,
      claimUpdate: async () => ({ count: 1 }),
      loadUpdated: async () => updated,
    })).resolves.toEqual({ previous, updated });
  });
});
