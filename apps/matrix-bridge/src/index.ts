import "dotenv/config";

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  getMatrixVirtualUserBinding,
  ingestMatrixApplicationServiceTransaction,
  type MatrixApplicationServiceEvent,
} from "@delegate/web-data";

import { resolveMatrixBridgeConfig } from "./config";

const config = resolveMatrixBridgeConfig();

const server = createServer(async (request, response) => {
  try {
    if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
      return json(response, 200, request.method === "HEAD" ? undefined : { status: "ok", service: "matrix-bridge" });
    }

    if (!isHomeserverAuthorized(request)) {
      return json(response, 403, { errcode: "M_FORBIDDEN", error: "Invalid Matrix homeserver token." });
    }

    const url = new URL(request.url || "/", "http://matrix-bridge.local");
    const transactionMatch = url.pathname.match(/^\/_matrix\/app\/v1\/transactions\/([^/]+)$/);
    if (request.method === "PUT" && transactionMatch?.[1]) {
      const body = await readJsonBody(request);
      const events = Array.isArray(body.events)
        ? body.events.filter(isMatrixEvent)
        : [];
      await ingestMatrixApplicationServiceTransaction({
        transactionId: decodeURIComponent(transactionMatch[1]),
        events,
      });
      return json(response, 200, {});
    }

    const userMatch = url.pathname.match(/^\/_matrix\/app\/v1\/users\/(.+)$/);
    if (request.method === "GET" && userMatch?.[1]) {
      const binding = await getMatrixVirtualUserBinding(decodeURIComponent(userMatch[1]));
      return binding
        ? json(response, 200, {})
        : json(response, 404, { errcode: "M_NOT_FOUND", error: "Virtual user is not registered." });
    }

    if (request.method === "POST" && url.pathname === "/_matrix/app/v1/ping") {
      return json(response, 200, {});
    }

    return json(response, 404, { errcode: "M_NOT_FOUND", error: "Route not found." });
  } catch (error) {
    console.error("matrix-bridge request failed", error);
    return json(response, 500, {
      errcode: "M_UNKNOWN",
      error: error instanceof Error ? error.message : "Matrix bridge request failed.",
    });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`matrix-bridge listening on http://0.0.0.0:${config.port}`);
});

function isHomeserverAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : new URL(request.url || "/", "http://matrix-bridge.local").searchParams.get("access_token")?.trim();
  if (!token) return false;

  const expected = Buffer.from(config.homeserverToken);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > config.maxBodyBytes) throw new Error("Matrix transaction body is too large.");
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Matrix transaction body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function isMatrixEvent(value: unknown): value is MatrixApplicationServiceEvent {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(payload === undefined ? undefined : JSON.stringify(payload));
}
