import * as webData from "@delegate/web-data";

import {
  conversationWorkerMemoryLoopDefaults,
  type ConversationWorkerConfig,
} from "./config";
import { processNextConversationWork } from "./processor";

type ConversationWorkResult = Awaited<
  ReturnType<typeof processNextConversationWork>
>;

type ScheduleHandle = ReturnType<typeof setTimeout>;

export const conversationWorkerLaneNames = [
  "conversation",
  "memoryExtraction",
  "projectionWrite",
  "projectionDelete",
  "cleanup",
  "reconciliation",
] as const;

export type ConversationWorkerLaneName =
  (typeof conversationWorkerLaneNames)[number];

export type ConversationWorkerLaneFailureOrigin = "work" | "tick";

export type ConversationWorkerLaneState = {
  enabled: boolean;
  active: boolean;
  activeSince: string | null;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastProcessedAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  failureOrigin: ConversationWorkerLaneFailureOrigin | null;
};

export type ConversationWorkerSchedulerSnapshot = Record<
  ConversationWorkerLaneName,
  ConversationWorkerLaneState
>;

export type ConversationWorkerLaneWorkResult =
  | { processed: false }
  | {
      processed: true;
      status: string;
      errorCode?: string;
      operationalStatus?: "ok" | "retrying" | "failed";
      operationalErrorCode?: string;
    };

type MemoryWorkerExports = {
  runNextMemoryProjectionWrite?: () => Promise<ConversationWorkerLaneWorkResult>;
  runNextMemoryProjectionDeletion?: () => Promise<ConversationWorkerLaneWorkResult>;
  runNextMemoryDeletionCleanup?: () => Promise<ConversationWorkerLaneWorkResult>;
  runNextMemoryReconciliation?: () => Promise<ConversationWorkerLaneWorkResult>;
};

const memoryWorkerExports = webData as typeof webData & MemoryWorkerExports;

export type ConversationWorkerSchedulerDependencies = {
  processConversation?: (
    config: ConversationWorkerConfig,
  ) => Promise<ConversationWorkResult>;
  processMemoryExtraction?: () => Promise<ConversationWorkerLaneWorkResult>;
  /** @deprecated Use processMemoryExtraction. */
  processMemory?: () => Promise<ConversationWorkerLaneWorkResult>;
  processProjectionWrite?: () => Promise<ConversationWorkerLaneWorkResult>;
  processProjectionDelete?: () => Promise<ConversationWorkerLaneWorkResult>;
  processCleanup?: () => Promise<ConversationWorkerLaneWorkResult>;
  processReconciliation?: () => Promise<ConversationWorkerLaneWorkResult>;
  schedule?: (
    callback: () => void,
    delayMs: number,
    lane: ConversationWorkerLaneName,
  ) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
  now?: () => Date;
};

export type ConversationWorkerScheduler = {
  stop(): void;
  snapshot(): ConversationWorkerSchedulerSnapshot;
};

type LaneControl = {
  start(): void;
  stop(): void;
};

type LaneTickClassification = {
  processed: boolean;
  outcome: "idle" | "succeeded" | "failed";
  errorCode: string | null;
};

const failedWorkStatuses = new Set([
  "failed",
  "retrying",
  "lease_lost",
]);

const laneErrorCodes: Record<ConversationWorkerLaneName, string> = {
  conversation: "conversation_worker_tick_failed",
  memoryExtraction: "memory_extraction_tick_failed",
  projectionWrite: "memory_projection_write_tick_failed",
  projectionDelete: "memory_projection_delete_tick_failed",
  cleanup: "memory_cleanup_tick_failed",
  reconciliation: "memory_reconciliation_tick_failed",
};

/**
 * Every lane owns its promise chain and timer. In particular, projection
 * writes never share a wait boundary with projection deletion or cleanup, so
 * a slow provider write cannot delay recall withdrawal or proof completion.
 */
export function startConversationWorkerLoops(
  config: ConversationWorkerConfig,
  dependencies: ConversationWorkerSchedulerDependencies = {},
): ConversationWorkerScheduler {
  const schedule = dependencies.schedule
    ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearSchedule = dependencies.clearSchedule
    ?? ((handle) => clearTimeout(handle));
  const now = dependencies.now ?? (() => new Date());
  const state = createSchedulerSnapshot();
  let stopped = false;

  const processMemoryExtraction = dependencies.processMemoryExtraction
    ?? dependencies.processMemory
    ?? (() => webData.processNextMemoryExtractionWork());
  const processProjectionWrite = dependencies.processProjectionWrite
    ?? (() => invokeMemoryWorker("runNextMemoryProjectionWrite"));
  const processProjectionDelete = dependencies.processProjectionDelete
    ?? (() => invokeMemoryWorker("runNextMemoryProjectionDeletion"));
  const processCleanup = dependencies.processCleanup
    ?? (() => invokeMemoryWorker("runNextMemoryDeletionCleanup"));
  const processReconciliation = dependencies.processReconciliation
    ?? (() => invokeMemoryWorker("runNextMemoryReconciliation"));
  const processConversation = dependencies.processConversation
    ?? processNextConversationWork;

  const controls: LaneControl[] = [
    startLane({
      name: "conversation",
      state: state.conversation,
      pollMs: config.pollMs,
      tick: () => processConversation(config),
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
    startLane({
      name: "memoryExtraction",
      state: state.memoryExtraction,
      pollMs: config.pollMs,
      tick: processMemoryExtraction,
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
    startLane({
      name: "projectionWrite",
      state: state.projectionWrite,
      pollMs: config.memoryProjectionPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryProjectionPollMs,
      tick: processProjectionWrite,
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
    startLane({
      name: "projectionDelete",
      state: state.projectionDelete,
      pollMs: config.memoryProjectionPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryProjectionPollMs,
      tick: processProjectionDelete,
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
    startLane({
      name: "cleanup",
      state: state.cleanup,
      pollMs: config.memoryCleanupPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryCleanupPollMs,
      tick: processCleanup,
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
    startLane({
      name: "reconciliation",
      state: state.reconciliation,
      pollMs: config.memoryReconciliationPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryReconciliationPollMs,
      tick: processReconciliation,
      schedule,
      clearSchedule,
      now,
      isStopped: () => stopped,
    }),
  ];

  for (const control of controls) control.start();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const control of controls) control.stop();
    },
    snapshot() {
      return cloneSchedulerSnapshot(state);
    },
  };
}

function startLane(input: {
  name: ConversationWorkerLaneName;
  state: ConversationWorkerLaneState;
  pollMs: number;
  tick: () => Promise<ConversationWorkerLaneWorkResult>;
  schedule: NonNullable<ConversationWorkerSchedulerDependencies["schedule"]>;
  clearSchedule: NonNullable<ConversationWorkerSchedulerDependencies["clearSchedule"]>;
  now: () => Date;
  isStopped: () => boolean;
}): LaneControl {
  let timer: ScheduleHandle | null = null;

  const scheduleNext = (delayMs: number) => {
    if (input.isStopped() || !input.state.enabled) return;
    timer = input.schedule(() => {
      timer = null;
      void run();
    }, delayMs, input.name);
  };

  const run = async () => {
    if (input.isStopped() || !input.state.enabled || input.state.active) return;

    const attemptedAt = input.now().toISOString();
    input.state.active = true;
    input.state.activeSince = attemptedAt;
    input.state.lastAttemptAt = attemptedAt;
    let nextDelayMs = input.pollMs;

    try {
      const result = await input.tick();
      const completedAt = input.now().toISOString();
      const classification = classifyWorkResult(input.name, result);
      input.state.lastCompletedAt = completedAt;

      if (classification.outcome === "succeeded") {
        input.state.lastSuccessfulAt = completedAt;
        if (classification.processed) {
          input.state.lastProcessedAt = completedAt;
          nextDelayMs = 0;
        }
        input.state.consecutiveFailures = 0;
        input.state.lastErrorCode = null;
        input.state.failureOrigin = null;
      } else if (classification.outcome === "failed") {
        input.state.lastFailureAt = completedAt;
        input.state.consecutiveFailures += 1;
        input.state.lastErrorCode = classification.errorCode;
        input.state.failureOrigin = "work";
      } else if (input.state.failureOrigin !== "work") {
        // An idle poll proves the lane can reach its work source and is enough
        // to finish startup or recover from a transient tick/source exception.
        // It must not erase a work-item failure while that item is waiting for
        // its real recovery tick.
        input.state.lastSuccessfulAt = completedAt;
        input.state.consecutiveFailures = 0;
        input.state.lastErrorCode = null;
        input.state.failureOrigin = null;
      }
    } catch {
      const completedAt = input.now().toISOString();
      input.state.lastCompletedAt = completedAt;
      input.state.lastFailureAt = completedAt;
      input.state.consecutiveFailures += 1;
      // Never let a later source exception hide an unresolved work-item
      // failure. A subsequent idle probe may clear only a tick-origin failure.
      if (input.state.failureOrigin !== "work") {
        input.state.lastErrorCode = laneErrorCodes[input.name];
        input.state.failureOrigin = "tick";
      }
    } finally {
      input.state.active = false;
      input.state.activeSince = null;
      scheduleNext(nextDelayMs);
    }
  };

  return {
    start() {
      if (input.state.enabled) void run();
    },
    stop() {
      if (timer !== null) input.clearSchedule(timer);
      timer = null;
    },
  };
}

function classifyWorkResult(
  lane: ConversationWorkerLaneName,
  result: ConversationWorkerLaneWorkResult,
): LaneTickClassification {
  if (!result.processed) {
    return { processed: false, outcome: "idle", errorCode: null };
  }
  if (
    result.operationalStatus === "retrying"
    || result.operationalStatus === "failed"
  ) {
    return {
      processed: true,
      outcome: "failed",
      errorCode: sanitizeErrorCode(
        result.operationalErrorCode,
        laneErrorCodes[lane],
      ),
    };
  }
  if (!failedWorkStatuses.has(result.status)) {
    return { processed: true, outcome: "succeeded", errorCode: null };
  }
  return {
    processed: true,
    outcome: "failed",
    errorCode: sanitizeErrorCode(result.errorCode, laneErrorCodes[lane]),
  };
}

function sanitizeErrorCode(value: string | undefined, fallback: string): string {
  return value && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : fallback;
}

async function invokeMemoryWorker(
  exportName: keyof MemoryWorkerExports,
): Promise<ConversationWorkerLaneWorkResult> {
  const worker = memoryWorkerExports[exportName];
  if (!worker) throw new Error("Memory worker export is unavailable.");
  return worker();
}

function createSchedulerSnapshot(): ConversationWorkerSchedulerSnapshot {
  return {
    conversation: emptyLaneState(),
    memoryExtraction: emptyLaneState(),
    projectionWrite: emptyLaneState(),
    projectionDelete: emptyLaneState(),
    cleanup: emptyLaneState(),
    reconciliation: emptyLaneState(),
  };
}

export function emptyConversationWorkerLaneState(
  enabled = true,
): ConversationWorkerLaneState {
  return emptyLaneState(enabled);
}

function emptyLaneState(enabled = true): ConversationWorkerLaneState {
  return {
    enabled,
    active: false,
    activeSince: null,
    lastAttemptAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastProcessedAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    failureOrigin: null,
  };
}

function cloneSchedulerSnapshot(
  state: ConversationWorkerSchedulerSnapshot,
): ConversationWorkerSchedulerSnapshot {
  return {
    conversation: { ...state.conversation },
    memoryExtraction: { ...state.memoryExtraction },
    projectionWrite: { ...state.projectionWrite },
    projectionDelete: { ...state.projectionDelete },
    cleanup: { ...state.cleanup },
    reconciliation: { ...state.reconciliation },
  };
}
