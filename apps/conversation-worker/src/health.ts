import type { ConversationWorkerModelReadiness } from "./config";
import {
  conversationWorkerLaneNames,
  type ConversationWorkerLaneName,
  type ConversationWorkerLaneState,
  type ConversationWorkerSchedulerSnapshot,
} from "./scheduler";

export type ConversationWorkerLaneTiming = {
  pollMs: number;
  tickTimeoutMs: number;
};

export type ConversationWorkerLaneReadinessStatus =
  | "disabled"
  | "starting"
  | "running"
  | "ready"
  | "failed"
  | "stale";

export type ConversationWorkerLaneReadiness = ConversationWorkerLaneState & {
  status: ConversationWorkerLaneReadinessStatus;
  staleAfterMs: number;
};

export type ConversationWorkerReadinessInput = {
  now: Date;
  databaseReady: boolean;
  modelRuntime: ConversationWorkerModelReadiness;
  lanes: ConversationWorkerSchedulerSnapshot;
  laneTimings: Record<ConversationWorkerLaneName, ConversationWorkerLaneTiming>;
  minimumStaleAfterMs: number;
};

export type ConversationWorkerReadinessSnapshot = {
  status: "ready" | "not_ready";
  service: "conversation-worker";
  reasons: string[];
  databaseReady: boolean;
  modelRuntime: ConversationWorkerModelReadiness;
  lanes: Record<ConversationWorkerLaneName, ConversationWorkerLaneReadiness>;
};

/**
 * Readiness describes worker truth, not process liveness. A currently running
 * lane remains ready after a recent success, but an initial, failed, stale, or
 * over-time tick is reported without affecting unrelated lanes.
 */
export function buildConversationWorkerReadiness(
  input: ConversationWorkerReadinessInput,
): ConversationWorkerReadinessSnapshot {
  const reasons: string[] = [];
  if (!input.databaseReady) reasons.push("database_unavailable");

  const lanes = {} as Record<
    ConversationWorkerLaneName,
    ConversationWorkerLaneReadiness
  >;

  for (const name of conversationWorkerLaneNames) {
    const safeState = {
      ...input.lanes[name],
      lastErrorCode: input.lanes[name].lastErrorCode === null
        ? null
        : sanitizeErrorCode(input.lanes[name].lastErrorCode)
          ?? `${laneCode(name)}_lane_failed`,
    };
    const timing = input.laneTimings[name];
    const staleAfterMs = Math.max(
      input.minimumStaleAfterMs,
      timing.tickTimeoutMs + timing.pollMs * 3,
    );
    const status = resolveLaneStatus({
      now: input.now,
      state: safeState,
      staleAfterMs,
      tickTimeoutMs: timing.tickTimeoutMs,
    });
    lanes[name] = {
      ...safeState,
      status,
      staleAfterMs,
    };
    addLaneReason(reasons, name, status, safeState);
  }

  if (input.modelRuntime.state !== "ready") {
    reasons.push(`conversation_model_${input.modelRuntime.state}`);
    if (
      lanes.conversation.status === "ready"
      || lanes.conversation.status === "running"
    ) {
      lanes.conversation.status = "failed";
    }
  }

  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    service: "conversation-worker",
    reasons: [...new Set(reasons)],
    databaseReady: input.databaseReady,
    modelRuntime: input.modelRuntime,
    lanes,
  };
}

function resolveLaneStatus(input: {
  now: Date;
  state: ConversationWorkerLaneState;
  staleAfterMs: number;
  tickTimeoutMs: number;
}): ConversationWorkerLaneReadinessStatus {
  if (!input.state.enabled) return "disabled";

  if (input.state.active) {
    const activeAgeMs = timestampAge(input.now, input.state.activeSince);
    if (activeAgeMs === null || activeAgeMs > input.tickTimeoutMs) {
      return "stale";
    }
  }

  if (
    input.state.consecutiveFailures > 0
    || input.state.lastErrorCode !== null
  ) {
    return "failed";
  }

  const successfulAgeMs = timestampAge(
    input.now,
    input.state.lastSuccessfulAt,
  );
  if (successfulAgeMs === null) return "starting";
  if (successfulAgeMs > input.staleAfterMs) return "stale";
  return input.state.active ? "running" : "ready";
}

function timestampAge(now: Date, value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  const ageMs = now.getTime() - timestamp;
  if (!Number.isFinite(timestamp) || ageMs < -5_000) return null;
  return ageMs;
}

function addLaneReason(
  reasons: string[],
  name: ConversationWorkerLaneName,
  status: ConversationWorkerLaneReadinessStatus,
  state: ConversationWorkerLaneState,
): void {
  if (status === "disabled" || status === "ready" || status === "running") {
    return;
  }
  if (status === "failed") {
    reasons.push(
      sanitizeErrorCode(state.lastErrorCode)
      ?? `${laneCode(name)}_lane_failed`,
    );
    return;
  }
  reasons.push(`${laneCode(name)}_lane_${status}`);
}

function sanitizeErrorCode(value: string | null): string | null {
  return value && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : null;
}

function laneCode(name: ConversationWorkerLaneName): string {
  return name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}
