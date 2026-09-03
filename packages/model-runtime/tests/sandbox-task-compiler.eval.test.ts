import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { describe, expect, it } from "vitest";

import { compileNaturalLanguageSandboxTask } from "../src/index";

const live = process.env.RUN_LIVE_SANDBOX_TASK_EVAL === "true";
if (live) {
  try {
    loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // The assertion below reports model readiness without exposing env data.
  }
}

describe.skipIf(!live)("sandbox task compiler live eval", () => {
  it.each([
    {
      instruction: "请计算 1 到 1000 之间质数的数量，并打印前 20 个质数。",
      expectedExecution: true,
    },
    {
      instruction: "请解释什么是质数，不要使用任何工具。",
      expectedExecution: false,
    },
    {
      instruction: "读取我上传的 sales.csv，按地区汇总销售额。",
      expectedExecution: false,
    },
    {
      instruction: "访问 https://example.com 并总结网页内容。",
      expectedExecution: false,
    },
  ])("classifies $instruction", async ({ instruction, expectedExecution }) => {
    const result = await compileNaturalLanguageSandboxTask({ instruction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Boolean(result.task)).toBe(expectedExecution);
    }
  }, 120_000);
});
