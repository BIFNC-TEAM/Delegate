import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  brokerHealthSchema,
  heartbeatComputeSessionRequestSchema,
  nativeComputerUsePreflightResponseSchema,
  resolveApprovalRequestSchema,
  terminateComputeSessionRequestSchema,
} from "@delegate/compute-protocol";
import { computeBrokerConfig } from "./config";
import { startApprovedExecutionLoop } from "./approved-execution-loop";
import { startMcpCatalogRefreshLoop } from "./mcp-catalog-refresh";
import {
  executeTool,
  listSessionApprovals,
  listSessionArtifacts,
  resolveApproval,
} from "./executions";
export { syncRepresentativeMcpToolDefinitions } from "./mcp-tool-definitions";
export { enqueueActionExecutionAttempt } from "./action-execution-attempts";
export { persistVerifiedActionResult } from "./verified-action-results";
import { getNativeComputerUsePreflight } from "./native-browser";
import { toPublicBrokerError } from "./public-error";
import {
  createComputeSession,
  getComputeSession,
  heartbeatComputeSession,
  terminateComputeSession,
} from "./sessions";
import { startSandboxLeaseCleanupLoop } from "./sandbox-leases";
import { getSandboxMetricSnapshot } from "./sandbox-metrics";

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if ((method === "GET" || method === "HEAD") && url.pathname === "/health") {
      return sendJson(
        response,
        200,
        brokerHealthSchema.parse({
          status: "ok",
          service: "compute-broker",
          runnerType: computeBrokerConfig.runnerType,
          sandboxProvider: computeBrokerConfig.sandboxProvider,
          artifactBucket: computeBrokerConfig.artifactStore.bucket,
        }),
      );
    }

    if (!isAuthorized(request.headers.authorization)) {
      return sendJson(response, 401, {
        error: "unauthorized",
      });
    }

    if (
      method === "GET" &&
      url.pathname === "/internal/compute/sandbox/metrics"
    ) {
      return sendJson(response, 200, getSandboxMetricSnapshot());
    }

    if (method === "POST" && url.pathname === "/internal/compute/sessions") {
      const body = await readJson(request);
      const created = await createComputeSession(body);
      return sendJson(response, 201, created);
    }

    const segments = url.pathname.split("/").filter(Boolean);

    if (
      method === "GET" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "browser-native" &&
      segments[3] === "preflight"
    ) {
      const sessionId = url.searchParams.get("sessionId");
      const preflight = await getNativeComputerUsePreflight(sessionId);
      return sendJson(response, 200, nativeComputerUsePreflightResponseSchema.parse(preflight));
    }

    if (
      method === "POST" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "sessions" &&
      segments[3] &&
      segments[4] === "executions"
    ) {
      const sessionId = segments[3];
      const body = await readJson(request);
      const result = await executeTool(sessionId, body);
      return sendJson(response, 200, result);
    }

    if (
      method === "POST" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "approvals" &&
      segments[3] &&
      segments[4] === "resolve"
    ) {
      const approvalId = segments[3];
      const body = resolveApprovalRequestSchema.parse(await readJson(request));
      const result = await resolveApproval(approvalId, body);
      return sendJson(response, 200, result);
    }

    if (
      method === "POST" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "sessions" &&
      segments[3] &&
      segments[4] === "heartbeat"
    ) {
      const sessionId = segments[3];
      const body = heartbeatComputeSessionRequestSchema.parse(await readJson(request));
      const session = await heartbeatComputeSession(sessionId, body.reason);
      return sendJson(response, 200, { session });
    }

    if (
      method === "GET" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "sessions" &&
      segments[3] &&
      segments[4] === "artifacts"
    ) {
      const sessionId = segments[3];
      const artifacts = await listSessionArtifacts(sessionId);
      return sendJson(response, 200, artifacts);
    }

    if (
      method === "GET" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "sessions" &&
      segments[3] &&
      segments[4] === "approvals"
    ) {
      const sessionId = segments[3];
      const approvals = await listSessionApprovals(sessionId);
      return sendJson(response, 200, approvals);
    }

    if (
      method === "GET" &&
      segments[0] === "internal" &&
      segments[1] === "compute" &&
      segments[2] === "sessions" &&
      segments[3] &&
      segments.length === 4
    ) {
      const sessionId = segments[3];
      if (!sessionId) {
        return sendJson(response, 400, { error: "missing_session_id" });
      }
      const session = await getComputeSession(sessionId);
      return sendJson(response, 200, { session });
    }

    if (method === "POST" && url.pathname.endsWith("/terminate")) {
      const sessionId = segments.at(-2);
      if (!sessionId) {
        return sendJson(response, 400, { error: "missing_session_id" });
      }
      const body = terminateComputeSessionRequestSchema.parse(await readJson(request));
      const session = await terminateComputeSession(sessionId, body.reason);
      return sendJson(response, 200, { session });
    }

    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const publicError = toPublicBrokerError(error);
    if (publicError.logPrivateDetail) {
      console.error("compute_broker_request_failed", error);
    }
    return sendJson(response, publicError.statusCode, { error: publicError.code });
  }
});

server.listen(computeBrokerConfig.port, "0.0.0.0", () => {
  console.log(`compute-broker listening on http://0.0.0.0:${computeBrokerConfig.port}`);
});

const sandboxCleanupTimer = startSandboxLeaseCleanupLoop({
  intervalMs: computeBrokerConfig.sandboxLifecycle.cleanupIntervalMs,
  idleStopMinutes: computeBrokerConfig.sandboxLifecycle.idleStopMinutes,
});

const stopApprovedExecutionLoop = startApprovedExecutionLoop();
const stopMcpCatalogRefreshLoop = startMcpCatalogRefreshLoop({
  intervalMs: computeBrokerConfig.mcpCatalogRefreshIntervalMs,
});
let backgroundLoopsStopped = false;

export function stopComputeBrokerBackgroundLoops() {
  if (backgroundLoopsStopped) return;
  backgroundLoopsStopped = true;
  clearInterval(sandboxCleanupTimer);
  stopApprovedExecutionLoop();
  stopMcpCatalogRefreshLoop();
}

server.once("close", stopComputeBrokerBackgroundLoops);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopComputeBrokerBackgroundLoops();
    server.close((error) => {
      if (error) {
        console.error("compute_broker_shutdown_failed", error);
        process.exitCode = 1;
      }
    });
  });
}

function isAuthorized(authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return false;
  }

  return authorizationHeader.slice("Bearer ".length) === computeBrokerConfig.internalToken;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (response.req.method === "HEAD") {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}
