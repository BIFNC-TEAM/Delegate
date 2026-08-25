import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = "true";

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

let streamableServer: TestServer | null = null;
let sseServer: TestServer | null = null;

beforeAll(async () => {
  streamableServer = await startStreamableServer();
  sseServer = await startSseServer();
});

afterAll(async () => {
  await streamableServer?.close();
  await sseServer?.close();
});

describe("callRemoteMcpTool", () => {
  it("calls an MCP tool over streamable HTTP and returns a summarized result", async () => {
    const { callRemoteMcpTool } = await import("../src/mcp");
    const onBeforeToolCall = vi.fn().mockResolvedValue(undefined);
    const result = await callRemoteMcpTool({
      binding: {
        id: "binding_weather",
        slug: "weather",
        displayName: "Weather MCP",
        serverUrl: streamableServer!.url,
        transportKind: "streamable_http",
        defaultToolName: "lookup",
        allowedToolNames: ["lookup"],
        maxRetries: 0,
        retryBackoffMs: 100,
      },
      toolArguments: {
        city: "Shanghai",
      },
      onBeforeToolCall,
    });

    expect(onBeforeToolCall).toHaveBeenCalledTimes(1);
    expect(result.toolName).toBe("lookup");
    expect(result.availableToolNames).toContain("lookup");
    expect(result.summary).toContain("Weather for Shanghai");
    expect(result.transportKind).toBe("streamable_http");
    expect(result.attempts).toBe(1);
  });

  it("supports the legacy SSE transport when a binding requests it", async () => {
    const { callRemoteMcpTool } = await import("../src/mcp");
    const result = await callRemoteMcpTool({
      binding: {
        id: "binding_weather_sse",
        slug: "weather-sse",
        displayName: "Weather MCP SSE",
        serverUrl: sseServer!.url,
        transportKind: "sse",
        defaultToolName: "lookup",
        allowedToolNames: ["lookup"],
        maxRetries: 0,
        retryBackoffMs: 100,
      },
      toolArguments: {
        city: "Hangzhou",
      },
    });

    expect(result.toolName).toBe("lookup");
    expect(result.summary).toContain("Weather for Hangzhou");
    expect(result.transportKind).toBe("sse");
  });

  it("rejects non-JSON-safe tool arguments before any remote request", async () => {
    const { callRemoteMcpTool } = await import("../src/mcp");
    const originalFetch = global.fetch;
    let fetchCount = 0;
    global.fetch = (async () => {
      fetchCount += 1;
      return new Response("{}");
    }) as typeof fetch;

    try {
      const invalidArguments: Record<string, unknown> = {};
      invalidArguments.self = invalidArguments;
      const error = await callRemoteMcpTool({
        binding: {
          id: "binding_invalid_arguments",
          slug: "invalid-arguments",
          displayName: "Invalid Arguments MCP",
          serverUrl: streamableServer!.url,
          transportKind: "streamable_http",
          defaultToolName: "lookup",
          allowedToolNames: ["lookup"],
          maxRetries: 5,
          retryBackoffMs: 100,
        },
        toolArguments: invalidArguments,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        statusCode: 400,
        message: "mcp_tool_arguments_invalid",
      });
      expect(fetchCount).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not retry an MCP invocation after an uncertain transport failure", async () => {
    const { callRemoteMcpTool, McpTransportError } = await import("../src/mcp");
    const originalFetch = global.fetch;
    let fetchCount = 0;
    const onBeforeToolCall = vi.fn().mockResolvedValue(undefined);

    global.fetch = (async () => {
      fetchCount += 1;
      throw new Error("synthetic_network_failure token=must-not-leak");
    }) as typeof fetch;

    try {
      const error = await callRemoteMcpTool({
        binding: {
          id: "binding_retry",
          slug: "weather-retry",
          displayName: "Weather MCP Retry",
          serverUrl: sseServer!.url,
          transportKind: "sse",
          defaultToolName: "lookup",
          allowedToolNames: ["lookup"],
          maxRetries: 1,
          retryBackoffMs: 10,
        },
        toolArguments: {
          city: "Suzhou",
        },
        onBeforeToolCall,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(McpTransportError);
      expect(error).toMatchObject({
        attempt: 1,
        message: "mcp_transport_connection_failed",
      });
      expect(fetchCount).toBe(1);
      expect(onBeforeToolCall).not.toHaveBeenCalled();
      expect(String(error)).not.toContain("must-not-leak");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

async function startStreamableServer(): Promise<TestServer> {
  const mcpServer = new McpServer({
    name: "delegate-test-mcp-streamable",
    version: "1.0.0",
  });
  registerLookupTool(mcpServer);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `test-session-${Math.random().toString(16).slice(2, 10)}`,
  });
  await mcpServer.connect(transport as unknown as Transport);

  const server = createServer((request, response) => {
    if ((request.url ?? "/") !== "/mcp") {
      response.statusCode = 404;
      response.end("not_found");
      return;
    }

    void transport.handleRequest(request, response);
  });

  await listen(server);
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
      await closeServer(server);
    },
  };
}

async function startSseServer(): Promise<TestServer> {
  const server = createServer();
  const transports = new Map<
    string,
    {
      transport: SSEServerTransport;
      server: McpServer;
    }
  >();

  server.on("request", (request, response) => {
    if ((request.url ?? "/").startsWith("/sse") && request.method === "GET") {
      void handleSseConnect(transports, request, response);
      return;
    }

    if ((request.url ?? "/").startsWith("/messages") && request.method === "POST") {
      void handleSsePost(transports, request, response);
      return;
    }

    response.statusCode = 404;
    response.end("not_found");
  });

  await listen(server);
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/sse`,
    async close() {
      for (const entry of transports.values()) {
        await entry.transport.close().catch(() => undefined);
        await entry.server.close().catch(() => undefined);
      }
      await closeServer(server);
    },
  };
}

function registerLookupTool(server: McpServer) {
  server.registerTool(
    "lookup",
    {
      description: "Return a deterministic weather string for tests.",
      inputSchema: {
        city: z.string(),
      },
    },
    async ({ city }) => ({
      content: [
        {
          type: "text",
          text: `Weather for ${city}: clear`,
        },
      ],
    }),
  );
}

async function handleSseConnect(
  transports: Map<string, { transport: SSEServerTransport; server: McpServer }>,
  _request: IncomingMessage,
  response: ServerResponse,
) {
  const mcpServer = new McpServer({
    name: "delegate-test-mcp-sse",
    version: "1.0.0",
  });
  registerLookupTool(mcpServer);
  const transport = new SSEServerTransport("/messages", response);
  transports.set(transport.sessionId, {
    transport,
    server: mcpServer,
  });
  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };
  await mcpServer.connect(transport as unknown as Transport);
}

async function handleSsePost(
  transports: Map<string, { transport: SSEServerTransport; server: McpServer }>,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/messages", "http://127.0.0.1");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    response.statusCode = 400;
    response.end("session_id_required");
    return;
  }

  const entry = transports.get(sessionId);
  if (!entry) {
    response.statusCode = 404;
    response.end("session_not_found");
    return;
  }

  await entry.transport.handlePostMessage(request, response);
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
