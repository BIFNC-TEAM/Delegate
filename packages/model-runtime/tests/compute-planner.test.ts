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
      capability: "write",
      summary: "生成 notes/qa.txt",
      path: "notes/qa.txt",
      content: "browser QA",
    }))).toEqual({
      capability: "write",
      summary: "生成 notes/qa.txt",
      path: "notes/qa.txt",
      content: "browser QA",
    });
  });

  it("does not accept incomplete or non-compute plans", () => {
    expect(parseNaturalLanguageComputePlan('{"needsCompute":false}')).toBeNull();
    expect(parseNaturalLanguageComputePlan(JSON.stringify({
      needsCompute: true,
      capability: "browser",
      summary: "浏览网页",
    }))).toBeNull();
  });

  it("uses deterministic fallback only for explicit concrete actions", () => {
    expect(inferDeterministicNaturalLanguageComputePlan("打开 https://example.com 看看")).toMatchObject({
      capability: "browser",
      url: "https://example.com",
    });
    expect(inferDeterministicNaturalLanguageComputePlan("执行命令 `pwd`")).toMatchObject({
      capability: "exec",
      command: "pwd",
    });
    expect(inferDeterministicNaturalLanguageComputePlan("解释一下 Docker 沙盒")).toBeNull();
  });

  it("rejects model parameters that were not grounded in the user message", () => {
    expect(isNaturalLanguageComputePlanGrounded({
      capability: "browser",
      summary: "浏览网站",
      url: "https://example.com",
    }, "打开 https://example.com")).toBe(true);
    expect(isNaturalLanguageComputePlanGrounded({
      capability: "exec",
      summary: "运行命令",
      command: "curl https://private.example",
    }, "帮我运行一个检查")).toBe(false);
  });
});
