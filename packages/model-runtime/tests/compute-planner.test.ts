import { describe, expect, it } from "vitest";

import {
  inferDeterministicNaturalLanguageComputePlan,
  isNaturalLanguageComputePlanGrounded,
  parseNaturalLanguageComputePlan,
} from "../src/compute-planner";

describe("natural-language compute planner", () => {
  it("parses a validated structured write plan", () => {
    expect(parseNaturalLanguageComputePlan(JSON.stringify({
      needsCompute: true,
      summary: "生成并读取 notes/qa.txt",
      steps: [
        { capability: "write", summary: "生成 notes/qa.txt", path: "notes/qa.txt", content: "browser QA" },
        { capability: "read", summary: "读取 notes/qa.txt", path: "notes/qa.txt" },
      ],
    }))).toEqual({
      kind: "execution",
      summary: "生成并读取 notes/qa.txt",
      steps: [
        { capability: "write", summary: "生成 notes/qa.txt", path: "notes/qa.txt", content: "browser QA" },
        { capability: "read", summary: "读取 notes/qa.txt", path: "notes/qa.txt" },
      ],
    });
  });

  it("does not accept incomplete or non-compute plans", () => {
    expect(parseNaturalLanguageComputePlan('{"needsCompute":false}')).toBeNull();
    expect(parseNaturalLanguageComputePlan(JSON.stringify({
      needsCompute: true,
      summary: "浏览网页",
      steps: [{ capability: "browser", summary: "浏览网页" }],
    }))).toBeNull();
  });

  it("uses deterministic fallback only for explicit concrete actions", () => {
    expect(inferDeterministicNaturalLanguageComputePlan("打开 https://example.com 看看")).toMatchObject({
      kind: "execution",
      steps: [{ capability: "browser", url: "https://example.com" }],
    });
    expect(inferDeterministicNaturalLanguageComputePlan("执行命令 `pwd`")).toMatchObject({
      kind: "execution",
      steps: [{ capability: "exec", command: "pwd" }],
    });
    expect(inferDeterministicNaturalLanguageComputePlan("解释一下 Docker 沙盒")).toBeNull();
  });

  it("rejects model parameters that were not grounded in the user message", () => {
    expect(isNaturalLanguageComputePlanGrounded({
      kind: "execution",
      summary: "浏览网站",
      steps: [{ capability: "browser", summary: "浏览网站", url: "https://example.com" }],
    }, "打开 https://example.com")).toBe(true);
    expect(isNaturalLanguageComputePlanGrounded({
      kind: "execution",
      summary: "运行命令",
      steps: [{ capability: "exec", summary: "运行命令", command: "curl https://private.example" }],
    }, "帮我运行一个检查")).toBe(false);
  });

  it("creates a clarification plan instead of inventing missing file inputs", () => {
    expect(inferDeterministicNaturalLanguageComputePlan("帮我生成一个报告文件")).toMatchObject({
      kind: "clarification",
      missingFields: ["path", "content"],
    });
    expect(inferDeterministicNaturalLanguageComputePlan(
      "原始任务：帮我生成一个报告文件\n用户补充：路径：notes/report.md\n内容：季度总结",
    )).toMatchObject({
      kind: "execution",
      steps: [{ capability: "write", path: "notes/report.md", content: "季度总结" }],
    });
  });
});
