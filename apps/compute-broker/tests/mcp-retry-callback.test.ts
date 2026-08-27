import { describe, expect, it, vi } from "vitest";

process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";

describe("MCP retry lifecycle callback", () => {
  it("extends timeouts only for server-verified retry-safe reads", async () => {
    const { resolveMcpCallTimeoutMs } = await import("../src/mcp");

    expect(resolveMcpCallTimeoutMs(15_000, false)).toBe(15_000);
    expect(resolveMcpCallTimeoutMs(15_000, true)).toBe(60_000);
    expect(resolveMcpCallTimeoutMs(90_000, true)).toBe(90_000);
  });

  it("records call start once across sequential retry attempts", async () => {
    const { createAtMostOnceAsyncCallback } = await import("../src/mcp");
    const callback = vi.fn().mockResolvedValue(undefined);
    const recordStart = createAtMostOnceAsyncCallback(callback);

    await recordStart?.();
    await recordStart?.();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("allows a failed state transition to be attempted again", async () => {
    const { createAtMostOnceAsyncCallback } = await import("../src/mcp");
    const callback = vi.fn()
      .mockRejectedValueOnce(new Error("temporary_database_failure"))
      .mockResolvedValueOnce(undefined);
    const recordStart = createAtMostOnceAsyncCallback(callback);

    await expect(recordStart?.()).rejects.toThrow("temporary_database_failure");
    await expect(recordStart?.()).resolves.toBeUndefined();
    await expect(recordStart?.()).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(2);
  });
});
