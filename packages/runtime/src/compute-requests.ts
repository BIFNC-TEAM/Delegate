import { createHash } from "node:crypto";

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

export type NaturalLanguageComputePlan = {
  capability: "exec" | "read" | "write" | "process" | "browser";
  summary: string;
  command?: string;
  path?: string;
  content?: string;
  url?: string;
};

export type NaturalLanguageDelegationPlan =
  | {
      kind: "execution";
      summary: string;
      steps: NaturalLanguageComputePlan[];
    }
  | {
      kind: "clarification";
      summary: string;
      question: string;
      missingFields: Array<"command" | "path" | "content" | "url">;
    };

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

export function shouldConsiderNaturalLanguageCompute(input: string) {
  const normalized = input.trim();
  if (!normalized || extractComputePayload(normalized).matched) return false;

  return [
    /(?:保存|写入|生成|创建|撰写|编写|制作|写|做|导出|转换).{0,40}(?:文件|文档|markdown|md|txt|json|csv|报告|总结|方案|教案|教程|指南|故事|记录|纪要|清单|表格|简历|邮件|说明|规范)/i,
    /(?:给我|提供|准备|整理).{0,40}(?:教程|指南|学习资料).{0,24}(?:以|用)?.{0,8}(?:文件|文档).{0,8}(?:形式)?(?:提供|交付|发送)?|(?:教程|指南|学习资料).{0,24}(?:以|用).{0,8}(?:文件|文档).{0,8}(?:形式)?(?:提供|交付|发送)?/i,
    /(?:打开|访问|浏览|检查|测试).{0,24}(?:https?:\/\/|网页|网站|页面|url)/i,
    /(?:运行|执行).{0,12}(?:命令|脚本|代码)/i,
    /(?:读取|查看|分析).{0,20}(?:文件|\.md\b|\.txt\b|\.json\b|\.csv\b)/i,
    /\b(?:save|write|create|generate|draft|prepare|export|convert)\b.{0,40}\b(?:file|document|markdown|csv|json|report|summary|plan|lesson|story|record|notes|minutes|checklist|table|resume|email|specification|spec)\b/i,
    /\b(?:open|visit|browse|inspect|test)\b.{0,24}(?:https?:\/\/|\bwebsite\b|\bwebpage\b|\burl\b)/i,
    /\b(?:run|execute)\b.{0,12}\b(?:command|script|code)\b/i,
    /\b(?:read|inspect|analyze)\b.{0,20}\bfile\b/i,
  ].some((pattern) => pattern.test(normalized));
}

export function buildComputeRequestFromNaturalLanguagePlan(
  plan: NaturalLanguageComputePlan,
): ParsedComputeRequest | null {
  const summary = plan.summary.trim();
  if (!summary) return null;

  switch (plan.capability) {
    case "read": {
      const path = plan.path?.trim();
      return path
        ? buildRequest("read", summary, { path, estimatedTokens: 200 })
        : null;
    }
    case "write": {
      const path = plan.path?.trim();
      const content = plan.content;
      return path && typeof content === "string" && content.length > 0
        ? buildRequest("write", summary, {
            path,
            content,
            estimatedTokens: 400 + 100 * Math.ceil(content.length / 512),
          })
        : null;
    }
    case "browser": {
      const url = plan.url?.trim();
      return url && isLikelyUrl(url)
        ? buildRequest("browser", summary, { url, estimatedTokens: 1_000 })
        : null;
    }
    case "process":
    case "exec": {
      const command = plan.command?.trim();
      return command
        ? buildRequest(plan.capability, summary, {
            command,
            estimatedTokens:
              plan.capability === "process"
                ? 600 + 100 * Math.ceil(command.length / 48)
                : 400 + 100 * Math.ceil(command.length / 64),
          })
        : null;
    }
  }
}

export function buildComputeRequestsFromDelegationPlan(
  plan: NaturalLanguageDelegationPlan,
): ParsedComputeRequest[] {
  if (plan.kind !== "execution") return [];
  return plan.steps
    .map(buildComputeRequestFromNaturalLanguagePlan)
    .filter((request): request is ParsedComputeRequest => Boolean(request));
}

export function readPersistedDelegationStepRequest(value: unknown): ParsedComputeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const capability = record.capability;
  const displayTarget = record.displayTarget;
  if (
    !["exec", "read", "write", "process", "browser", "mcp"].includes(String(capability)) ||
    typeof displayTarget !== "string" ||
    !displayTarget.trim()
  ) {
    return null;
  }
  if ((capability === "exec" || capability === "process") && typeof record.command !== "string") return null;
  if (capability === "read" && typeof record.path !== "string") return null;
  if (capability === "write" && (typeof record.path !== "string" || typeof record.content !== "string")) return null;
  if (capability === "browser" && (typeof record.url !== "string" || !isLikelyUrl(record.url))) return null;
  if (
    capability === "mcp" &&
    typeof record.bindingId !== "string" &&
    typeof record.bindingSlug !== "string"
  ) return null;
  const compiledTask = readCompiledSandboxTaskMetadata(record.compiledTask);
  if (typeof record.compiledTask !== "undefined" && !compiledTask) return null;
  if (
    compiledTask
    && (
      typeof record.command !== "string"
      || !compiledTaskCommandMatches(record.command, compiledTask)
    )
  ) return null;
  const { estimatedCostCents: legacyEstimatedCostCents, ...persisted } = record;
  const estimatedTokens = typeof record.estimatedTokens === "number"
    ? record.estimatedTokens
    : typeof legacyEstimatedCostCents === "number"
      ? legacyEstimatedCostCents * 100
      : undefined;
  return {
    ...persisted,
    capability,
    displayTarget: displayTarget.trim(),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    hasPaidEntitlement: record.hasPaidEntitlement === true,
    browserMode: record.browserMode === "native" ? "native" : "deterministic",
    maxSteps: typeof record.maxSteps === "number" ? Math.max(1, Math.min(8, Math.floor(record.maxSteps))) : 1,
    allowMutations: record.allowMutations === true,
    ...(compiledTask ? { compiledTask } : {}),
  } as ParsedComputeRequest;
}

function readCompiledSandboxTaskMetadata(value: unknown): CompiledSandboxTaskMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.compilerVersion === "sandbox-task-compiler.v1"
    && typeof record.instructionHash === "string"
    && /^[a-f0-9]{64}$/u.test(record.instructionHash)
    && typeof record.codeHash === "string"
    && /^[a-f0-9]{64}$/u.test(record.codeHash)
    && record.riskClass === "self_contained_compute"
    && (
      typeof record.compilerProvider === "undefined"
      || (
        typeof record.compilerProvider === "string"
        && record.compilerProvider.length >= 1
        && record.compilerProvider.length <= 120
      )
    )
    && (
      typeof record.compilerModel === "undefined"
      || (
        typeof record.compilerModel === "string"
        && record.compilerModel.length >= 1
        && record.compilerModel.length <= 200
      )
    )
    ? {
        compilerVersion: record.compilerVersion,
        instructionHash: record.instructionHash,
        codeHash: record.codeHash,
        riskClass: record.riskClass,
        ...(typeof record.compilerProvider === "string"
          ? { compilerProvider: record.compilerProvider }
          : {}),
        ...(typeof record.compilerModel === "string"
          ? { compilerModel: record.compilerModel }
          : {}),
      }
    : null;
}

function compiledTaskCommandMatches(
  command: string,
  metadata: CompiledSandboxTaskMetadata,
) {
  const match = command.match(
    /^python -c "exec\(__import__\('base64'\)\.b64decode\('([A-Za-z0-9+/]+={0,2})'\)\.decode\('utf-8'\)\)"$/u,
  );
  if (!match?.[1]) return false;
  try {
    const code = Buffer.from(match[1], "base64").toString("utf8");
    return createHash("sha256").update(code, "utf8").digest("hex") === metadata.codeHash;
  } catch {
    return false;
  }
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
