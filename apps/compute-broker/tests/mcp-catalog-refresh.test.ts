import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  begin: vi.fn(),
  sync: vi.fn(),
  success: vi.fn(),
  failure: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $queryRaw: mocks.queryRaw,
    representativeMcpBinding: { findMany: mocks.findMany },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx)),
    },
  };
});

vi.mock("../src/mcp-bindings", () => ({
  beginRepresentativeMcpBindingHealthObservation: mocks.begin,
  recordRepresentativeMcpBindingSuccess: mocks.success,
  recordRepresentativeMcpBindingFailure: mocks.failure,
}));

vi.mock("../src/mcp-tool-definitions", () => ({
  syncRepresentativeMcpToolDefinitions: mocks.sync,
}));

describe("durable MCP catalog refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ acquired: true }]);
    mocks.findMany.mockResolvedValue([]);
    mocks.success.mockResolvedValue(true);
    mocks.failure.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a database advisory lock and skips duplicate Broker instances", async () => {
    mocks.queryRaw.mockResolvedValue([{ acquired: false }]);
    const { refreshMcpCatalogOnce } = await import("../src/mcp-catalog-refresh");

    await expect(refreshMcpCatalogOnce()).resolves.toEqual({
      acquired: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      staleObservations: 0,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("isolates one binding failure and records monotonic health outcomes", async () => {
    const bindings = [{ id: "binding-a", configRevision: 2 }, {
      id: "binding-b",
      configRevision: 4,
    }];
    mocks.begin.mockImplementation(async ({ bindingId, configRevision, startedAt }) => ({
      bindingId,
      configRevision,
      requestGeneration: bindingId === "binding-a" ? 1n : 2n,
      startedAt,
    }));
    mocks.sync.mockRejectedValueOnce(new Error("first unavailable"))
      .mockResolvedValueOnce([{ id: "tool-b" }]);
    const { refreshMcpBindings } = await import("../src/mcp-catalog-refresh");

    await expect(refreshMcpBindings(bindings, {
      now: monotonicClock(),
    })).resolves.toEqual({
      acquired: true,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      staleObservations: 0,
    });
    expect(mocks.sync).toHaveBeenNthCalledWith(1, "binding-a");
    expect(mocks.sync).toHaveBeenNthCalledWith(2, "binding-b");
    expect(mocks.failure).toHaveBeenCalledWith(expect.objectContaining({
      observation: expect.objectContaining({ bindingId: "binding-a" }),
      failureReason: "first unavailable",
    }));
    expect(mocks.success).toHaveBeenCalledWith(expect.objectContaining({
      observation: expect.objectContaining({ bindingId: "binding-b" }),
    }));
  });

  it("does not count a stale completion that loses to a newer observation", async () => {
    mocks.begin.mockResolvedValue({
      bindingId: "binding-a",
      configRevision: 1,
      requestGeneration: 1n,
      startedAt: new Date("2026-08-25T00:00:00.000Z"),
    });
    mocks.sync.mockResolvedValue([]);
    mocks.success.mockResolvedValue(false);
    const { refreshMcpBindings } = await import("../src/mcp-catalog-refresh");

    await expect(refreshMcpBindings([{ id: "binding-a", configRevision: 1 }]))
      .resolves.toMatchObject({
        succeeded: 0,
        staleObservations: 1,
      });
  });

  it("does not rewrite a successful tools/list read as failure when health persistence fails", async () => {
    mocks.begin.mockResolvedValue({
      bindingId: "binding-a",
      configRevision: 1,
      requestGeneration: 1n,
      startedAt: new Date("2026-08-25T00:00:00.000Z"),
    });
    mocks.sync.mockResolvedValue([{ id: "fresh-tool" }]);
    mocks.success.mockRejectedValue(new Error("health write unavailable"));
    const { refreshMcpBindings } = await import("../src/mcp-catalog-refresh");

    await expect(refreshMcpBindings([{ id: "binding-a", configRevision: 1 }]))
      .resolves.toMatchObject({
        failed: 0,
        staleObservations: 1,
      });
    expect(mocks.failure).not.toHaveBeenCalled();
  });

  it("runs immediately, repeats at the configured interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { startMcpCatalogRefreshLoop } = await import(
      "../src/mcp-catalog-refresh"
    );

    const stop = startMcpCatalogRefreshLoop({ intervalMs: 1_000, refresh });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("is wired into Broker startup and shutdown", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("startMcpCatalogRefreshLoop({");
    expect(source).toContain("computeBrokerConfig.mcpCatalogRefreshIntervalMs");
    expect(source).toContain("stopMcpCatalogRefreshLoop();");
    expect(source).toContain('for (const signal of ["SIGINT", "SIGTERM"]');
  });
});

function monotonicClock() {
  let timestamp = Date.parse("2026-08-25T00:00:00.000Z");
  return () => new Date(timestamp += 1_000);
}
