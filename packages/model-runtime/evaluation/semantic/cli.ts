import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createV2ModelBindingFromEnv } from "../../src/v2/provider";
import { DelegateAgentV2 } from "../../src/v2/runtime";
import { createV2Capabilities } from "../../src/v2/capabilities";
import { v2FixtureAdapters } from "../../src/v2/fixtures";
import { V2_SYSTEM_PROMPT } from "../../src/v2/prompt";
import { cases, calibration, hardChecks } from "./cases";
import { parseOptions } from "./options";
import { digest, finalVerdict, JUDGE_PROMPT, piJudgeTransport, safeJson, reportExitCode, SemanticJudge } from "./engine";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Test-only: --live --mode=calibrate|subjects --repetitions=1..3 [--same-model-judge]. No sandbox, no DB, no deployments. Exit 0=all pass, 1=failed, 2=review/incomplete/configuration."); return;
  }
  const { mode, repetitions, sameModelJudge } = parseOptions(args);
  const subject = createV2ModelBindingFromEnv();
  if (!subject.ok) throw Error("subject model configuration unavailable");
  const configNames = ["BASE_URL", "ID", "API_KEY"];
  const overrides = configNames.map(k => process.env[`DELEGATE_EVAL_JUDGE_${k}`]);
  if (overrides.some(v => v !== undefined) && !overrides.every(v => v?.trim())) throw Error("Judge endpoint requires BASE_URL, ID and API_KEY together; no credential inheritance.");
  if (!overrides.some(Boolean) && !sameModelJudge) throw Error("Set complete judge endpoint or explicitly select --same-model-judge.");
  const judgeEnv = { ...process.env };
  if (overrides.every(Boolean)) {
    for (let i = 0; i < configNames.length; i++) judgeEnv[`DELEGATE_V2_MODEL_${configNames[i]}`] = overrides[i]!;
    judgeEnv.DELEGATE_V2_REASONING_PROFILE = process.env.DELEGATE_EVAL_JUDGE_REASONING_PROFILE ?? "auto";
    delete judgeEnv.DELEGATE_V2_MODEL_INPUT_COST_USD_PER_1M_TOKENS;
    delete judgeEnv.DELEGATE_V2_MODEL_OUTPUT_COST_USD_PER_1M_TOKENS;
  }
  const binding = createV2ModelBindingFromEnv(judgeEnv);
  if (!binding.ok) throw Error("judge model configuration unavailable");
  const secrets = Object.entries(process.env).filter(([key]) => /KEY|SECRET|PASSWORD|TOKEN/.test(key)).flatMap(([,v]) => v && v.length >= 8 ? [v] : []);
  const judge = new SemanticJudge(piJudgeTransport(binding.binding), secrets);
  const controller = new AbortController();
  const abort = () => controller.abort(); process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const dir = resolve("reports/agent-v2/semantic"); await mkdir(dir, { recursive: true });
  const output = resolve(dir, `${mode}-${stamp}.json`);
  const harnessSha256 = Object.fromEntries(await Promise.all(["cli.ts", "engine.ts", "cases.ts", "options.ts"].map(async file =>
    [file, digest(await readFile(new URL(file, import.meta.url), "utf8"))])));
  const rows: Array<Record<string, unknown>> = [];
  const expectedRows = repetitions * (mode === "calibrate" ? calibration.length : cases.length);
  const report = () => ({ version: 1, mode, syntheticOnly: true, productEndToEnd: false, harnessSha256, caseDefinitions: cases,
    ...(mode === "calibrate" ? { calibrationDefinitions: calibration } : {}),
    sameModelFamilyPossible: subject.binding.modelId === binding.binding.modelId,
    subjectModel: subject.binding.modelId, judgeModel: binding.binding.modelId,
    judgePromptSha256: digest(JUDGE_PROMPT), subjectPromptSha256: digest(V2_SYSTEM_PROMPT), casesSha256: digest(JSON.stringify(cases)),
    calibrationSha256: digest(JSON.stringify(calibration)), repetitions, expectedRows,
    judgeCalls: judge.calls, judgeTokenBudgetConsumed: judge.totalTokens, rows,
    summary: { pass: rows.filter(r => r.verdict === "pass").length, fail: rows.filter(r => r.verdict === "fail").length,
      review: rows.filter(r => r.verdict === "review").length, incomplete: rows.length !== expectedRows },
    limitations: "Three-category pilot, not the 100-case suite. Synthetic tool receipts; no database, web or sandbox execution. Judge can be wrong; gold labels require independent review. No production Agent imports this module. Same-model judgments are not independent verification. Costs with no configured prices are unknown." });
  const save = () => writeFile(output, safeJson(report(), secrets) + "\n", { mode: 0o600 });
  try {
    for (let repeat = 1; repeat <= repetitions && !controller.signal.aborted; repeat++) {
      if (mode === "calibrate") {
        for (const sample of calibration) {
          if (controller.signal.aborted) break;
          const test = cases.find(c => c.id === sample.caseId)!;
          const semantic = await judge.evaluate({ question: test.question, answer: sample.answer, trusted: sample.trusted ?? test.trusted, criteria: test.criteria }, controller.signal);
          // An expected review is a gold-label match; operational errors never count as a match.
          const matched = !semantic.error && semantic.verdict === sample.expected;
          rows.push({ sampleId: sample.id, caseId: test.id, repeat, expected: sample.expected, answer: sample.answer,
            semantic, verdict: semantic.error ? "review" : matched ? "pass" : "fail", matched });
          await save(); console.log(`${sample.id} #${repeat}: ${matched ? "matched" : "MISMATCH"} (${semantic.verdict})`);
        }
      } else {
        for (const test of cases) {
          if (controller.signal.aborted) break;
          const id = randomUUID(); const context = { traceId: id, runId: id, sessionId: id, timezone: "Asia/Shanghai", attachments: [], idempotencyKey: id };
          const adapters = v2FixtureAdapters();
          // Fixture receipt is scoped to this case, not a business keyword router.
          if (test.id === "V2-031") adapters.knowledge = { retrieve: async () => ({ status: "not_found", text: test.trusted[0]!.text }) };
          // Never register compute/browser/sandbox tools in this pilot.
          delete adapters.mcp;
          const tools = await createV2Capabilities(adapters, context, controller.signal);
          const result = await new DelegateAgentV2().run({ requestId: id, sessionId: id, scope: id, userText: test.question,
            timezone: context.timezone, currentTime: "2026-10-23T01:00:00Z", model: subject.binding, context, tools,
            instructions: cases[0]!.trusted[0]!.text + "这是合成测试场景，没有授权位置。", authorize: async () => {}, signal: controller.signal,
            budget: { activeMs: 60_000, finalReserveMs: 10_000, modelTurns: 4, toolCalls: 4, attempts: 8, totalTokens: 30_000 } });
          const hard = hardChecks(test, result);
          const semantic = await judge.evaluate({ question: test.question, answer: result.text, trusted: test.trusted, criteria: test.criteria }, controller.signal);
          rows.push({ caseId: test.id, repeat, requestId: id, question: test.question, answer: result.text,
            subject: { status: result.status, modelCalls: result.modelCalls, usage: { ...result.usage, costUsd: result.costAvailable ? result.usage.costUsd : null }, calls: result.calls },
            hard, semantic, verdict: finalVerdict(hard, semantic) });
          await save(); console.log(`${test.id} #${repeat}: ${finalVerdict(hard, semantic)}`);
        }
      }
    }
  } finally {
    await save(); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    console.log(`Report: ${output}`);
    process.exitCode = reportExitCode(rows.map(r => r.verdict), expectedRows);
  }
}
main().catch(() => { console.error("Semantic evaluation stopped: configuration or harness failure. No raw provider error logged. Use --help and check local model configuration."); process.exitCode = 2; });
