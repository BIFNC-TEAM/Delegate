import type { CapabilityKind, ToolExecutionRequest } from "@delegate/compute-protocol";

export type ParsedComputeRequest = Omit<ToolExecutionRequest, "subagentId"> & {
  displayTarget: string;
};

export function parseComputeRequest(input: string): ParsedComputeRequest | null {
  const normalized = extractComputePayload(input.trim());

  if (!normalized) return null;

  if (normalized.toLowerCase().startsWith("read ")) {
    const path = normalized.slice(5).trim();
    if (!path) return null;

    return buildRequest("read", path, {
      path,
      estimatedCostCents: 2,
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
      estimatedCostCents: 4 + Math.ceil(content.length / 512),
    });
  }

  if (normalized.toLowerCase().startsWith("browser ")) {
    const url = normalized.slice(8).trim();
    if (!isLikelyUrl(url)) return null;

    return buildRequest("browser", url, {
      url,
      estimatedCostCents: 10,
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
      estimatedCostCents: 12 + Math.ceil(JSON.stringify(toolArguments).length / 256),
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
    estimatedCostCents:
      capability === "process"
        ? 6 + Math.ceil(command.length / 48)
        : 4 + Math.ceil(command.length / 64),
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

function extractComputePayload(input: string) {
  if (input.startsWith("/compute")) return input.slice("/compute".length).trim();
  if (input.toLowerCase().startsWith("compute:")) return input.slice("compute:".length).trim();
  if (input.toLowerCase().startsWith("run:")) return input.slice("run:".length).trim();
  return null;
}

function isLikelyUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
