import { SessionError } from "./session-error";

export type McpJsonLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
};

export function assertMcpJsonPayload(
  value: unknown,
  limits: McpJsonLimits,
  errors: {
    invalid: string;
    tooLarge: string;
    statusCode: number;
    invalidStatusCode?: number;
  },
): number {
  let nodeCount = 0;
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > limits.maxNodes || depth > limits.maxDepth) {
      throw new SessionError(errors.statusCode, errors.tooLarge);
    }

    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
    }

    if (ancestors.has(current)) {
      throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (const item of current) {
          visit(item, depth + 1);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
      }
      for (const [key, item] of Object.entries(current)) {
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0);

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
  }
  if (serialized === undefined) {
    throw new SessionError(errors.invalidStatusCode ?? errors.statusCode, errors.invalid);
  }

  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > limits.maxBytes) {
    throw new SessionError(errors.statusCode, errors.tooLarge);
  }
  return byteLength;
}

export function assertMcpToolList(
  listedTools: unknown,
  limits: McpJsonLimits & { maxItems: number },
): asserts listedTools is { tools: Array<{ name: string }> } {
  assertMcpJsonPayload(listedTools, limits, {
    invalid: "mcp_tool_list_invalid",
    tooLarge: "mcp_tool_list_too_large",
    statusCode: 502,
  });

  if (
    !listedTools
    || typeof listedTools !== "object"
    || !("tools" in listedTools)
    || !Array.isArray(listedTools.tools)
  ) {
    throw new SessionError(502, "mcp_tool_list_invalid");
  }
  if (listedTools.tools.length > limits.maxItems) {
    throw new SessionError(502, "mcp_tool_list_too_large");
  }
  if (
    listedTools.tools.some((tool) =>
      !tool
      || typeof tool !== "object"
      || !("name" in tool)
      || typeof tool.name !== "string"
    )
  ) {
    throw new SessionError(502, "mcp_tool_list_invalid");
  }
}
