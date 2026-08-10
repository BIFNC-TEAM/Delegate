import { describe, expect, it } from "vitest";

import type { ConversationWorkerModelReadiness } from "../src/config";
import {
  buildConversationWorkerReadiness,
  type ConversationWorkerLaneTiming,
} from "../src/health";
import {
  conversationWorkerLaneNames,
  emptyConversationWorkerLaneState,
  type ConversationWorkerLaneName,
  type ConversationWorkerLaneState,
  type ConversationWorkerSchedulerSnapshot,
} from "../src/scheduler";

const now = new Date("2026-08-04T08:00:00.000Z");
const readyModel: ConversationWorkerModelReadiness = {
  state: "ready",
  configuredProvider: "openai",
  readyProviders: ["openai"],
};

function readyLane(
  overrides: Partial<ConversationWorkerLaneState> = {},
): ConversationWorkerLaneState {
  return {
    ...emptyConversationWorkerLaneState(),
    lastAttemptAt: "2026-08-04T07:59:55.000Z",
    lastCompletedAt: "2026-08-04T07:59:55.000Z",
    lastSuccessfulAt: "2026-08-04T07:59:55.000Z",
    ...overrides,
  };
}

function readyLanes(): ConversationWorkerSchedulerSnapshot {
  return {
    conversation: readyLane(),
    memoryExtraction: readyLane(),
    memoryLifecycle: readyLane(),
    projectionWrite: readyLane(),
    projectionDelete: readyLane(),
    cleanup: readyLane(),
    reconciliation: readyLane(),
  };
}

function laneTimings(
  overrides: Partial<
    Record<ConversationWorkerLaneName, ConversationWorkerLaneTiming>
  > = {},
): Record<ConversationWorkerLaneName, ConversationWorkerLaneTiming> {
  return Object.fromEntries(
    conversationWorkerLaneNames.map((name) => [
      name,
      overrides[name] ?? { pollMs: 500, tickTimeoutMs: 60_000 },
    ]),
  ) as Record<ConversationWorkerLaneName, ConversationWorkerLaneTiming>;
}

describe("conversation worker readiness", () => {
  it("is ready only after every enabled lane and the database have succeeded", () => {
    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: true,
      modelRuntime: readyModel,
      lanes: readyLanes(),
      laneTimings: laneTimings(),
      minimumStaleAfterMs: 180_000,
    });

    expect(snapshot).toMatchObject({
      status: "ready",
      reasons: [],
      databaseReady: true,
    });
    for (const lane of conversationWorkerLaneNames) {
      expect(snapshot.lanes[lane].status).toBe("ready");
    }
  });

  it("attributes unavailable model credentials only to conversation", () => {
    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: true,
      modelRuntime: {
        state: "missing_credentials",
        configuredProvider: "bailian",
        readyProviders: [],
      },
      lanes: readyLanes(),
      laneTimings: laneTimings(),
      minimumStaleAfterMs: 180_000,
    });

    expect(snapshot.status).toBe("not_ready");
    expect(snapshot.reasons).toEqual([
      "conversation_model_missing_credentials",
    ]);
    expect(snapshot.lanes.conversation.status).toBe("failed");
    for (const lane of conversationWorkerLaneNames.filter(
      (name) => name !== "conversation",
    )) {
      expect(snapshot.lanes[lane].status).toBe("ready");
    }
  });

  it("reports every failed, stale, starting, and database reason without raw errors", () => {
    const lanes = readyLanes();
    lanes.memoryExtraction = readyLane({
      lastFailureAt: "2026-08-04T07:59:59.000Z",
      consecutiveFailures: 1,
      lastErrorCode: "private database detail",
      failureOrigin: "tick",
    });
    lanes.projectionWrite = readyLane({
      lastSuccessfulAt: "2026-08-04T07:00:00.000Z",
    });
    lanes.cleanup = readyLane({
      active: true,
      activeSince: "2026-08-04T07:58:00.000Z",
    });
    lanes.reconciliation = emptyConversationWorkerLaneState(false);

    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: false,
      modelRuntime: readyModel,
      lanes,
      laneTimings: laneTimings(),
      minimumStaleAfterMs: 90_000,
    });

    expect(snapshot).toMatchObject({
      status: "not_ready",
      reasons: [
        "database_unavailable",
        "memory_extraction_lane_failed",
        "projection_write_lane_stale",
        "cleanup_lane_stale",
      ],
      lanes: {
        memoryExtraction: { status: "failed", failureOrigin: "tick" },
        projectionWrite: { status: "stale" },
        cleanup: { status: "stale" },
        reconciliation: { status: "disabled" },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private database");
  });

  it("derives staleness independently from each lane poll and tick timeout", () => {
    const lanes = readyLanes();
    lanes.projectionWrite = readyLane({
      lastSuccessfulAt: "2026-08-04T07:56:40.000Z",
    });
    lanes.reconciliation = readyLane({
      lastSuccessfulAt: "2026-08-04T07:56:40.000Z",
    });
    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: true,
      modelRuntime: readyModel,
      lanes,
      laneTimings: laneTimings({
        projectionWrite: { pollMs: 500, tickTimeoutMs: 60_000 },
        reconciliation: { pollMs: 60_000, tickTimeoutMs: 60_000 },
      }),
      minimumStaleAfterMs: 30_000,
    });

    expect(snapshot.lanes.projectionWrite).toMatchObject({
      status: "stale",
      staleAfterMs: 61_500,
    });
    expect(snapshot.lanes.reconciliation).toMatchObject({
      status: "ready",
      staleAfterMs: 240_000,
    });
  });

  it("keeps readiness false for a recorded reconciliation provider failure", () => {
    const lanes = readyLanes();
    lanes.reconciliation = readyLane({
      lastFailureAt: "2026-08-04T07:59:59.000Z",
      consecutiveFailures: 1,
      lastErrorCode: "reconciliation_provider_retryable",
      failureOrigin: "work",
    });

    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: true,
      modelRuntime: readyModel,
      lanes,
      laneTimings: laneTimings(),
      minimumStaleAfterMs: 180_000,
    });

    expect(snapshot).toMatchObject({
      status: "not_ready",
      reasons: ["reconciliation_provider_retryable"],
      lanes: {
        reconciliation: { status: "failed", failureOrigin: "work" },
      },
    });
  });

  it("distinguishes an initial tick from normal running work", () => {
    const lanes = readyLanes();
    lanes.memoryExtraction = {
      ...emptyConversationWorkerLaneState(),
      active: true,
      activeSince: "2026-08-04T07:59:59.000Z",
      lastAttemptAt: "2026-08-04T07:59:59.000Z",
    };
    lanes.projectionDelete = readyLane({
      active: true,
      activeSince: "2026-08-04T07:59:59.000Z",
      lastAttemptAt: "2026-08-04T07:59:59.000Z",
    });

    const snapshot = buildConversationWorkerReadiness({
      now,
      databaseReady: true,
      modelRuntime: readyModel,
      lanes,
      laneTimings: laneTimings(),
      minimumStaleAfterMs: 180_000,
    });

    expect(snapshot.lanes.memoryExtraction.status).toBe("starting");
    expect(snapshot.reasons).toEqual(["memory_extraction_lane_starting"]);
    expect(snapshot.lanes.projectionDelete.status).toBe("running");
  });
});
