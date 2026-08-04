import { describe, expect, it, vi } from "vitest";

import type { ConversationWorkerConfig } from "../src/config";
import {
  conversationWorkerLaneNames,
  startConversationWorkerLoops,
  type ConversationWorkerLaneName,
  type ConversationWorkerLaneWorkResult,
  type ConversationWorkerSchedulerDependencies,
} from "../src/scheduler";

const config: ConversationWorkerConfig = {
  port: 4040,
  pollMs: 500,
  memoryProjectionPollMs: 700,
  memoryCleanupPollMs: 900,
  memoryReconciliationPollMs: 1_200,
  memoryTickTimeoutMs: 60_000,
  readinessStaleMs: 180_000,
  telegramConversationPlatformMode: "worker",
  telegramRequestTimeoutMs: 15_000,
  outboxProcessingLeaseMs: 5 * 60_000,
};

type ScheduledTick = {
  callback: () => void;
  delayMs: number;
  lane: ConversationWorkerLaneName;
  handle: ReturnType<typeof setTimeout>;
};

function createScheduleHarness() {
  const pending: ScheduledTick[] = [];
  let nextHandle = 1;
  const clearSchedule = vi.fn();
  return {
    pending,
    clearSchedule,
    schedule(
      callback: () => void,
      delayMs: number,
      lane: ConversationWorkerLaneName,
    ) {
      const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>;
      pending.push({ callback, delayMs, lane, handle });
      return handle;
    },
    take(lane: ConversationWorkerLaneName): ScheduledTick {
      const index = pending.findIndex((entry) => entry.lane === lane);
      if (index < 0) throw new Error(`No scheduled ${lane} tick.`);
      return pending.splice(index, 1)[0]!;
    },
  };
}

function noWorkDependencies(
  overrides: Partial<ConversationWorkerSchedulerDependencies> = {},
) {
  return {
    processConversation: vi.fn(async () => ({ processed: false as const })),
    processMemoryExtraction: vi.fn(async () => ({ processed: false as const })),
    processProjectionWrite: vi.fn(async () => ({ processed: false as const })),
    processProjectionDelete: vi.fn(async () => ({ processed: false as const })),
    processCleanup: vi.fn(async () => ({ processed: false as const })),
    processReconciliation: vi.fn(async () => ({ processed: false as const })),
    ...overrides,
  };
}

describe("conversation worker scheduler", () => {
  it("keeps every memory lane pumping while a conversation call never settles", async () => {
    const harness = createScheduleHarness();
    const conversationNeverCompletes = new Promise<never>(() => undefined);
    const dependencies = noWorkDependencies({
      processConversation: vi.fn(() => conversationNeverCompletes),
    });
    const scheduler = startConversationWorkerLoops(config, {
      ...dependencies,
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(5));
    expect(dependencies.processConversation).toHaveBeenCalledTimes(1);

    for (const lane of conversationWorkerLaneNames.filter(
      (name) => name !== "conversation",
    )) {
      harness.take(lane).callback();
    }

    await vi.waitFor(() => {
      expect(dependencies.processMemoryExtraction).toHaveBeenCalledTimes(2);
      expect(dependencies.processProjectionWrite).toHaveBeenCalledTimes(2);
      expect(dependencies.processProjectionDelete).toHaveBeenCalledTimes(2);
      expect(dependencies.processCleanup).toHaveBeenCalledTimes(2);
      expect(dependencies.processReconciliation).toHaveBeenCalledTimes(2);
    });
    expect(scheduler.snapshot().conversation).toMatchObject({
      active: true,
      activeSince: expect.any(String),
      lastCompletedAt: null,
    });
    scheduler.stop();
  });

  it("does not let a stuck projection write block deletion, cleanup, or reconciliation", async () => {
    const harness = createScheduleHarness();
    const writeNeverCompletes = new Promise<never>(() => undefined);
    const dependencies = noWorkDependencies({
      processProjectionWrite: vi.fn(() => writeNeverCompletes),
    });
    const scheduler = startConversationWorkerLoops(config, {
      ...dependencies,
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(5));
    for (const lane of [
      "projectionDelete",
      "cleanup",
      "reconciliation",
    ] as const) {
      harness.take(lane).callback();
    }

    await vi.waitFor(() => {
      expect(dependencies.processProjectionDelete).toHaveBeenCalledTimes(2);
      expect(dependencies.processCleanup).toHaveBeenCalledTimes(2);
      expect(dependencies.processReconciliation).toHaveBeenCalledTimes(2);
    });
    expect(dependencies.processProjectionWrite).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().projectionWrite.active).toBe(true);
    scheduler.stop();
  });

  it("never overlaps two ticks in the same lane", async () => {
    const harness = createScheduleHarness();
    let resolveCleanup: ((result: ConversationWorkerLaneWorkResult) => void) | undefined;
    const pendingCleanup = new Promise<ConversationWorkerLaneWorkResult>((resolve) => {
      resolveCleanup = resolve;
    });
    const processCleanup = vi.fn()
      .mockResolvedValueOnce({ processed: false as const })
      .mockImplementationOnce(() => pendingCleanup);
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({ processCleanup }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(6));
    const scheduledCleanup = harness.take("cleanup");
    scheduledCleanup.callback();
    scheduledCleanup.callback();

    await vi.waitFor(() => expect(processCleanup).toHaveBeenCalledTimes(2));
    expect(scheduler.snapshot().cleanup.active).toBe(true);
    resolveCleanup?.({ processed: false });
    await vi.waitFor(() => expect(scheduler.snapshot().cleanup.active).toBe(false));
    expect(processCleanup).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("records retrying work as a failure without claiming it was processed, then recovers", async () => {
    const harness = createScheduleHarness();
    const processMemoryExtraction = vi.fn()
      .mockResolvedValueOnce({
        processed: true as const,
        status: "retrying",
        errorCode: "private database detail",
      })
      .mockResolvedValueOnce({
        processed: true as const,
        status: "completed",
      });
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({ processMemoryExtraction }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().memoryExtraction).toMatchObject({
        active: false,
        lastCompletedAt: expect.any(String),
        lastSuccessfulAt: null,
        lastProcessedAt: null,
        lastFailureAt: expect.any(String),
        consecutiveFailures: 1,
        lastErrorCode: "memory_extraction_tick_failed",
        failureOrigin: "work",
      });
    });
    expect(JSON.stringify(scheduler.snapshot())).not.toContain("private database");

    harness.take("memoryExtraction").callback();
    await vi.waitFor(() => {
      expect(scheduler.snapshot().memoryExtraction).toMatchObject({
        active: false,
        activeSince: null,
        lastSuccessfulAt: expect.any(String),
        lastProcessedAt: expect.any(String),
        lastFailureAt: expect.any(String),
        consecutiveFailures: 0,
        lastErrorCode: null,
        failureOrigin: null,
      });
    });
    scheduler.stop();
  });

  it("does not let an idle poll erase an unresolved operational failure", async () => {
    const harness = createScheduleHarness();
    const processReconciliation = vi.fn()
      .mockResolvedValueOnce({
        processed: true as const,
        status: "requeued",
        operationalStatus: "retrying" as const,
        operationalErrorCode: "reconciliation_provider_retryable",
      })
      .mockResolvedValueOnce({ processed: false as const })
      .mockResolvedValueOnce({
        processed: true as const,
        status: "partial",
        operationalStatus: "ok" as const,
      });
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({ processReconciliation }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().reconciliation).toMatchObject({
        consecutiveFailures: 1,
        lastErrorCode: "reconciliation_provider_retryable",
        failureOrigin: "work",
        lastSuccessfulAt: null,
      });
    });

    harness.take("reconciliation").callback();
    await vi.waitFor(() => expect(processReconciliation).toHaveBeenCalledTimes(2));
    expect(scheduler.snapshot().reconciliation).toMatchObject({
      consecutiveFailures: 1,
      lastErrorCode: "reconciliation_provider_retryable",
      failureOrigin: "work",
      lastSuccessfulAt: null,
    });

    harness.take("reconciliation").callback();
    await vi.waitFor(() => {
      expect(scheduler.snapshot().reconciliation).toMatchObject({
        consecutiveFailures: 0,
        lastErrorCode: null,
        failureOrigin: null,
        lastSuccessfulAt: expect.any(String),
        lastProcessedAt: expect.any(String),
      });
    });
    scheduler.stop();
  });

  it("recovers a tick/source exception after one successful idle probe", async () => {
    const harness = createScheduleHarness();
    const processProjectionWrite = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValueOnce({ processed: false as const });
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({ processProjectionWrite }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().projectionWrite).toMatchObject({
        lastSuccessfulAt: null,
        lastFailureAt: expect.any(String),
        consecutiveFailures: 1,
        lastErrorCode: "memory_projection_write_tick_failed",
        failureOrigin: "tick",
      });
    });

    harness.take("projectionWrite").callback();
    await vi.waitFor(() => expect(processProjectionWrite).toHaveBeenCalledTimes(2));
    expect(scheduler.snapshot().projectionWrite).toMatchObject({
      lastSuccessfulAt: expect.any(String),
      lastProcessedAt: null,
      lastFailureAt: expect.any(String),
      consecutiveFailures: 0,
      lastErrorCode: null,
      failureOrigin: null,
    });
    scheduler.stop();
  });

  it("treats a completed authority handoff as successful work", async () => {
    const harness = createScheduleHarness();
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({
        processProjectionWrite: vi.fn(async () => ({
          processed: true as const,
          status: "completed",
          errorCode: "projection_not_authoritative",
        })),
      }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().projectionWrite).toMatchObject({
        lastProcessedAt: expect.any(String),
        lastSuccessfulAt: expect.any(String),
        lastErrorCode: null,
        consecutiveFailures: 0,
      });
    });
    expect(harness.take("projectionWrite").delayMs).toBe(0);
    scheduler.stop();
  });

  it("treats partial inventory coverage as completed work, not a worker failure", async () => {
    const harness = createScheduleHarness();
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({
        processReconciliation: vi.fn(async () => ({
          processed: true as const,
          status: "partial",
          errorCode: "openviking_inventory_no_snapshot_cursor",
          operationalStatus: "ok" as const,
        })),
      }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().reconciliation).toMatchObject({
        lastProcessedAt: expect.any(String),
        lastSuccessfulAt: expect.any(String),
        lastFailureAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
      });
    });
    expect(harness.take("reconciliation").delayMs).toBe(0);
    scheduler.stop();
  });

  it("keeps reconciliation unhealthy when a partial run contains failed targets", async () => {
    const harness = createScheduleHarness();
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({
        processReconciliation: vi.fn(async () => ({
          processed: true as const,
          status: "partial",
          errorCode: "openviking_inventory_no_snapshot_cursor",
          operationalStatus: "failed" as const,
          operationalErrorCode: "reconciliation_provider_disabled",
        })),
      }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().reconciliation).toMatchObject({
        lastSuccessfulAt: null,
        lastFailureAt: expect.any(String),
        consecutiveFailures: 1,
        lastErrorCode: "reconciliation_provider_disabled",
        failureOrigin: "work",
      });
    });
    expect(harness.take("reconciliation").delayMs).toBe(
      config.memoryReconciliationPollMs,
    );
    scheduler.stop();
  });

  it("treats normal reconciliation pagination as successful requeued work", async () => {
    const harness = createScheduleHarness();
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies({
        processReconciliation: vi.fn(async () => ({
          processed: true as const,
          status: "requeued",
          operationalStatus: "ok" as const,
        })),
      }),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().reconciliation).toMatchObject({
        lastProcessedAt: expect.any(String),
        lastSuccessfulAt: expect.any(String),
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
      });
    });
    expect(harness.take("reconciliation").delayMs).toBe(0);
    scheduler.stop();
  });

  it("uses lane-specific idle polling intervals and truthful idle snapshots", async () => {
    const harness = createScheduleHarness();
    const scheduler = startConversationWorkerLoops(config, {
      ...noWorkDependencies(),
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(6));
    expect(
      Object.fromEntries(harness.pending.map(({ lane, delayMs }) => [lane, delayMs])),
    ).toEqual({
      conversation: 500,
      memoryExtraction: 500,
      projectionWrite: 700,
      projectionDelete: 700,
      cleanup: 900,
      reconciliation: 1_200,
    });
    expect(scheduler.snapshot().cleanup).toEqual({
      enabled: true,
      active: false,
      activeSince: null,
      lastAttemptAt: expect.any(String),
      lastCompletedAt: expect.any(String),
      lastSuccessfulAt: expect.any(String),
      lastProcessedAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      failureOrigin: null,
    });
    scheduler.stop();
  });

  it("cancels timers and never reschedules a tick that settles after stop", async () => {
    const harness = createScheduleHarness();
    let resolveReconciliation:
      | ((result: ConversationWorkerLaneWorkResult) => void)
      | undefined;
    const reconciliationPending = new Promise<ConversationWorkerLaneWorkResult>(
      (resolve) => {
        resolveReconciliation = resolve;
      },
    );
    const dependencies = noWorkDependencies({
      processReconciliation: vi.fn(() => reconciliationPending),
    });
    const scheduler = startConversationWorkerLoops(config, {
      ...dependencies,
      schedule: harness.schedule,
      clearSchedule: harness.clearSchedule,
    });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(5));
    const callbacks = harness.pending.map((entry) => entry.callback);
    scheduler.stop();
    expect(harness.clearSchedule).toHaveBeenCalledTimes(5);

    for (const callback of callbacks) callback();
    resolveReconciliation?.({ processed: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dependencies.processConversation).toHaveBeenCalledTimes(1);
    expect(dependencies.processMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(dependencies.processProjectionWrite).toHaveBeenCalledTimes(1);
    expect(dependencies.processProjectionDelete).toHaveBeenCalledTimes(1);
    expect(dependencies.processCleanup).toHaveBeenCalledTimes(1);
    expect(dependencies.processReconciliation).toHaveBeenCalledTimes(1);
    expect(harness.pending).toHaveLength(5);
  });
});
