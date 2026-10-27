import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createV2ModelBindingFromEnv } from "../../src/v2/provider";
import { digest, finalVerdict, JUDGE_LIMITS, JUDGE_PROMPT, piJudgeTransport, safeJson, reportExitCode, SemanticJudge, type HardCheck } from "../semantic/engine";
import { PRODUCT_LIMITS, PRODUCT_SCOPE } from "./scope";
import { openProductStore, type ProductObservation, type ProductSnapshot } from "./store";
import { ProductClient } from "./client";
import { assertProductStep, productCases } from "./cases";
import { readTestDeployment } from "./deployment";

export function safeError(error: unknown) {
  return error instanceof Error && /^[a-z][a-z0-9_]{2,69}$/.test(error.message) ? error.message : "harness_failure";
}
async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--");
  if (args.includes("--help")) { console.log("--live [--prepare] [--prepare-only] --same-model-judge [--repetitions=1..3] [--ids=V2-001,...]. Fixed isolated 13002/15432; cloud capabilities must be denied. Exit 0=pass,1=fail,2=incomplete/review."); return; }
  if (!args.includes("--live") || args.some(a => !["--live", "--prepare", "--prepare-only", "--same-model-judge"].includes(a) && !/^--(?:repetitions|ids)=/.test(a))) throw Error("invalid_arguments");
  const repeats = Number(args.find(a => a.startsWith("--repetitions="))?.split("=")[1] ?? 3);
  const ids = args.find(a => a.startsWith("--ids="))?.split("=")[1]?.split(",");
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || ids?.some(id => !productCases.some(c => c.id === id))) throw Error("invalid_selection");
  const selected = productCases.filter(c => !ids || ids.includes(c.id));
  const expected = selected.reduce((sum, c) => sum + c.variants.length, 0) * repeats;
  const controller = new AbortController(); const abort = () => controller.abort(); process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const secrets = Object.entries(process.env).filter(([k]) => /KEY|SECRET|PASSWORD|TOKEN/.test(k)).flatMap(([,v]) => v && v.length >= 8 ? [v] : []);
  const directory = resolve("reports/agent-v2/product10"); await mkdir(directory, { recursive: true });
  const output = resolve(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  const hashes = Object.fromEntries(await Promise.all(["cli.ts", "client.ts", "store.ts", "scope.ts", "cases.ts", "deployment.ts", "../semantic/engine.ts"].map(async name => [name, digest(await readFile(new URL(name, import.meta.url), "utf8"))])));
  const deployment = await readTestDeployment();
  const rows: any[] = []; let snapshot: ProductSnapshot | undefined; let fatal: string | undefined; let judge: SemanticJudge | undefined; let judgeModel: string | undefined;
  let finalSafety: { noNewLeases: boolean; noNewBrowserSessions: boolean; pinnedVersion: boolean } | undefined;
  const summarize = () => selected.map(c => {
    const caseRows = rows.filter(r => r.caseId === c.id); const total = c.variants.length * repeats;
    return { id: c.id, variants: c.variants.map(v => v.id), expectedRows: total, actualRows: caseRows.length,
      verdict: caseRows.some(r => r.verdict === "fail") ? "fail" : caseRows.length !== total || caseRows.some(r => r.verdict !== "pass") ? "review" : "pass" };
  });
  const save = () => writeFile(output, safeJson({ version: 1, scope: PRODUCT_SCOPE, mode: args.includes("--prepare-only") ? "fixture-preparation" : "real-product-api-sse-db", syntheticBusinessData: true,
    deployment, harnessSha256: hashes, judgePromptSha256: digest(JUDGE_PROMPT), judgeModel,
    sameModelJudgeRequested: args.includes("--same-model-judge"), independentWeightsVerified: false,
    definitions: selected, repeats, expectedRows: expected, rows, summary: summarize(), fatal, finalSafety,
    fixture: snapshot ? { representativeId: snapshot.representativeId, versionId: snapshot.versionId, publishedAt: snapshot.publishedAt, identity: snapshot.identity,
      resources: snapshot.resources, capabilityModes: snapshot.capabilityModes, mcp: snapshot.mcp, sandboxLeases: snapshot.sandboxLeases, browserSessions: snapshot.browserSessions } : null,
    judgeCalls: judge?.calls ?? 0, judgeTokenBudgetConsumed: judge?.totalTokens ?? 0,
    limitations: "Ten-case product batch with synthetic business fixtures, real RAG and MCP. No cloud sandbox tests. Reference data and observed citations are separate. A model judgment is fallible. Does not update historical 100-case PASS labels or certify performance." }, secrets) + "\n", { mode: 0o600 });
  let store: Awaited<ReturnType<typeof openProductStore>> | undefined;
  try {
    store = await openProductStore();
    snapshot = args.includes("--prepare") || args.includes("--prepare-only") ? await store.prepare() : await store.preflight();
    await save();
    if (args.includes("--prepare-only")) { console.log("Dedicated fixture prepared and safety checked."); return; }
    const env = { ...process.env }; const override = ["BASE_URL", "ID", "API_KEY"].map(k => env[`DELEGATE_EVAL_JUDGE_${k}`]);
    if (override.some(v => v !== undefined)) {
      if (!override.every(v => v?.trim())) throw Error("judge_connection_incomplete");
      ["BASE_URL", "ID", "API_KEY"].forEach((k,i) => { env[`DELEGATE_V2_MODEL_${k}`] = override[i]!; });
      env.DELEGATE_V2_REASONING_PROFILE = env.DELEGATE_EVAL_JUDGE_REASONING_PROFILE ?? "auto";
      delete env.DELEGATE_V2_MODEL_INPUT_COST_USD_PER_1M_TOKENS; delete env.DELEGATE_V2_MODEL_OUTPUT_COST_USD_PER_1M_TOKENS;
    } else if (!args.includes("--same-model-judge")) throw Error("judge_selection_required");
    const binding = createV2ModelBindingFromEnv(env); if (!binding.ok) throw Error("judge_configuration_missing");
    judgeModel = binding.binding.modelId;
    judge = new SemanticJudge(piJudgeTransport(binding.binding), secrets, { ...JUDGE_LIMITS, calls: PRODUCT_LIMITS.judgeCalls, totalTokens: PRODUCT_LIMITS.judgeTokens });
    for (let repeat = 1; repeat <= repeats; repeat++) for (const test of selected) for (const variant of test.variants) {
      if (controller.signal.aborted) throw Error("cancelled");
      const current = await store.preflight(); if (current.versionId !== snapshot.versionId || current.sandboxLeases !== snapshot.sandboxLeases || current.browserSessions !== snapshot.browserSessions) throw Error("fixture_changed_or_cloud_activity");
      const client = new ProductClient(controller.signal); const observed: ProductObservation[] = []; const hard: HardCheck[] = [];
      const row: any = { caseId: test.id, variant: variant.id, repeat, startedAt: new Date().toISOString(), verdict: "review", observed, hard, admissions: client.admissions };
      rows.push(row);
      try {
        for (const step of variant.steps) {
          const previous = observed.at(-1);
          const response = await client.turn(step.question);
          const actual = await store.observe(response.runId, snapshot.versionId);
          hard.push(...assertProductStep(test, step, actual, snapshot.versionId, previous));
          hard.push({ id: "sse-db-answer-match", pass: response.answer === actual.answer, actual: digest(response.answer), expected: digest(actual.answer) });
          observed.push(actual); await save(); console.log(`${test.id}/${variant.id} #${repeat}: ${actual.taskStatus} ${actual.runId}`);
        }
        const artifacts = [];
        for (const observation of observed) for (const receipt of observation.receipts) for (const artifact of receipt.artifacts) {
          if (artifacts.length >= 8 || artifact.sizeBytes > 128_000) throw Error("evidence_size_limit");
          const text = await client.readArtifact(artifact.id);
          artifacts.push({ executionId: receipt.id, id: artifact.id, sha256: digest(text), excerpt: text.slice(0, 6000), truncated: text.length > 6000 });
        }
        row.toolEvidence = artifacts;
        const trusted = [
          { id: "published-identity", text: JSON.stringify({ ...snapshot.identity, capabilities: snapshot.capabilityModes, mcp: snapshot.mcp }) },
          { id: "published-corpus", text: JSON.stringify(snapshot.resources) },
          { id: "actual-retrieval", text: JSON.stringify(observed.map(o => ({ runId: o.runId, versionId: o.versionId, retrieval: o.retrieval, injectedKnowledge: o.knowledge, sources: o.sources }))) },
          { id: "actual-execution", text: JSON.stringify({ execution: observed.map(o => ({ calls: o.calls, receipts: o.receipts })), authorizedArtifactExcerpts: artifacts, notice: "只读工具正文通过同一访客授权下载。若excerpt被截断且关键事实缺失，必须review，不能补造。" }) },
          { id: "request-context", text: "本变体使用新访客cookie；初始没有位置和历史上下文。当前时区Asia/Shanghai只用于时间解释。后续步骤沿用同一cookie；用户已给出的内容是真实任务输入。" },
        ];
        row.semantic = await judge.evaluate({ question: variant.steps.map(s => s.question).join("\n用户后续："),
          answer: observed.map(o => o.answer).join("\n[下一轮回答]\n"), trusted, criteria: variant.criteria }, controller.signal);
        row.verdict = finalVerdict(hard, row.semantic);
      } catch (error) { row.error = controller.signal.aborted ? "cancelled" : safeError(error); row.verdict = hard.some(c => !c.pass) ? "fail" : "review"; }
      row.finishedAt = new Date().toISOString(); await save(); console.log(`${test.id}/${variant.id} #${repeat}: ${row.verdict}`);
    }
  } catch (error) { fatal = safeError(error); }
  finally {
    if (store && snapshot) {
      try { const after = await store.preflight(); finalSafety = { noNewLeases: after.sandboxLeases === snapshot.sandboxLeases, noNewBrowserSessions: after.browserSessions === snapshot.browserSessions, pinnedVersion: after.versionId === snapshot.versionId }; }
      catch { fatal ??= "final_safety_check_failed"; }
    }
    await save(); await store?.close(); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    console.log(`Report: ${output}`);
    process.exitCode = finalSafety && Object.values(finalSafety).some(v => !v) ? 1 : fatal ? 2 : args.includes("--prepare-only") ? 0 : reportExitCode(rows.map(r => r.verdict), expected);
  }
}
main().catch(() => { console.error("Product evaluation setup failed; no raw provider or database error printed."); process.exitCode = 2; });
