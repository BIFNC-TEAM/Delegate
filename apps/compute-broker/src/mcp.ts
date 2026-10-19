import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isBailianSearchEndpoint } from "@delegate/web-data";
import { normalizePublicSearchResult, publicSearchHeaders } from "./bailian-search";
import { isAgentContextAuthorizationError, isActionIdentityError } from "@delegate/runtime";
import type { McpProviderOperation, McpProviderState } from "@delegate/compute-protocol";
import { classifyProviderReceipt, parseProviderContract, providerArguments } from "./mcp-recovery-contract";
import { assertLiveMcpToolSchemaPin } from "./mcp-tool-definitions";

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

export function isMcpToolErrorResult(value: unknown) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>)["isError"] === true,
  );
}

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
  providerOperation?: McpProviderOperation | undefined;
  authorize?: (() => Promise<void>) | undefined;
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
  const operation = params.providerOperation ? structuredClone(params.providerOperation) : undefined;
  if (operation) operation.contract = parseProviderContract(operation.contract);
  if (operation?.contract.mode === "keyed" && operation.contract.query?.toolName === resolveMcpToolName({ binding: params.binding, requestedToolName: params.requestedToolName }).toolName) throw new SessionError(409, "mcp_provider_contract_invalid");
  const originalArguments = structuredClone(params.toolArguments ?? {});
  const wireArguments = operation ? providerArguments(operation, originalArguments) : originalArguments;
  const naturalRead = operation ? operation.contract.mode === "natural_read" : params.retrySafe === true;
  const keyed = operation?.contract.mode === "keyed";
  const maxAttempts = naturalRead || keyed ? Math.max(1, Math.min(params.binding.maxRetries + 1, 3)) : 1;
  const timeoutMs = resolveMcpCallTimeoutMs(
    computeBrokerConfig.mcpTimeoutMs,
    naturalRead,
  );
  const monotonicExpiry = operation?.expiresAt ? performance.now() + Math.max(0, Date.parse(operation.expiresAt) - Date.now()) : 0;
  const assertKeyLive = () => {
    if (keyed && (!operation?.expiresAt || !Number.isFinite(Date.parse(operation.expiresAt))
      || Date.now() >= Date.parse(operation.expiresAt) || performance.now() >= monotonicExpiry)) throw new SessionError(409, "mcp_provider_key_expired");
  };
  let queryAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let callStarted = false;
    try {
      await params.authorize?.();
      assertKeyLive();
      const result = await callRemoteMcpToolOnce({
        binding: params.binding,
        bindingUrl,
        timeoutMs,
        requestedToolName: params.requestedToolName,
        toolArguments: wireArguments,
        // Authorization is per request, not a once-only lifecycle notification.
        onBeforeToolCall: async () => { await params.authorize?.(); await params.onBeforeToolCall?.(); assertKeyLive(); callStarted = true; },
        onToolsListed: params.onToolsListed,
        ...(keyed && operation.contract.mode === "keyed" && operation.contract.key.kind === "header"
          ? { keyHeader: { name: operation.contract.key.name, value: operation.key } } : {}),
      });

      return {
        ...result,
        attempts: attempt,
        transportKind: params.binding.transportKind,
        ...(keyed ? { providerState: classifyProviderReceipt(result.result, operation!), recoveredByQuery: false, queryAttempts } : {}),
      };
    } catch (error) {
      if (isAgentContextAuthorizationError(error) || isActionIdentityError(error)) throw error;
      if (error instanceof SessionError && !(error instanceof McpTransportError)) {
        throw error;
      }
      const normalized = normalizeMcpError(
        error,
        params.binding.transportKind,
        attempt,
      );
      if (keyed && callStarted && operation!.contract.mode === "keyed" && operation!.contract.query) {
        queryAttempts++;
        // Query first. A missing/unknown receipt is never proof of no effect.
        // Only the independently verified deduplication contract can authorize
        // another submission, with the original key and exact original payload.
        const queried = await queryRemoteMcpOperation({ binding: params.binding, operation: operation!,
          authorize: params.authorize, onBeforeToolCall: params.onBeforeToolCall, onToolsListed: params.onToolsListed }).catch(queryError => {
            if (isAgentContextAuthorizationError(queryError) || isActionIdentityError(queryError) || (queryError instanceof SessionError && !(queryError instanceof McpTransportError))
              || (queryError instanceof McpTransportError && !queryError.retryable)) throw queryError;
            return null;
          });
        if (queried && ["succeeded", "failed_no_effect", "pending"].includes(queried.state)) return {
          toolName: params.requestedToolName ?? params.binding.defaultToolName!, allowedToolNames: queried.allowedToolNames,
          availableToolNames: queried.availableToolNames, result: queried.result,
          summary: `Provider status query: ${queried.state}.`, attempts: attempt, transportKind: params.binding.transportKind,
          providerState: queried.state, recoveredByQuery: true, queryAttempts,
        };
        if (queried?.state === "unknown") throw new SessionError(409, "mcp_provider_receipt_unverified");
      }
      if ((!naturalRead && !keyed) || !normalized.retryable || attempt === maxAttempts) {
        throw normalized;
      }
      assertKeyLive();
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

export async function queryRemoteMcpOperation(params: {
  binding: BindingRecord; operation: McpProviderOperation;
  onBeforeToolCall?: (() => Promise<void>) | undefined;
  onToolsListed?: ((tools: RemoteMcpToolDefinition[]) => Promise<void>) | undefined;
  authorize?: (() => Promise<void>) | undefined;
}) {
  const contract = parseProviderContract(params.operation.contract);
  if (contract.mode !== "keyed" || !contract.query) throw new SessionError(409, "mcp_provider_status_unsupported");
  await params.authorize?.();
  const bindingUrl = await assertSafePublicMcpUrl(params.binding.serverUrl);
  const query = contract.query;
  const result = await callRemoteMcpToolOnce({ binding: params.binding, bindingUrl, timeoutMs: Math.min(computeBrokerConfig.mcpTimeoutMs, 10000),
    requestedToolName: query.toolName, toolArguments: { [query.keyArgument]: params.operation.key },
    onBeforeToolCall: async () => { await params.authorize?.(); await params.onBeforeToolCall?.(); },
    onToolsListed: async tools => { await params.onToolsListed?.(tools); assertLiveMcpToolSchemaPin({ toolName: query.toolName, expectedToolSchemaHash: query.toolSchemaHash, tools }); },
  });
  const state = classifyProviderReceipt(result.result, params.operation);
  const raw = result.result as { structuredContent?: Record<string, unknown> };
  const fields = contract.receipt;
  const minimal = state === "unknown" ? {} : { [fields.keyField]: raw.structuredContent?.[fields.keyField], [fields.stateField]: raw.structuredContent?.[fields.stateField] };
  // A status observation is not an alternative route for returning an entire
  // private business record supplied by a provider.
  return { ...result, summary: `Provider status query: ${state}.`, result: { structuredContent: minimal, content: [{ type: "text", text: JSON.stringify(minimal) }] }, state };
}

/** Bookkeeping only; permission checks must run on every attempt/request. */
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
  keyHeader?: { name: string; value: string };
}) {
  const resolved = resolveMcpToolName({ binding: params.binding, requestedToolName: params.requestedToolName });
  let admissionError: unknown;
  const transport = createTransport(
    params.binding.transportKind,
    params.bindingUrl,
    params.timeoutMs,
    { toolName: resolved.toolName, beforeCall: async () => { try { await params.onBeforeToolCall?.(); } catch (error) { admissionError = error; throw error; } }, keyHeader: params.keyHeader },
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

    if (!availableToolNames.includes(resolved.toolName)) {
      throw new SessionError(409, "mcp_tool_not_exposed_by_server");
    }

    await params.onToolsListed?.(toolDefinitions);
    const rawResult: unknown = await client.callTool({
      name: resolved.toolName,
      arguments: params.toolArguments ?? {},
    });
    assertMcpJsonPayload(rawResult, {
      maxBytes: computeBrokerConfig.mcpPayloadLimits.maxResponseBytes,
      maxDepth: computeBrokerConfig.mcpPayloadLimits.maxJsonDepth,
      maxNodes: computeBrokerConfig.mcpPayloadLimits.maxJsonNodes,
    }, {
      invalid: "mcp_tool_result_invalid",
      tooLarge: "mcp_tool_result_too_large",
      statusCode: 502,
    });

    const result = isBailianSearchEndpoint(params.bindingUrl.href) && resolved.toolName === "search_pro"
      ? normalizePublicSearchResult(rawResult) : rawResult;
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
  } catch (error) {
    throw admissionError ?? error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createTransport(
  kind: BindingRecord["transportKind"],
  url: URL,
  timeoutMs: number,
  call?: { toolName: string; beforeCall?: (() => Promise<void>) | undefined; keyHeader?: { name: string; value: string } | undefined },
) {
  const publicFetch = createPublicOnlyMcpFetch(url.origin, timeoutMs, {
    maxRequestBytes: computeBrokerConfig.mcpPayloadLimits.maxRequestBytes, maxResponseBytes: computeBrokerConfig.mcpPayloadLimits.maxResponseBytes,
  });
  const common = {
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method?.toUpperCase() === "POST" && typeof init.body !== "string") throw new SessionError(413, "mcp_request_payload_unsupported");
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, any> : null;
      if (Array.isArray(body)) throw new SessionError(413, "mcp_request_payload_unsupported");
      if (body?.method === "tools/call") {
        if (!call || body.params?.name !== call.toolName) throw new SessionError(409, "mcp_provider_request_changed");
        await call.beforeCall?.();
        if (call.keyHeader) { const headers = new Headers(init.headers); headers.set(call.keyHeader.name, call.keyHeader.value); init = { ...init, headers }; }
      }
      return publicFetch(input, init);
    }) as typeof fetch,
    requestInit: {
      headers: {
        "user-agent": "Delegate-Compute-Broker/0.1",
        ...publicSearchHeaders(url),
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
