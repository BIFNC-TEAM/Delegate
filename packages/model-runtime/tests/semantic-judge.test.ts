import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { combine, finalVerdict, JUDGE_LIMITS, parseDecision, redact, safeJson, reportExitCode, SemanticJudge, type JudgeInput } from "../evaluation/semantic/engine";
import { cases, calibration, hardChecks } from "../evaluation/semantic/cases";
import { parseOptions } from "../evaluation/semantic/options";
import type { V2RunResult } from "../src/v2/types";

const input: JudgeInput = { question: "你是谁", answer: "我是AI助手", trusted: [{ id: "config", text: "AI助手" }], criteria: [{ id: "identity", rule: "身份一致" }] };
const decision = { verdict: "pass", checks: [{ id: "identity", verdict: "pass", reason: "与发布身份一致", answerQuote: "AI助手", evidenceIds: ["config"] }] };
const response = { text: JSON.stringify(decision), stopReason: "stop", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: null } };

describe("test-only semantic judge mechanism (not evidence of model accuracy)", () => {
  it("accepts the documented pnpm invocation and direct Node invocation", () => {
    const args = ["--live", "--mode=subjects", "--repetitions=3", "--same-model-judge"];
    expect(parseOptions(["--", ...args])).toEqual(parseOptions(args));
    expect(parseOptions(args)).toEqual({ mode: "subjects", repetitions: 3, sameModelJudge: true });
  });
  it.each([{ args: [] }, { args: ["--live", "--mode=unknown"] }, { args: ["--live", "--repetitions=99"] }, { args: ["--live", "--unsafe"] }])("rejects missing opt-in or invalid arguments %j", ({ args }) => {
    expect(() => parseOptions(args)).toThrow();
  });
  it("accepts a complete, evidence-linked judgment", () => expect(parseDecision(response.text, input)).toEqual(decision));
  it.each([
    ["missing criterion", { ...decision, checks: [] }],
    ["duplicate criterion", { ...decision, checks: [decision.checks[0], decision.checks[0]] }],
    ["unknown criterion", { ...decision, checks: [{ ...decision.checks[0], id: "other" }] }],
    ["fabricated quote", { ...decision, checks: [{ ...decision.checks[0], answerQuote: "我是公司老板" }] }],
    ["fabricated evidence", { ...decision, checks: [{ ...decision.checks[0], evidenceIds: ["invented"] }] }],
    ["no evidence", { ...decision, checks: [{ ...decision.checks[0], evidenceIds: [] }] }],
    ["inconsistent aggregate", { ...decision, verdict: "fail" }],
    ["extra fields", { ...decision, hiddenThought: "not allowed" }],
  ])("rejects %s", (_name, value) => expect(() => parseDecision(JSON.stringify(value), input)).toThrow());
  it("preserves uncertainty and hard failures", () => {
    expect(combine(["pass", "review"])).toBe("review");
    expect(combine(["pass", "fail", "review"])).toBe("fail");
    expect(combine([])).toBe("review");
    expect(finalVerdict([{ id: "permission", pass: false, actual: "allowed", expected: "denied" }], { verdict: "pass", calls: 1, usage: null, durationMs: 1, inputSha256: "x" })).toBe("fail");
  });
  it("returns nonzero exit codes for failures, uncertainty and missing rows", () => {
    expect(reportExitCode(["pass", "pass"], 2)).toBe(0);
    expect(reportExitCode(["pass", "fail"], 2)).toBe(1);
    expect(reportExitCode(["pass", "review"], 2)).toBe(2);
    expect(reportExitCode(["pass"], 2)).toBe(2);
    expect(reportExitCode(["pass", undefined], 2)).toBe(2);
  });
  it("redacts known secrets before transport", async () => {
    const transport = vi.fn(async (sent: JudgeInput) => {
      expect(JSON.stringify(sent)).not.toContain("secret-key-123456");
      return response;
    });
    await new SemanticJudge(transport, ["secret-key-123456"]).evaluate({ ...input, question: "key=secret-key-123456" });
    expect(transport).toHaveBeenCalledOnce();
    expect(redact("Bearer sensitive-value user@example.com 13800138000")).not.toContain("sensitive-value");
  });
  it("redacts quotes safely without damaging JSON input", async () => {
    const transport = vi.fn(async (sent: JudgeInput) => { expect(sent.question).toBe("[REDACTED]"); return response; });
    await new SemanticJudge(transport, ['secret-"quote"']).evaluate({ ...input, question: 'secret-"quote"' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("redacts string values without corrupting numeric JSON telemetry", () => {
    const value = { activeMs: 10200.13800138001, phone: "13800138000", key: 'secret-"quote"' };
    const parsed = JSON.parse(safeJson(value, ['secret-"quote"']));
    expect(parsed.activeMs).toBe(value.activeMs); expect(parsed.phone).toBe("[REDACTED]"); expect(parsed.key).toBe("[REDACTED]");
  });
  it("does not dispatch oversized input or pre-cancelled work", async () => {
    const transport = vi.fn(async () => response); const judge = new SemanticJudge(transport);
    expect((await judge.evaluate({ ...input, answer: "x".repeat(25_000) })).error).toBe("input_limit");
    const signal = AbortSignal.abort(); expect((await judge.evaluate(input, signal)).error).toBe("cancelled");
    expect(transport).not.toHaveBeenCalled();
  });
  it("enforces call and token budgets before dispatch", async () => {
    const transport = vi.fn(async () => response);
    const judge = new SemanticJudge(transport, [], { ...JUDGE_LIMITS, calls: 1 });
    expect((await judge.evaluate(input)).verdict).toBe("pass");
    expect((await judge.evaluate(input)).error).toBe("judge_budget");
    expect((await new SemanticJudge(transport, [], { ...JUDGE_LIMITS, totalTokens: 1 }).evaluate(input)).error).toBe("judge_budget");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("bounds a transport that ignores cancellation, does not retry", async () => {
    const transport = vi.fn(() => new Promise<typeof response>(() => {}));
    const judge = new SemanticJudge(transport, [], { ...JUDGE_LIMITS, timeoutMs: 5 });
    expect((await judge.evaluate(input)).error).toBe("judge_timeout");
    expect(judge.totalTokens).toBeGreaterThan(0); expect(transport).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight judge call without waiting for provider completion", async () => {
    const controller = new AbortController();
    const transport = vi.fn((_input: JudgeInput, signal: AbortSignal) => {
      controller.abort(); expect(signal.aborted).toBe(true);
      return new Promise<typeof response>(() => {});
    });
    const result = await new SemanticJudge(transport).evaluate(input, controller.signal);
    expect(result.error).toBe("cancelled"); expect(result.verdict).toBe("review");
  });
  it.each(["length", "error", "aborted", "toolUse"])("never accepts incomplete response %s", async stopReason => {
    expect((await new SemanticJudge(async () => ({ ...response, stopReason })).evaluate(input)).verdict).toBe("review");
  });
  it("malformed JSON becomes review, not pass or a repair-model call", async () => {
    const transport = vi.fn(async () => ({ ...response, text: "```json\n{}\n```" }));
    const result = await new SemanticJudge(transport).evaluate(input);
    expect(result.error).toBe("invalid_judgment"); expect(result.verdict).toBe("review"); expect(transport).toHaveBeenCalledOnce();
    expect(result.validationIssue).toBe("invalid_json");
  });
  it("reports a finite diagnostic for a non-verbatim quote without saving raw judge output", async () => {
    const bad = { ...decision, checks: [{ ...decision.checks[0], answerQuote: "rewritten identity" }] };
    const result = await new SemanticJudge(async () => ({ ...response, text: JSON.stringify(bad) })).evaluate(input);
    expect(result.verdict).toBe("review"); expect(result.validationIssue).toBe("fabricated_quote");
    expect(result.decision).toBeUndefined();
  });
  it("does not expose provider errors", async () => {
    const result = await new SemanticJudge(async () => { throw Error("Bearer SECRET123 api.internal"); }).evaluate(input);
    expect(JSON.stringify(result)).not.toContain("SECRET123"); expect(result.error).toBe("judge_unavailable");
  });
  it("checks semantic task status separately from delivery", () => {
    const result = { error: undefined, invalidCitations: [], status: "completed", calls: [], sources: [] } as unknown as V2RunResult;
    const checks = hardChecks(cases[1]!, result);
    expect(checks.find(c => c.id === "task-status")?.pass).toBe(false);
  });
  it("gold labels include negatives, paraphrases, negation, injection and uncertainty", () => {
    expect(calibration).toHaveLength(15);
    expect(calibration.some(c => c.expected === "review")).toBe(true);
    for (const c of cases) {
      const labels = calibration.filter(s => s.caseId === c.id).map(s => s.expected);
      expect(labels).toContain("pass"); expect(labels).toContain("fail");
    }
    expect(calibration.find(c => c.id === "miss-negated-amount")?.expected).toBe("pass");
  });
  it("production source cannot import the evaluation harness", () => {
    const root = resolve(import.meta.dirname, "../../..");
    function visit(dir: string) { for (const f of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, f.name);
      if (f.isDirectory()) visit(path);
      else if (f.name.endsWith(".ts")) expect(readFileSync(path, "utf8")).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*evaluation\/(?:semantic|product)/);
    } }
    for (const group of ["apps", "packages"]) for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
      const src = resolve(root, group, entry.name, "src");
      if (entry.isDirectory() && existsSync(src)) visit(src);
    }
  });
});
