import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { computeBrokerConfig } from "./config";
import { resolveMcpToolName } from "./mcp-bindings";
import {
  assertMcpJsonPayload,
  assertMcpToolList,
} from "./mcp-payload-limits";
import {
  assertSafePublicMcpUrl,
  createPublicOnlyMcpFetch,
} from "./public-endpoint";
import { normalizeMcpHealthFailureCode } from "./mcp-health-failure";
import { SessionError } from "./session-error";

type BindingRecord = {
  id: string;
  slug: string;
  displayName: string;
  serverUrl: string;
  transportKind: "streamable_http" | "sse";
  defaultToolName: string | null;
  allowedToolNames: unknown;
  maxRetries: number;
  retryBackoffMs: number;
};

export type RemoteMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export async function listRemoteMcpTools(params: {
  binding: Pick<BindingRecord, "serverUrl" | "transportKind">;
}): Promise<RemoteMcpToolDefinition[]> {
  const bindingUrl = await assertSafePublicMcpUrl(params.binding.serverUrl);
  const transport = createTransport(
    params.binding.transportKind,
    bindingUrl,
    computeBrokerConfig.mcpTimeoutMs,
  );
  const client = new Client({ name: "delegate-capability-registry", version: "0.1.0" });
  try {
    await client.connect(transport as unknown as Transport);
    const listedTools: unknown = await client.listTools();
    assertMcpToolList(listedTools, {
      maxBytes: computeBrokerConfig.mcpPayloadLimits.maxToolListBytes,
      maxDepth: computeBrokerConfig.mcpPayloadLimits.maxJsonDepth,
      maxNodes: computeBrokerConfig.mcpPayloadLimits.maxJsonNodes,
      maxItems: computeBrokerConfig.mcpPayloadLimits.maxToolCount,
    });
    return listedTools.tools.map((tool) => {
      const record = tool as unknown as Record<string, unknown>;
      if (!isRecord(record["inputSchema"])) {
        throw new SessionError(502, "mcp_tool_input_schema_missing");
      }
      return {
        name: tool.name,
        ...(typeof record["description"] === "string"
          ? { description: record["description"] }
          : {}),
        inputSchema: record["inputSchema"] as Record<string, unknown>,
        ...(isRecord(record["outputSchema"])
          ? { outputSchema: record["outputSchema"] as Record<string, unknown> }
          : {}),
        ...(isRecord(record["annotations"])
          ? { annotations: record["annotations"] as Record<string, unknown> }
          : {}),
      };
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

type CallToolResultContent = Array<
  | {
      type: string;
      text?: string;
      mimeType?: string;
      resource?: {
        uri?: string;
        text?: string;
      };
    }
  | Record<string, unknown>
>;

export async function callRemoteMcpTool(params: {
  binding: BindingRecord;
  requestedToolName?: string | null | undefined;
  toolArguments?: Record<string, unknown> | undefined;
  retrySafe?: boolean | undefined;
  onBeforeToolCall?: (() => Promise<void>) | undefined;
  onToolsListed?: ((tools: RemoteMcpToolDefinition[]) => Promise<void>) | undefined;
}) {
  const bindingUrl = await assertSafePublicMcpUrl(params.binding.serverUrl);
  const payloadLimits = computeBrokerConfig.mcpPayloadLimits;
  assertMcpJsonPayload(params.toolArguments ?? {}, {
    maxBytes: payloadLimits.maxRequestBytes,
    maxDepth: payloadLimits.maxJsonDepth,
    maxNodes: payloadLimits.maxJsonNodes,
  }, {
    invalid: "mcp_tool_arguments_invalid",
    tooLarge: "mcp_tool_arguments_too_large",
    statusCode: 413,
    invalidStatusCode: 400,
  });

  // Unknown outcomes are never retried for ordinary MCP bindings because the
  // remote side may already have committed a mutation. A server-verified,
  // naturally idempotent read can safely absorb one transient transport fault.
  const maxAttempts = params.retrySafe
    ? Math.max(2, Math.min(params.binding.maxRetries + 1, 3))
    : 1;
  const timeoutMs = resolveMcpCallTimeoutMs(
    computeBrokerConfig.mcpTimeoutMs,
    params.retrySafe ?? false,
  );
  const recordToolCallStart = createAtMostOnceAsyncCallback(
    params.onBeforeToolCall,
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await callRemoteMcpToolOnce({
        binding: params.binding,
        bindingUrl,
        timeoutMs,
        requestedToolName: params.requestedToolName,
        toolArguments: params.toolArguments,
        onBeforeToolCall: recordToolCallStart,
        onToolsListed: params.onToolsListed,
      });

      return {
        ...result,
        attempts: attempt,
        transportKind: params.binding.transportKind,
      };
    } catch (error) {
      if (error instanceof SessionError && !(error instanceof McpTransportError)) {
        throw error;
      }
      const normalized = normalizeMcpError(
        error,
        params.binding.transportKind,
        attempt,
      );
      if (!params.retrySafe || !normalized.retryable || attempt === maxAttempts) {
        throw normalized;
      }
      if (params.binding.retryBackoffMs > 0) {
        await wait(params.binding.retryBackoffMs);
      }
    }
  }
  throw new McpTransportError(
    "transport_connection_failed",
    params.binding.transportKind,
    maxAttempts,
    false,
  );
}

export function createAtMostOnceAsyncCallback(
  callback?: (() => Promise<void>) | undefined,
) {
  if (!callback) return undefined;
  let completed = false;
  return async () => {
    if (completed) return;
    await callback();
    completed = true;
  };
}

export function resolveMcpCallTimeoutMs(
  configuredTimeoutMs: number,
  retrySafe: boolean,
) {
  return retrySafe
    ? Math.max(configuredTimeoutMs, 60_000)
    : configuredTimeoutMs;
}

async function callRemoteMcpToolOnce(params: {
  binding: BindingRecord;
  bindingUrl: URL;
  timeoutMs: number;
  requestedToolName?: string | null | undefined;
  toolArguments?: Record<string, unknown> | undefined;
  onBeforeToolCall?: (() => Promise<void>) | undefined;
  onToolsListed?: ((tools: RemoteMcpToolDefinition[]) => Promise<void>) | undefined;
}) {
  const transport = createTransport(
    params.binding.transportKind,
    params.bindingUrl,
    params.timeoutMs,
  );
  const client = new Client({
    name: "delegate-compute-broker",
    version: "0.1.0",
  });

  try {
    await client.connect(transport as unknown as Transport);

    const listedTools: unknown = await client.listTools();
    assertMcpToolList(listedTools, {
      maxBytes: computeBrokerConfig.mcpPayloadLimits.maxToolListBytes,
      maxDepth: computeBrokerConfig.mcpPayloadLimits.maxJsonDepth,
      maxNodes: computeBrokerConfig.mcpPayloadLimits.maxJsonNodes,
      maxItems: computeBrokerConfig.mcpPayloadLimits.maxToolCount,
    });
    const availableToolNames = listedTools.tools.map((tool) => tool.name);
    const toolDefinitions = listedTools.tools.map((tool) => {
      const record = tool as unknown as Record<string, unknown>;
      if (!isRecord(record["inputSchema"])) {
        throw new SessionError(502, "mcp_tool_input_schema_missing");
      }
      return {
        name: tool.name,
        ...(typeof record["description"] === "string"
          ? { description: record["description"] }
          : {}),
        inputSchema: record["inputSchema"] as Record<string, unknown>,
        ...(isRecord(record["outputSchema"])
          ? { outputSchema: record["outputSchema"] as Record<string, unknown> }
          : {}),
        ...(isRecord(record["annotations"])
          ? { annotations: record["annotations"] as Record<string, unknown> }
          : {}),
      } satisfies RemoteMcpToolDefinition;
    });
    const resolved = resolveMcpToolName({
      binding: params.binding,
      requestedToolName: params.requestedToolName,
    });

    if (!availableToolNames.includes(resolved.toolName)) {
      throw new SessionError(409, "mcp_tool_not_exposed_by_server");
    }

    await params.onToolsListed?.(toolDefinitions);
    await params.onBeforeToolCall?.();
    const result: unknown = await client.callTool({
      name: resolved.toolName,
      arguments: params.toolArguments ?? {},
    });
    assertMcpJsonPayload(result, {
      maxBytes: computeBrokerConfig.mcpPayloadLimits.maxResponseBytes,
      maxDepth: computeBrokerConfig.mcpPayloadLimits.maxJsonDepth,
      maxNodes: computeBrokerConfig.mcpPayloadLimits.maxJsonNodes,
    }, {
      invalid: "mcp_tool_result_invalid",
      tooLarge: "mcp_tool_result_too_large",
      statusCode: 502,
    });

    return {
      toolName: resolved.toolName,
      allowedToolNames: resolved.allowedToolNames,
      availableToolNames,
      result,
      summary: summarizeMcpResult(
        result && typeof result === "object" && "content" in result
          ? result.content
          : undefined,
      ),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createTransport(
  kind: BindingRecord["transportKind"],
  url: URL,
  timeoutMs: number,
) {
  const common = {
    fetch: createPublicOnlyMcpFetch(
      url.origin,
      timeoutMs,
      {
        maxRequestBytes: computeBrokerConfig.mcpPayloadLimits.maxRequestBytes,
        maxResponseBytes: computeBrokerConfig.mcpPayloadLimits.maxResponseBytes,
      },
    ),
    requestInit: {
      headers: {
        "user-agent": "Delegate-Compute-Broker/0.1",
      },
    },
  };

  if (kind === "sse") {
    return new SSEClientTransport(url, common);
  }

  return new StreamableHTTPClientTransport(url, common);
}

type McpFailureClassification =
  | "timeout"
  | "unauthorized"
  | "endpoint_not_found"
  | "server_unavailable"
  | "request_payload_too_large"
  | "request_payload_unsupported"
  | "response_payload_too_large"
  | "transport_connection_failed";

export class McpTransportError extends SessionError {
  constructor(
    readonly classification: McpFailureClassification,
    readonly transportKind: BindingRecord["transportKind"],
    readonly attempt: number,
    readonly retryable: boolean,
    _privateMessage?: string,
  ) {
    super(502, `mcp_${classification}`);
  }
}

export function toMcpHealthFailureCode(error: unknown) {
  if (error instanceof McpTransportError) {
    return normalizeMcpHealthFailureCode(`mcp_${error.classification}`);
  }

  if (error instanceof SessionError) {
    const prefix = /^([a-z][a-z0-9_]{0,79})(?::|$)/u.exec(error.message)?.[1];
    return normalizeMcpHealthFailureCode(prefix);
  }

  return "mcp_execution_failed";
}

export function toMcpExecutionFailureSummary(error: unknown) {
  if (error instanceof McpTransportError) {
    return `mcp_${error.classification}`;
  }
  if (error instanceof SessionError) {
    return /^([a-z][a-z0-9_]{0,79})(?::|$)/u.exec(error.message)?.[1]
      ?? "mcp_execution_failed";
  }
  return "mcp_execution_failed";
}

function normalizeMcpError(
  error: unknown,
  transportKind: BindingRecord["transportKind"],
  attempt: number,
) {
  const details = classifyMcpTransportFailure(error);
  return new McpTransportError(
    details.classification,
    transportKind,
    attempt,
    details.retryable,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyMcpTransportFailure(error: unknown): {
  classification: McpFailureClassification;
  retryable: boolean;
  message: string;
} {
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return classifyByStatus(error.code, error.message);
  }

  if (error instanceof Error) {
    const errorChain = collectErrorChain(error);
    const message = errorChain
      .map((candidate) => candidate.message.trim())
      .filter(Boolean)
      .join(": ");
    const lower = message.toLowerCase();

    if (lower.includes("mcp_response_payload_too_large")) {
      return {
        classification: "response_payload_too_large",
        retryable: false,
        message,
      };
    }

    if (lower.includes("mcp_request_payload_too_large")) {
      return {
        classification: "request_payload_too_large",
        retryable: false,
        message,
      };
    }

    if (lower.includes("mcp_request_payload_unsupported")) {
      return {
        classification: "request_payload_unsupported",
        retryable: false,
        message,
      };
    }

    if (
      errorChain.some((candidate) => ["TimeoutError", "AbortError"].includes(candidate.name))
      || lower.includes("timeout")
      || lower.includes("timed out")
    ) {
      return {
        classification: "timeout",
        retryable: true,
        message,
      };
    }

    if (lower.includes("401") || lower.includes("unauthorized")) {
      return {
        classification: "unauthorized",
        retryable: false,
        message,
      };
    }

    if (lower.includes("404") || lower.includes("not found")) {
      return {
        classification: "endpoint_not_found",
        retryable: false,
        message,
      };
    }

    return {
      classification: "transport_connection_failed",
      retryable: true,
      message,
    };
  }

  return {
    classification: "transport_connection_failed",
    retryable: true,
    message: String(error),
  };
}

function collectErrorChain(error: Error) {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && chain.length < 6) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function classifyByStatus(statusCode: number | undefined, message: string) {
  if (typeof statusCode !== "number") {
    return {
      classification: "transport_connection_failed" as const,
      retryable: true,
      message,
    };
  }

  if (statusCode === 401) {
    return {
      classification: "unauthorized" as const,
      retryable: false,
      message,
    };
  }

  if (statusCode === 404) {
    return {
      classification: "endpoint_not_found" as const,
      retryable: false,
      message,
    };
  }

  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return {
      classification: "server_unavailable" as const,
      retryable: true,
      message,
    };
  }

  return {
    classification: "transport_connection_failed" as const,
    retryable: true,
    message,
  };
}

function summarizeMcpResult(content: unknown) {
  if (!Array.isArray(content)) {
    return "MCP tool completed without structured content.";
  }

  const fragments = (content as CallToolResultContent)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || !("type" in entry)) {
        return null;
      }

      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text.trim();
      }

      if (entry.type === "resource" && entry.resource && typeof entry.resource === "object") {
        const resource = entry.resource as { uri?: unknown; text?: unknown };
        if (typeof resource.uri === "string") {
          const resourceText = typeof resource.text === "string" ? resource.text.trim() : "";
          return resourceText ? `${resource.uri}: ${resourceText}` : resource.uri;
        }
      }

      return JSON.stringify(entry);
    })
    .filter((value): value is string => Boolean(value));

  if (!fragments.length) {
    return "MCP tool completed.";
  }

  return truncate(fragments.join(" | ").replace(/\s+/g, " "), 240);
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function wait(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
