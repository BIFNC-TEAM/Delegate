import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPiModelBindingFromEnv } from "../pi/provider";
import { DelegatePiAgentRuntime } from "../pi/runtime";
import { createV2Capabilities } from "./capabilities";
import { DelegateAgentV2 } from "./runtime";
import { v2FixtureAdapters } from "./fixtures";
import type { V2Session } from "./types";
import { fingerprint } from "./guards";
import { createV2ModelBindingFromEnv } from "./provider";
import { resolveV2Budget } from "./config";
import { V2_SYSTEM_PROMPT } from "./prompt";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { checkV2EvaluationCase, v2CoreEvaluationCases, v2ClarificationEvaluationCases } from "./evaluation-cases";

/** Real model decisions; controlled tool data. No scripted calls in this evaluation. */
const args = process.argv.slice(2);
if (!args.includes("--live")) throw new Error("Evaluation requires --live; use test:agent:v2 for deterministic mechanism tests.");
const compare = args.includes("--compare");
const repeats = Number(args.find(a => a.startsWith("--repetitions="))?.split("=")[1] ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("repetitions must be 1..10");
const suite = args.find(a => a.startsWith("--suite="))?.slice(8) ?? "core";
if (!["core", "clarification"].includes(suite)) throw new Error("Unknown evaluation suite");
const cases = suite === "clarification" ? v2ClarificationEvaluationCases : v2CoreEvaluationCases;
const only = args.find(a => a.startsWith("--ids="))?.slice(6).split(",");
const selected = cases.filter(c => !only || only.includes(c.id));
if (!selected.length || only?.some(id => !cases.some(c => c.id === id))) throw new Error("Unknown/empty evaluation case selection");
const evaluationBudget = resolveV2Budget();
const binding = createPiModelBindingFromEnv({ ...process.env, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(evaluationBudget.outputTokens) });
if (!binding.ok) throw new Error(binding.reason);
const v2Binding = createV2ModelBindingFromEnv();
if (!v2Binding.ok) throw new Error(v2Binding.reason);
const newMeasurement = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, thinkingMessages: 0 });
let measurement = newMeasurement();
const measureStream = (fn: StreamFn): StreamFn => async (model, context, options) => {
  const captured = measurement;
  captured.requests++;
  const stream = await fn(model, context, { ...options, temperature: 0 });
  // PI 0.85.1 result() only observes the final-result promise; it does not consume
  // the event iterator. Normalize cached input for both versions identically.
  void stream.result().then(message => {
    captured.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    captured.outputTokens += message.usage.output;
    captured.totalTokens += message.usage.totalTokens;
    captured.cacheReadTokens += message.usage.cacheRead;
    captured.thinkingMessages += message.content.filter(c => c.type === "thinking").length;
  });
  return stream;
};
for (const bound of [binding.binding, v2Binding.binding]) {
  bound.streamFn = measureStream(bound.streamFn);
  const observedStream = bound.createObservedStreamFn;
  if (observedStream) bound.createObservedStreamFn = (observer, beforeRequest) => measureStream(observedStream(observer, beforeRequest));
}
const rows: Array<Record<string, unknown>> = [];
const resumptions: Array<{ id: string; repeat: number; session?: V2Session; message: string }> = [];
const outputDir = resolve("reports/agent-v2");
await mkdir(outputDir, { recursive: true });
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
const evaluationScope = `fixture-evaluation:${stamp}`;
const output = resolve(outputDir, `evaluation-${stamp}.json`);
const harnessSha256 = fingerprint(await readFile(new URL("./evaluate.ts", import.meta.url), "utf8"));
const casesSha256 = fingerprint(await readFile(new URL("./evaluation-cases.ts", import.meta.url), "utf8"));
const capabilitySha256 = fingerprint(await readFile(new URL("./capabilities.ts", import.meta.url), "utf8"));
const fixtureSha256 = fingerprint(await readFile(new URL("./fixtures.ts", import.meta.url), "utf8"));
const providerSha256 = fingerprint(await readFile(new URL("./provider.ts", import.meta.url), "utf8"));
const reasoningModel = v2Binding.binding.model;
const reasoningFormat = reasoningModel.api === "openai-completions" && reasoningModel.compat && "thinkingFormat" in reasoningModel.compat
  ? reasoningModel.compat.thinkingFormat ?? null : null;
const persist = () => writeFile(output, JSON.stringify({ suite, harnessSha256, casesSha256, capabilitySha256, fixtureSha256, providerSha256, v2Reasoning: { enabled: reasoningModel.reasoning && evaluationBudget.thinkingTokens > 0, format: reasoningFormat, maximumThinkingTokens: evaluationBudget.thinkingTokens, maximumOutputTokens: evaluationBudget.outputTokens }, caseIds: selected.map(c => c.id), expectedResumeCount: selected.filter(c => c.resumeWith).length * repeats, mode: "real-model-controlled-tools", provider: binding.binding.provider, model: binding.binding.modelId, temperature: 0, promptSha256: fingerprint(V2_SYSTEM_PROMPT), repeats,
  conditions: "Synthetic internal policy, weather and calculator tools. No production credentials/data sent to tools. No semantic judge model. Checks below are fixture/path checks, not proof of arbitrary answer entailment. Alternating variant order; no global performance claim.", rows }, null, 2));
for (let repeat = 0; repeat < repeats; repeat++) for (const [index, test] of selected.entries()) {
  for (const variant of compare ? index % 2 ? ["old", "v2"] : ["v2", "old"] : ["v2"]) {
    const id = `${stamp}:${test.id}-${repeat}-${variant}`;
    const capabilities = v2FixtureAdapters();
    if (test.emptyKnowledge) capabilities.knowledge = { retrieve: async () => ({ status: "not_found", text: "The authorized internal library contains no records for this request." }) };
    const context = { traceId: id, runId: id, sessionId: id, timezone: "Asia/Shanghai", attachments: [], idempotencyKey: id };
    const started = performance.now();
    measurement = newMeasurement();
    try {
      const result = variant === "v2"
        ? await new DelegateAgentV2().run({ requestId: id, sessionId: id, scope: evaluationScope, userText: test.question, timezone: context.timezone,
            currentTime: "2026-10-19T01:00:00Z", context, model: v2Binding.binding,
            ...(test.authorizedUserLocation ? { authorizedUserLocation: test.authorizedUserLocation } : {}),
            instructions: "你代表星河科技。这是隔离模拟场景，问题指场景内的情况；已注册工具的真实返回值定义场景内事实，包括场景内实时数据。请实际调用工具，禁止自行编造场景事实。回答标明模拟场景，不能把它当成现实资讯。" + (test.instructions ?? ""),
            tools: await createV2Capabilities(capabilities, context, new AbortController().signal), authorize: async () => undefined,
            budget: { ...evaluationBudget, activeMs: 120000, finalReserveMs: 15000, modelTurns: 6 } })
        : await new DelegatePiAgentRuntime().run({ runId: id, sessionId: id, userText: test.question, currentTime: "2026-10-19T01:00:00Z", timezone: context.timezone,
            representative: { name: "星河科技测试代理", ownerName: "星河科技", role: "对外通用代理", agentBehavior: { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "information_only" }, instructions: "这是隔离模拟场景，问题指场景内的情况；已注册工具的真实返回值定义场景内事实，包括场景内实时数据。请实际调用工具，禁止自行编造场景事实。回答标明模拟场景，不能把它当成现实资讯。" },
            model: binding.binding, capabilities, executionProtocol: "goal_v2", reviewMode: "bounded_v1", knowledgePrefetch: "ordinary_questions_v1", timeoutMs: 60000, maxSteps: 6 });
      if (variant === "v2" && test.resumeWith) resumptions.push({ id: test.id, repeat, message: test.resumeWith,
        ...(result.status === "waiting_user" && "session" in result && result.session ? { session: JSON.parse(JSON.stringify(result.session)) as V2Session } : {}) });
      const toolNames = result.events.filter(e => e.type === "tool.started").map(e => e.toolName!);
      const ragCalls = toolNames.filter(n => n === "retrieve_authorized_knowledge").length;
      const webCalls = toolNames.filter(n => n === "search_current_web").length;
      const checks = checkV2EvaluationCase(test, result, toolNames);
      rows.push({ id: test.id, requestId: id, question: test.question, authorizedUserLocation: test.authorizedUserLocation ?? null,
        repeat, variant, status: result.status, checks, fixtureChecksPass: Object.values(checks).every(Boolean), text: result.text,
        sources: result.sources, ...("invalidCitations" in result ? { invalidCitations: result.invalidCitations } : {}), durationMs: performance.now() - started, firstTextMs: result.firstTextMs ?? null,
        firstFinalOutputMs: variant === "v2" ? result.firstTextMs ?? null : null,
        modelCalls: measurement.requests, runtimeModelCalls: result.modelCalls, toolCalls: result.toolCalls, toolNames, ragCalls, ragDurationMs: result.spans.filter(s => s.module === "knowledge").reduce((n, s) => n + s.durationMs, 0),
        inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens,
        totalTokens: measurement.totalTokens, cacheReadTokens: measurement.cacheReadTokens, thinkingMessages: measurement.thinkingMessages,
        error: result.error ?? null });
      process.stdout.write(`${id}: ${result.status}; model=${result.modelCalls}; tool=${result.toolCalls}; fixtureChecks=${Object.values(checks).every(Boolean)}\n`);
    } catch { rows.push({ id: test.id, question: test.question, repeat, variant, status: "harness_failed", durationMs: performance.now() - started }); process.stdout.write(`${id}: harness_failed\n`); }
    await persist();
  }
}
for (const resumed of resumptions) {
  const id = `${resumed.id}-resume-${resumed.repeat}`;
  if (!resumed.session) {
    rows.push({ id, repeat: resumed.repeat, resumedFrom: resumed.id, variant: "v2", status: "not_resumed", reason: "initial_turn_did_not_wait", fixtureChecksPass: false });
    await persist();
    continue;
  }
  measurement = newMeasurement();
  const requestId = `${stamp}:${id}`;
  const context = { traceId: requestId, runId: requestId, sessionId: resumed.session.taskId, timezone: "Asia/Shanghai", attachments: [], idempotencyKey: requestId };
  const result = await new DelegateAgentV2().run({ requestId, sessionId: context.sessionId, scope: evaluationScope, userText: resumed.message, timezone: context.timezone,
    currentTime: "2026-10-19T01:00:00Z", context, model: v2Binding.binding, session: resumed.session,
    instructions: "继续隔离模拟场景中的任务；使用真实工具返回的场景数据，不要编造或把场景数据当成现实资讯。",
    tools: await createV2Capabilities(v2FixtureAdapters(), context, new AbortController().signal), authorize: async () => undefined, budget: evaluationBudget });
  const checks = checkV2EvaluationCase({ id, question: resumed.message, rag: false, web: true, fact: "20" }, result, result.events.filter(e => e.type === "tool.started").map(e => e.toolName!));
  rows.push({ id, requestId, repeat: resumed.repeat, resumedFrom: resumed.id, variant: "v2", status: result.status, text: result.text, modelCalls: result.modelCalls, toolCalls: result.toolCalls, taskUsage: result.taskUsage,
    toolNames: result.events.filter(e => e.type === "tool.started").map(e => e.toolName!),
    sources: result.sources, checks, thinkingMessages: measurement.thinkingMessages, durationMs: result.totalDurationMs, inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens,
    fixtureChecksPass: Object.values(checks).every(Boolean) });
  process.stdout.write(`${id}: ${result.status}; fixtureChecks=${Object.values(checks).every(Boolean)}\n`);
  await persist();
}
process.stdout.write(`Report: ${output}\n`);
