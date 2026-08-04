import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prisma } from "@delegate/web-data";

import {
  conversationWorkerMemoryLoopDefaults,
  resolveConversationWorkerConfig,
  resolveConversationWorkerModelReadiness,
  type ConversationWorkerConfig,
  type ConversationWorkerModelReadiness,
} from "./config";
import {
  buildConversationWorkerReadiness,
  type ConversationWorkerLaneTiming,
} from "./health";
import {
  startConversationWorkerLoops,
  type ConversationWorkerLaneName,
  type ConversationWorkerScheduler,
} from "./scheduler";

export type ConversationWorkerHttpDependencies = {
  config: ConversationWorkerConfig;
  modelRuntime: ConversationWorkerModelReadiness;
  scheduler: Pick<ConversationWorkerScheduler, "snapshot">;
  checkDatabaseReadiness?: () => Promise<boolean>;
  now?: () => Date;
};

export function createConversationWorkerRequestHandler(
  dependencies: ConversationWorkerHttpDependencies,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const checkDatabaseReadiness = dependencies.checkDatabaseReadiness
    ?? checkDatabase;
  const now = dependencies.now ?? (() => new Date());

  return async (request, response) => {
    const isProbeMethod = request.method === "GET" || request.method === "HEAD";
    if (isProbeMethod && request.url === "/health") {
      sendJson(request.method, response, 200, {
        status: "ok",
        service: "conversation-worker",
      });
      return;
    }

    if (isProbeMethod && request.url === "/ready") {
      const databaseReady = await checkDatabaseReadiness().catch(() => false);
      const readiness = buildConversationWorkerReadiness({
        now: now(),
        databaseReady,
        modelRuntime: dependencies.modelRuntime,
        lanes: dependencies.scheduler.snapshot(),
        laneTimings: buildLaneTimings(dependencies.config),
        minimumStaleAfterMs: dependencies.config.readinessStaleMs
          ?? conversationWorkerMemoryLoopDefaults.readinessStaleMs,
      });
      sendJson(
        request.method,
        response,
        readiness.status === "ready" ? 200 : 503,
        readiness,
      );
      return;
    }

    sendJson(request.method, response, 404, { error: "not_found" });
  };
}

export function startConversationWorker(): {
  server: ReturnType<typeof createServer>;
  scheduler: ConversationWorkerScheduler;
} {
  const config = resolveConversationWorkerConfig();
  const modelRuntime = resolveConversationWorkerModelReadiness();
  const scheduler = startConversationWorkerLoops(config);
  const handler = createConversationWorkerRequestHandler({
    config,
    modelRuntime,
    scheduler,
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(request.method, response, 500, {
          error: "request_processing_failed",
        });
      } else {
        response.destroy();
      }
    });
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `conversation-worker listening on http://0.0.0.0:${config.port}`,
    );
    if (modelRuntime.state !== "ready") {
      console.warn(
        `conversation-worker model runtime degraded: ${modelRuntime.state}`,
      );
    }
  });

  return { server, scheduler };
}

export function buildLaneTimings(
  config: ConversationWorkerConfig,
): Record<ConversationWorkerLaneName, ConversationWorkerLaneTiming> {
  const memoryTiming = {
    tickTimeoutMs: config.memoryTickTimeoutMs
      ?? conversationWorkerMemoryLoopDefaults.memoryTickTimeoutMs,
  };
  return {
    conversation: {
      pollMs: config.pollMs,
      tickTimeoutMs: config.outboxProcessingLeaseMs ?? 5 * 60_000,
    },
    memoryExtraction: {
      pollMs: config.pollMs,
      ...memoryTiming,
    },
    projectionWrite: {
      pollMs: config.memoryProjectionPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryProjectionPollMs,
      ...memoryTiming,
    },
    projectionDelete: {
      pollMs: config.memoryProjectionPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryProjectionPollMs,
      ...memoryTiming,
    },
    cleanup: {
      pollMs: config.memoryCleanupPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryCleanupPollMs,
      ...memoryTiming,
    },
    reconciliation: {
      pollMs: config.memoryReconciliationPollMs
        ?? conversationWorkerMemoryLoopDefaults.memoryReconciliationPollMs,
      ...memoryTiming,
    },
  };
}

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function sendJson(
  method: string | undefined,
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(method === "HEAD" ? undefined : JSON.stringify(body));
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint
    && import.meta.url === pathToFileURL(resolve(entrypoint)).href,
  );
}

if (isDirectExecution()) startConversationWorker();
