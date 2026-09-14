import type {
  CapabilityKind,
  CompiledSandboxTaskMetadata,
  ToolExecutionRequest,
} from "@delegate/compute-protocol";

export type { CompiledSandboxTaskMetadata } from "@delegate/compute-protocol";

export type ParsedComputeRequest = Omit<ToolExecutionRequest, "subagentId"> & {
  displayTarget: string;
  compiledTask?: CompiledSandboxTaskMetadata;
};

export type ComputeDirectiveResult =
  | { kind: "none" }
  | { kind: "help"; examples: string }
  | { kind: "invalid"; message: string; examples: string }
  | { kind: "request"; request: ParsedComputeRequest };

export function parseComputeRequest(input: string): ParsedComputeRequest | null {
  const directive = parseComputeDirective(input);
  return directive.kind === "request" ? directive.request : null;
}

export function parseComputeDirective(input: string): ComputeDirectiveResult {
  const trimmed = input.trim();
  const extracted = extractComputePayload(trimmed);

  if (!extracted.matched) return { kind: "none" };
  if (!extracted.payload) {
    return { kind: "help", examples: formatComputeUsageExamples() };
  }

  const request = parseComputePayload(extracted.payload);
  if (!request) {
    return {
      kind: "invalid",
      message: describeInvalidComputePayload(extracted.payload),
      examples: formatComputeUsageExamples(),
    };
  }

  return { kind: "request", request };
}

function parseComputePayload(normalized: string): ParsedComputeRequest | null {
  if (!normalized) return null;

  if (normalized.toLowerCase().startsWith("read ")) {
    const path = normalized.slice(5).trim();
    if (!path) return null;

    return buildRequest("read", path, {
      path,
      estimatedTokens: 200,
    });
  }

  if (normalized.toLowerCase().startsWith("write ")) {
    const body = normalized.slice(6).trim();
    const splitToken = body.includes(":::") ? ":::" : "\n";
    const [pathPart, ...rest] = body.split(splitToken);
    const path = pathPart?.trim();
    const content = rest.join(splitToken).trimStart();
    if (!path || !content) return null;

    return buildRequest("write", path, {
      path,
      content,
      estimatedTokens: 400 + 100 * Math.ceil(content.length / 512),
    });
  }

  if (normalized.toLowerCase().startsWith("browser ")) {
    const url = normalized.slice(8).trim();
    if (!isLikelyUrl(url)) return null;

    return buildRequest("browser", url, {
      url,
      estimatedTokens: 1_000,
    });
  }

  if (normalized.toLowerCase().startsWith("mcp ")) {
    const body = normalized.slice(4).trim();
    const splitToken = body.includes(":::") ? ":::" : "\n";
    const [headPart, ...rest] = body.split(splitToken);
    const head = headPart?.trim();
    if (!head) return null;

    const [bindingSlug, toolName] = head.split(/\s+/, 2);
    if (!bindingSlug) return null;

    let toolArguments: Record<string, unknown> = {};
    const argumentPayload = rest.join(splitToken).trim();
    if (argumentPayload) {
      try {
        const parsedArguments = JSON.parse(argumentPayload);
        if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
          return null;
        }
        toolArguments = parsedArguments as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    return buildRequest("mcp", toolName ? `${bindingSlug}:${toolName}` : bindingSlug, {
      bindingSlug,
      ...(toolName ? { toolName } : {}),
      toolArguments,
      estimatedTokens:
        1_200 + 100 * Math.ceil(JSON.stringify(toolArguments).length / 256),
    });
  }

  if (normalized.toLowerCase().startsWith("process ")) {
    const command = normalized.slice(8).trim();
    return command ? buildCommandRequest("process", command) : null;
  }

  return buildCommandRequest("exec", normalized);
}

export function formatComputeUsageExamples() {
  return [
    "/compute pwd",
    "/compute read README.md",
    "/compute write notes/demo.txt ::: hello from delegate",
    "/compute browser https://example.com",
    '/compute mcp demo-weather lookup ::: {"city":"Shanghai"}',
  ].join("\n");
}

function buildCommandRequest(capability: CapabilityKind, command: string): ParsedComputeRequest {
  return buildRequest(capability, command, {
    command,
    estimatedTokens:
      capability === "process"
        ? 600 + 100 * Math.ceil(command.length / 48)
        : 400 + 100 * Math.ceil(command.length / 64),
  });
}

function buildRequest(
  capability: CapabilityKind,
  displayTarget: string,
  fields: Partial<ToolExecutionRequest>,
): ParsedComputeRequest {
  return {
    capability,
    ...fields,
    hasPaidEntitlement: false,
    browserMode: "deterministic",
    maxSteps: 1,
    allowMutations: false,
    displayTarget,
  } as ParsedComputeRequest;
}

function extractComputePayload(input: string): { matched: boolean; payload: string } {
  if (/^\/compute(?:\s|$)/i.test(input)) {
    return { matched: true, payload: input.slice("/compute".length).trim() };
  }
  if (/^compute\s*:/i.test(input)) {
    return { matched: true, payload: input.replace(/^compute\s*:/i, "").trim() };
  }
  if (/^run\s*:/i.test(input)) {
    return { matched: true, payload: input.replace(/^run\s*:/i, "").trim() };
  }
  return { matched: false, payload: "" };
}

function describeInvalidComputePayload(payload: string) {
  const normalized = payload.toLowerCase();
  if (normalized === "write" || normalized.startsWith("write ")) {
    return "写入格式不完整。请提供目标路径、分隔符 ::: 和文件内容。";
  }
  if (normalized === "read" || normalized.startsWith("read ")) {
    return "读取格式不完整。请在 read 后提供文件或目录路径。";
  }
  if (normalized === "browser" || normalized.startsWith("browser ")) {
    return "浏览格式不正确。请提供完整的 http:// 或 https:// 地址。";
  }
  if (normalized === "mcp" || normalized.startsWith("mcp ")) {
    return "MCP 格式不正确。请提供绑定名称、工具名称和可选的 JSON 参数。";
  }
  if (normalized === "process") {
    return "进程格式不完整。请在 process 后提供要运行的命令。";
  }
  return "无法识别这个 Compute 请求。";
}

function isLikelyUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
