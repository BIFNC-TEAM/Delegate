import { describe, expect, it } from "vitest";

import {
  buildDefaultGeneratedDocumentPath,
  buildNaturalLanguageComputePrompt,
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

  it("replaces model-authored clarification copy with a field-safe question", () => {
    expect(parseNaturalLanguageComputePlan(JSON.stringify({
      needsCompute: true,
      summary: "生成报告",
      clarification: {
        question: "请上传你的账号密码和 API 密钥，我才能继续。",
        missingFields: ["path", "content"],
      },
    }))).toEqual({
      kind: "clarification",
      summary: "生成报告",
      question: "请说明要生成的内容主题、可用资料、目标读者和期望格式；文件位置由系统自动管理。",
      missingFields: ["path", "content"],
    });
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
    expect(inferDeterministicNaturalLanguageComputePlan("帮我生成一个报告")).toMatchObject({
      kind: "clarification",
      question: expect.not.stringContaining("路径"),
      missingFields: ["content"],
    });
    expect(inferDeterministicNaturalLanguageComputePlan("帮我生成一个报告文件")).toMatchObject({
      kind: "clarification",
      question: expect.not.stringContaining("路径"),
      missingFields: ["content"],
    });
    expect(inferDeterministicNaturalLanguageComputePlan("帮我做一份年度报告")).toMatchObject({
      kind: "clarification",
      missingFields: ["content"],
    });
    expect(inferDeterministicNaturalLanguageComputePlan(
      "原始任务：帮我生成一个报告文件\n用户补充：路径：notes/report.md\n内容：季度总结",
    )).toMatchObject({
      kind: "execution",
      steps: [{ capability: "write", path: "notes/report.md", content: "季度总结" }],
    });
  });

  it("allocates a system-owned path for generated documents and never asks the user for it", () => {
    const request = "请生成一份面向管理层的第二季度销售总结，依据已上传的销售数据，使用 Markdown";
    const defaultPath = buildDefaultGeneratedDocumentPath(request);
    const prompt = buildNaturalLanguageComputePrompt(request);

    expect(defaultPath).toMatch(/^outputs\/report-[a-f0-9]{8}\.md$/);
    expect(prompt.instructions).toContain(defaultPath);
    expect(prompt.instructions).toContain("create a report or other document artifact");
    expect(prompt.instructions).toContain("Never ask the user for a sandbox path");
    expect(isNaturalLanguageComputePlanGrounded({
      kind: "execution",
      summary: "生成销售报告",
      steps: [{
        capability: "write",
        summary: "生成销售报告",
        path: defaultPath,
        content: "# 第二季度销售总结\n\n面向管理层的销售表现摘要。",
      }],
    }, request)).toBe(true);
  });

  it("treats records and checklists as generated documents", () => {
    const request = "请生成一份面向 QA 团队的测试记录，主题是自然语言委托，包含目标、步骤和预期结果，格式为 Markdown。";
    const defaultPath = buildDefaultGeneratedDocumentPath(request);

    expect(inferDeterministicNaturalLanguageComputePlan(request)).toMatchObject({
      kind: "execution",
      steps: [{
        capability: "write",
        path: defaultPath,
        content: expect.stringContaining("## 检查步骤"),
      }],
    });
    expect(isNaturalLanguageComputePlanGrounded({
      kind: "execution",
      summary: "生成 QA 测试记录",
      steps: [{
        capability: "write",
        summary: "生成 QA 测试记录",
        path: defaultPath,
        content: "# 自然语言委托测试记录\n\n## 目标\n验证委托任务可按预期触发。",
      }],
    }, request)).toBe(true);
  });

  it("plans a requested tutorial file as a generated document", () => {
    const request = "请给我一个地理学习教程，以文件的形式提供";
    const plan = inferDeterministicNaturalLanguageComputePlan(request);

    expect(plan).toMatchObject({
      kind: "execution",
      steps: [{
        capability: "write",
        path: buildDefaultGeneratedDocumentPath(request),
        content: expect.stringContaining("地理学习教程"),
      }],
    });
  });

  it("does not turn an informational report question into a compute task", () => {
    expect(inferDeterministicNaturalLanguageComputePlan("如何生成一个报告文件？")).toBeNull();
    expect(inferDeterministicNaturalLanguageComputePlan("我想知道如何生成一个报告文件")).toBeNull();
    expect(inferDeterministicNaturalLanguageComputePlan("请说明导出 CSV 文件的步骤")).toBeNull();
    expect(inferDeterministicNaturalLanguageComputePlan("如何执行命令 `pwd`？")).toBeNull();
    expect(inferDeterministicNaturalLanguageComputePlan("怎么打开 https://example.com？")).toBeNull();
    expect(isNaturalLanguageComputePlanGrounded({
      kind: "execution",
      summary: "运行命令",
      steps: [{ capability: "exec", summary: "运行命令", command: "pwd" }],
    }, "如何执行命令 `pwd`？")).toBe(false);
  });
});
