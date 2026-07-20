import { describe, expect, it } from "vitest";

import { formatComputeUsageExamples, parseComputeRequest } from "../src/compute-requests";

describe("compute request parser", () => {
  it("only triggers for explicit compute prefixes", () => {
    expect(parseComputeRequest("please run pwd")).toBeNull();
    expect(parseComputeRequest("/compute pwd")).toMatchObject({
      capability: "exec",
      command: "pwd",
      displayTarget: "pwd",
    });
  });

  it("parses write and MCP payloads without losing structured arguments", () => {
    expect(parseComputeRequest("/compute write notes/demo.txt ::: hello")).toMatchObject({
      capability: "write",
      path: "notes/demo.txt",
      content: "hello",
    });
    expect(parseComputeRequest('/compute mcp weather lookup ::: {"city":"Shanghai"}')).toMatchObject({
      capability: "mcp",
      bindingSlug: "weather",
      toolName: "lookup",
      toolArguments: { city: "Shanghai" },
    });
  });

  it("rejects invalid browser URLs and documents valid examples", () => {
    expect(parseComputeRequest("/compute browser file:///etc/passwd")).toBeNull();
    expect(formatComputeUsageExamples()).toContain("/compute browser https://example.com");
  });
});
