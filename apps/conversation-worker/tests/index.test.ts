import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import type {
  ConversationWorkerConfig,
  ConversationWorkerModelReadiness,
} from "../src/config";
import { createConversationWorkerRequestHandler } from "../src/index";
import {
  emptyConversationWorkerLaneState,
  type ConversationWorkerSchedulerSnapshot,
} from "../src/scheduler";

const config: ConversationWorkerConfig = {
  port: 4040,
  pollMs: 500,
  memoryLifecyclePollMs: 1_000,
  memoryProjectionPollMs: 500,
  memoryCleanupPollMs: 1_000,
  memoryReconciliationPollMs: 60_000,
  memoryTickTimeoutMs: 60_000,
  readinessStaleMs: 180_000,
  outboxProcessingLeaseMs: 5 * 60_000,
};

const readyModel: ConversationWorkerModelReadiness = {
  state: "ready",
  configuredProvider: "openai",
  readyProviders: ["openai"],
};

function readySchedulerSnapshot(): ConversationWorkerSchedulerSnapshot {
  const lane = () => ({
    ...emptyConversationWorkerLaneState(),
    lastAttemptAt: "2026-08-04T07:59:55.000Z",
    lastCompletedAt: "2026-08-04T07:59:55.000Z",
    lastSuccessfulAt: "2026-08-04T07:59:55.000Z",
  });
  return {
    conversation: lane(),
    memoryExtraction: lane(),
    memoryLifecycle: lane(),
    projectionWrite: lane(),
    projectionDelete: lane(),
    cleanup: lane(),
    reconciliation: lane(),
  };
}

async function invokeHandler(
  handler: ReturnType<typeof createConversationWorkerRequestHandler>,
  input: { method?: string; url: string },
): Promise<{
  status: number;
  headers: Map<string, string>;
  body: string;
}> {
  const headers = new Map<string, string>();
  let body = "";
  const request = {
    method: input.method ?? "GET",
    url: input.url,
  } as IncomingMessage;
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return this;
    },
  } as unknown as ServerResponse;

  await handler(request, response);
  return { status: response.statusCode, headers, body };
}

describe("conversation worker probes", () => {
  it("keeps /health a liveness-only 200 without querying dependencies", async () => {
    const checkDatabaseReadiness = vi.fn(async () => false);
    const lanes = readySchedulerSnapshot();
    lanes.cleanup = {
      ...lanes.cleanup,
      consecutiveFailures: 3,
      lastErrorCode: "memory_cleanup_tick_failed",
    };
    const handler = createConversationWorkerRequestHandler({
      config,
      modelRuntime: {
        state: "missing_credentials",
        configuredProvider: "bailian",
        readyProviders: [],
      },
      scheduler: { snapshot: () => lanes },
      checkDatabaseReadiness,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const response = await invokeHandler(handler, { url: "/health" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      service: "conversation-worker",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(checkDatabaseReadiness).not.toHaveBeenCalled();
  });

  it("returns 200 from /ready when the database, model, and all lanes are ready", async () => {
    const handler = createConversationWorkerRequestHandler({
      config,
      modelRuntime: readyModel,
      scheduler: { snapshot: readySchedulerSnapshot },
      checkDatabaseReadiness: vi.fn(async () => true),
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const response = await invokeHandler(handler, { url: "/ready" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "ready",
      service: "conversation-worker",
      reasons: [],
      databaseReady: true,
      lanes: {
        conversation: { status: "ready" },
        memoryExtraction: { status: "ready" },
        memoryLifecycle: { status: "ready" },
        projectionWrite: { status: "ready" },
        projectionDelete: { status: "ready" },
        cleanup: { status: "ready" },
        reconciliation: { status: "ready" },
      },
    });
  });

  it("returns 503 with independent lane truth when DB and model are unavailable", async () => {
    const handler = createConversationWorkerRequestHandler({
      config,
      modelRuntime: {
        state: "missing_credentials",
        configuredProvider: "bailian",
        readyProviders: [],
      },
      scheduler: { snapshot: readySchedulerSnapshot },
      checkDatabaseReadiness: vi.fn(async () => {
        throw new Error("private database endpoint");
      }),
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const response = await invokeHandler(handler, { url: "/ready" });
    expect(response.status).toBe(503);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      status: "not_ready",
      reasons: [
        "database_unavailable",
        "conversation_model_missing_credentials",
      ],
      databaseReady: false,
      lanes: {
        conversation: { status: "failed" },
        memoryExtraction: { status: "ready" },
        memoryLifecycle: { status: "ready" },
        projectionWrite: { status: "ready" },
        projectionDelete: { status: "ready" },
        cleanup: { status: "ready" },
        reconciliation: { status: "ready" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private database");
  });

  it("supports HEAD probes and returns JSON 404 for other routes", async () => {
    const handler = createConversationWorkerRequestHandler({
      config,
      modelRuntime: readyModel,
      scheduler: { snapshot: readySchedulerSnapshot },
      checkDatabaseReadiness: vi.fn(async () => true),
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const head = await invokeHandler(handler, {
      method: "HEAD",
      url: "/health",
    });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    const missing = await invokeHandler(handler, { url: "/missing" });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not_found" });
  });
});
