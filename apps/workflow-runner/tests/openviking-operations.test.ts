import { describe, expect, it, vi } from "vitest";

import { runOpenVikingOperationsTick } from "../src/openviking-operations";

describe("workflow-runner OpenViking maintenance", () => {
  it("runs sync and deletion recovery as isolated bounded lanes", async () => {
    const runSyncJobsTick = vi.fn().mockRejectedValue(
      new Error("sync database unavailable"),
    );
    const runMemoryDeletionTick = vi.fn().mockResolvedValue({
      processed: 1,
      deleted: 1,
      failed: 0,
      pending: 0,
    });

    const result = await runOpenVikingOperationsTick(
      {
        syncBatchSize: 3,
        memoryDeletionBatchSize: 7,
      },
      {
        runSyncJobsTick,
        runMemoryDeletionTick,
      },
    );

    expect(runSyncJobsTick).toHaveBeenCalledWith({ limit: 3 });
    expect(runMemoryDeletionTick).toHaveBeenCalledWith({ limit: 7 });
    expect(result).toEqual({
      sync: null,
      memoryDeletion: {
        processed: 1,
        deleted: 1,
        failed: 0,
        pending: 0,
      },
      failedLaneCodes: ["openviking_sync_tick_failed"],
    });
  });

  it("reports both durable lanes when they finish", async () => {
    const result = await runOpenVikingOperationsTick(
      {
        syncBatchSize: 2,
        memoryDeletionBatchSize: 12,
      },
      {
        runSyncJobsTick: vi.fn().mockResolvedValue({
          processed: 1,
          succeeded: 1,
          retryScheduled: 0,
          terminal: 0,
        }),
        runMemoryDeletionTick: vi.fn().mockResolvedValue({
          processed: 2,
          deleted: 1,
          failed: 1,
          pending: 0,
        }),
      },
    );

    expect(result.failedLaneCodes).toEqual([]);
    expect(result.sync?.succeeded).toBe(1);
    expect(result.memoryDeletion?.processed).toBe(2);
  });
});
