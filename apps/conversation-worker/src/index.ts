import "dotenv/config";

import { createServer } from "node:http";

import {
  resolveConversationWorkerConfig,
  resolveConversationWorkerModelReadiness,
} from "./config";
import { startConversationWorkerLoops } from "./scheduler";

const config = resolveConversationWorkerConfig();
const modelRuntime = resolveConversationWorkerModelReadiness();
let scheduler: ReturnType<typeof startConversationWorkerLoops> | null = null;

const server = createServer((request, response) => {
  if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
    const lanes = scheduler?.snapshot() ?? {
      memory: { active: false, lastProcessedAt: null, lastError: null },
      conversation: { active: false, lastProcessedAt: null, lastError: null },
    };
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({
      status: modelRuntime.state === "ready" ? "ok" : "degraded",
      service: "conversation-worker",
      active: lanes.memory.active || lanes.conversation.active,
      lastProcessedAt: latestTimestamp(
        lanes.memory.lastProcessedAt,
        lanes.conversation.lastProcessedAt,
      ),
      lastError: lanes.memory.lastError ?? lanes.conversation.lastError,
      lanes,
      modelRuntime,
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`conversation-worker listening on http://0.0.0.0:${config.port}`);
  if (modelRuntime.state !== "ready") {
    console.warn(`conversation-worker model runtime degraded: ${modelRuntime.state}`);
  }
});

scheduler = startConversationWorkerLoops(config);

function latestTimestamp(
  first: string | null,
  second: string | null,
): string | null {
  if (!first) return second;
  if (!second) return first;
  return first > second ? first : second;
}
