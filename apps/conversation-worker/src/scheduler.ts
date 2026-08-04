import {
  processNextMemoryExtractionWork,
  type MemoryExtractionWorkResult,
} from "@delegate/web-data";

import type { ConversationWorkerConfig } from "./config";
import { processNextConversationWork } from "./processor";

type ConversationWorkResult = Awaited<
  ReturnType<typeof processNextConversationWork>
>;

type ScheduleHandle = ReturnType<typeof setTimeout>;

export type ConversationWorkerLoopState = {
  active: boolean;
  lastProcessedAt: string | null;
  lastError: string | null;
};

export type ConversationWorkerSchedulerSnapshot = {
  memory: ConversationWorkerLoopState;
  conversation: ConversationWorkerLoopState;
};

export type ConversationWorkerSchedulerDependencies = {
  processMemory?: () => Promise<MemoryExtractionWorkResult>;
  processConversation?: (
    config: ConversationWorkerConfig,
  ) => Promise<ConversationWorkResult>;
  schedule?: (callback: () => void, delayMs: number) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
  now?: () => Date;
};

export type ConversationWorkerScheduler = {
  stop(): void;
  snapshot(): ConversationWorkerSchedulerSnapshot;
};

/**
 * Memory extraction and conversation generation deliberately use separate
 * self-scheduling loops. A model call may take minutes or never resolve; it
 * must not hold the deterministic memory queue behind a shared Promise.
 */
export function startConversationWorkerLoops(
  config: ConversationWorkerConfig,
  dependencies: ConversationWorkerSchedulerDependencies = {},
): ConversationWorkerScheduler {
  const processMemory =
    dependencies.processMemory ?? processNextMemoryExtractionWork;
  const processConversation =
    dependencies.processConversation ?? processNextConversationWork;
  const schedule = dependencies.schedule
    ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearSchedule = dependencies.clearSchedule
    ?? ((handle) => clearTimeout(handle));
  const now = dependencies.now ?? (() => new Date());
  const state: ConversationWorkerSchedulerSnapshot = {
    memory: emptyLoopState(),
    conversation: emptyLoopState(),
  };
  let stopped = false;
  let memoryTimer: ScheduleHandle | null = null;
  let conversationTimer: ScheduleHandle | null = null;

  const scheduleMemory = () => {
    if (stopped) return;
    memoryTimer = schedule(() => void runMemory(), config.pollMs);
  };
  const scheduleConversation = () => {
    if (stopped) return;
    conversationTimer = schedule(() => void runConversation(), config.pollMs);
  };

  const runMemory = async () => {
    if (stopped || state.memory.active) return;
    state.memory.active = true;
    try {
      const result = await processMemory();
      if (result.processed) state.memory.lastProcessedAt = now().toISOString();
      state.memory.lastError = memoryFailureCode(result);
    } catch {
      state.memory.lastError = "memory_extraction_tick_failed";
    } finally {
      state.memory.active = false;
      scheduleMemory();
    }
  };

  const runConversation = async () => {
    if (stopped || state.conversation.active) return;
    state.conversation.active = true;
    try {
      const result = await processConversation(config);
      if (result.processed) {
        state.conversation.lastProcessedAt = now().toISOString();
      }
      state.conversation.lastError =
        result.processed && result.status === "failed"
          ? "conversation_work_failed"
          : null;
    } catch {
      state.conversation.lastError = "conversation_worker_tick_failed";
    } finally {
      state.conversation.active = false;
      scheduleConversation();
    }
  };

  void runMemory();
  void runConversation();

  return {
    stop() {
      stopped = true;
      if (memoryTimer) clearSchedule(memoryTimer);
      if (conversationTimer) clearSchedule(conversationTimer);
      memoryTimer = null;
      conversationTimer = null;
    },
    snapshot() {
      return {
        memory: { ...state.memory },
        conversation: { ...state.conversation },
      };
    },
  };
}

function emptyLoopState(): ConversationWorkerLoopState {
  return { active: false, lastProcessedAt: null, lastError: null };
}

function memoryFailureCode(result: MemoryExtractionWorkResult): string | null {
  if (!result.processed) return null;
  if (result.status !== "failed" && result.status !== "retrying") return null;
  return result.errorCode ?? "memory_extraction_processing_failed";
}
