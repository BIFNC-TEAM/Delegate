import { describe, expect, it } from "vitest";

import {
  buildComputeRequestFromNaturalLanguagePlan,
  buildComputeRequestsFromDelegationPlan,
  formatComputeUsageExamples,
  parseComputeDirective,
  parseComputeRequest,
  shouldConsiderNaturalLanguageCompute,
  readPersistedDelegationStepRequest,
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
    expect(shouldConsiderNaturalLanguageCompute("生成一份面向管理层的季度销售总结")).toBe(true);
    expect(shouldConsiderNaturalLanguageCompute("编写一个幼儿园主题教案")).toBe(true);
    expect(shouldConsiderNaturalLanguageCompute("帮我做一份年度报告")).toBe(true);
    expect(shouldConsiderNaturalLanguageCompute("请生成一份面向 QA 团队的 Markdown 测试记录")).toBe(true);
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

  it("builds and restores bounded multi-step execution requests", () => {
    const requests = buildComputeRequestsFromDelegationPlan({
      kind: "execution",
      summary: "生成并读取文件",
      steps: [
        { capability: "write", path: "notes/p1.txt", content: "P1", summary: "写入文件" },
        { capability: "read", path: "notes/p1.txt", summary: "读取文件" },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(readPersistedDelegationStepRequest(requests[1])).toMatchObject({
      capability: "read",
      path: "notes/p1.txt",
      displayTarget: "读取文件",
    });
    expect(readPersistedDelegationStepRequest({ capability: "write", displayTarget: "缺内容", path: "x.txt" })).toBeNull();
  });
});
