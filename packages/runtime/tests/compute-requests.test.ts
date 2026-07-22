import { describe, expect, it } from "vitest";

import {
  buildComputeRequestFromNaturalLanguagePlan,
  formatComputeUsageExamples,
  parseComputeDirective,
  parseComputeRequest,
  shouldConsiderNaturalLanguageCompute,
} from "../src/compute-requests";

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

  it("distinguishes help and invalid directives from ordinary chat", () => {
    expect(parseComputeDirective("/compute")).toMatchObject({ kind: "help" });
    expect(parseComputeDirective("/compute write notes/demo.txt")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("写入格式不完整"),
    });
    expect(parseComputeDirective("/computer science")).toEqual({ kind: "none" });
  });

  it("builds bounded requests from natural-language plans", () => {
    expect(shouldConsiderNaturalLanguageCompute("把 hello 保存到 notes/demo.txt 文件")).toBe(true);
    expect(shouldConsiderNaturalLanguageCompute("Compute 是什么？")).toBe(false);
    expect(buildComputeRequestFromNaturalLanguagePlan({
      capability: "write",
      path: "notes/demo.txt",
      content: "hello",
      summary: "生成 notes/demo.txt",
    })).toMatchObject({
      capability: "write",
      path: "notes/demo.txt",
      content: "hello",
      displayTarget: "生成 notes/demo.txt",
    });
  });
});
