import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const previousInternalToken = process.env.COMPUTE_BROKER_INTERNAL_TOKEN;
const previousMcpTimeout = process.env.COMPUTE_MCP_TIMEOUT_MS;
const previousPrivateEndpointOverride =
  process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;

process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "fault-injection-test-token";
// Leave enough headroom for endpoint validation and SDK setup when the full
// workspace suite is running concurrently. The stalled-endpoint case below
// still proves that the configured timeout is enforced.
process.env.COMPUTE_MCP_TIMEOUT_MS = "1000";
process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = "true";

type FaultServer = {
  origin: string;
  counts: Map<string, number>;
  close: () => Promise<void>;
};

let faultServer: FaultServer | null = null;

beforeAll(async () => {
  faultServer = await startFaultServer();
});

afterAll(async () => {
  await faultServer?.close();
  restoreEnv(
    "COMPUTE_BROKER_INTERNAL_TOKEN",
    previousInternalToken,
  );
  restoreEnv("COMPUTE_MCP_TIMEOUT_MS", previousMcpTimeout);
  restoreEnv(
    "DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS",
    previousPrivateEndpointOverride,
  );
});

describe("remote MCP fault handling", () => {
  it("does not retry a transient 503 because the invocation outcome is uncertain", async () => {
    if (!faultServer) throw new Error("Fault server did not start.");
    const { callRemoteMcpTool, McpTransportError } = await import("../src/mcp");
    const error = await callRemoteMcpTool({
      binding: binding(`${faultServer.origin}/flaky`, {
        maxRetries: 1,
      }),
      toolArguments: { value: "recovered" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpTransportError);
    expect(error).toMatchObject({
      classification: "server_unavailable",
      attempt: 1,
    });
    expect(faultServer.counts.get("/flaky")).toBe(1);
  });

  it("classifies 401 as non-retryable even when retries are configured", async () => {
    if (!faultServer) throw new Error("Fault server did not start.");
    const { callRemoteMcpTool, McpTransportError } = await import("../src/mcp");

    const error = await callRemoteMcpTool({
      binding: binding(`${faultServer.origin}/unauthorized`, {
        maxRetries: 2,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpTransportError);
    expect(error).toMatchObject({
      classification: "unauthorized",
      retryable: false,
      attempt: 1,
    });
    expect(faultServer.counts.get("/unauthorized")).toBe(1);
  });

  it("aborts a stalled endpoint at the configured timeout and bounds retries", async () => {
    if (!faultServer) throw new Error("Fault server did not start.");
    const { callRemoteMcpTool, McpTransportError } = await import("../src/mcp");

    const startedAt = Date.now();
    const error = await callRemoteMcpTool({
      binding: binding(`${faultServer.origin}/stalled`, {
        maxRetries: 1,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpTransportError);
    expect(error).toMatchObject({
      classification: "timeout",
      retryable: true,
      attempt: 1,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(faultServer.counts.get("/stalled")).toBe(1);
  });

  it("does not follow an HTTP redirect before the MCP protocol starts", async () => {
    if (!faultServer) throw new Error("Fault server did not start.");
    const { createPublicOnlyMcpFetch } = await import("../src/public-endpoint");
    const guardedFetch = createPublicOnlyMcpFetch(faultServer.origin, 500);

    await expect(
      guardedFetch(`${faultServer.origin}/redirect`),
    ).rejects.toThrow();
    expect(faultServer.counts.get("/redirect-target") ?? 0).toBe(0);
  });
});

function binding(
  serverUrl: string,
  overrides: { maxRetries?: number } = {},
) {
  return {
    id: `binding_${new URL(serverUrl).pathname.slice(1)}`,
    slug: new URL(serverUrl).pathname.slice(1),
    displayName: "Fault Injection MCP",
    serverUrl,
    transportKind: "streamable_http" as const,
    defaultToolName: "echo",
    allowedToolNames: ["echo"],
    maxRetries: overrides.maxRetries ?? 0,
    retryBackoffMs: 10,
  };
}

async function startFaultServer(): Promise<FaultServer> {
  const mcpServer = new McpServer({
    name: "delegate-fault-injection-mcp",
    version: "1.0.0",
  });
  mcpServer.registerTool(
    "echo",
    {
      description: "Echo a deterministic value.",
      inputSchema: {
        value: z.string().default("ok"),
      },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: `Echo: ${value}` }],
    }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () =>
      `fault-session-${Math.random().toString(16).slice(2, 10)}`,
  });
  await mcpServer.connect(transport as unknown as Transport);

  const counts = new Map<string, number>();
  const stalledResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);

    if (path === "/unauthorized") {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (path === "/stalled") {
      stalledResponses.add(response);
      response.on("close", () => stalledResponses.delete(response));
      return;
    }
    if (path === "/redirect") {
      response.writeHead(307, {
        location: "/redirect-target",
      }).end();
      return;
    }
    if (path === "/redirect-target") {
      response.writeHead(200, {
        "content-type": "application/json",
      }).end("{}");
      return;
    }
    if (path === "/flaky" && counts.get(path) === 1) {
      response.writeHead(503).end("temporarily unavailable");
      return;
    }
    if (path !== "/flaky") {
      response.writeHead(404).end("not_found");
      return;
    }

    void transport.handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    counts,
    async close() {
      for (const response of stalledResponses) {
        response.destroy();
      }
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
