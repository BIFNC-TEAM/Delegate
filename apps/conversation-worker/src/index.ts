import "dotenv/config";

import { createServer } from "node:http";

import { resolveConversationWorkerConfig } from "./config";
import { processNextConversationWork } from "./processor";

const config = resolveConversationWorkerConfig();
let lastProcessedAt: string | null = null;
let lastError: string | null = null;
let active = false;

const server = createServer((request, response) => {
  if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", service: "conversation-worker", active, lastProcessedAt, lastError }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`conversation-worker listening on http://0.0.0.0:${config.port}`);
});

void runLoop();

async function runLoop() {
  try {
    active = true;
    const result = await processNextConversationWork(config);
    if (result.processed) lastProcessedAt = new Date().toISOString();
    lastError = result.processed && result.status === "failed" ? result.error : null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "conversation_worker_tick_failed";
    console.error("conversation worker tick failed", error);
  } finally {
    active = false;
    setTimeout(() => void runLoop(), config.pollMs);
  }
}
