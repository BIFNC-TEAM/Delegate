// Offline review of immutable live-model outputs; no model/tool calls.
import { readFile, writeFile } from "node:fs/promises";
import { checkV2EvaluationCase, v2ClarificationEvaluationCases, v2CoreEvaluationCases } from "../../packages/model-runtime/src/v2/evaluation-cases";
import { fingerprint } from "../../packages/model-runtime/src/v2/guards";

const files = {
  noThinking: "evaluation-2026-10-19T07-11-04-653Z-4f342242-b23b-4db8-97f5-1442dc7f8ae2.json",
  nativeThinking: "evaluation-2026-10-19T07-12-55-701Z-fa98dd1a-9eff-4cc4-9363-d7dee834354d.json",
  core: "evaluation-2026-10-19T07-12-55-701Z-fbe07a6d-22ae-4ff9-9a0b-8ddf10edbe14.json",
  offeredInfoFollowup: "evaluation-2026-10-19T07-15-08-170Z-62d058f6-d80a-40fb-a8d5-b8b7b1e1ba99.json",
};
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
};
function metrics(rows: any[]) {
  const executed = rows.filter(r => r.status !== "not_resumed");
  const firstOutput = executed.filter(r => Number.isFinite(r.firstTextMs));
  return {
    total: rows.length, executed: executed.length, originalPassed: rows.filter(r => r.fixtureChecksPass).length,
    rescoredPassed: rows.filter(r => r.rescoredPassed).length,
    durationMedianMs: median(executed.map(r => r.durationMs)),
    firstOutputMedianMs: median(firstOutput.map(r => r.firstTextMs)), firstOutputSamples: firstOutput.length,
    modelCalls: executed.reduce((n, r) => n + r.modelCalls, 0),
    toolCalls: executed.reduce((n, r) => n + r.toolCalls, 0),
    externalCalls: executed.reduce((n, r) => n + r.toolNames.filter((t: string) => t !== "request_clarification").length, 0),
    totalTokens: executed.reduce((n, r) => n + (r.totalTokens ?? r.inputTokens + r.outputTokens), 0),
    thinkingMessages: executed.reduce((n, r) => n + r.thinkingMessages, 0),
  };
}
const reports: Record<string, any> = {};
for (const [name, file] of Object.entries(files)) {
  const raw = await readFile(`reports/agent-v2/${file}`, "utf8");
  const data = JSON.parse(raw);
  const cases = data.suite === "clarification" ? v2ClarificationEvaluationCases : v2CoreEvaluationCases;
  const rows = data.rows.map((row: any) => {
    if (row.status === "not_resumed") return { ...row, rescoredPassed: false };
    const test = row.resumedFrom ? { id: row.id, question: "上海", rag: false, web: true, fact: "20" } : cases.find(c => c.id === row.id);
    if (!test || (!row.resumedFrom && test.question !== row.question)) throw Error(`Changed/missing question: ${row.id}`);
    const rescoredChecks = checkV2EvaluationCase(test, row, row.toolNames);
    return { ...row, rescoredChecks, rescoredPassed: Object.values(rescoredChecks).every(Boolean) };
  });
  reports[name] = { file, sha256: fingerprint(raw), model: data.model, reasoning: data.v2Reasoning, ...metrics(rows),
    changes: rows.filter((r: any) => r.fixtureChecksPass !== r.rescoredPassed).map((r: any) => ({ id: r.id, repeat: r.repeat,
      originalChecks: r.checks, rescoredChecks: r.rescoredChecks })),
    groups: data.suite === "clarification" ? {
      missingLocation: metrics(rows.filter((r: any) => !r.resumedFrom && r.id.startsWith("clarify"))),
      internalMiss: metrics(rows.filter((r: any) => !r.resumedFrom && r.id.includes("miss"))),
      controls: metrics(rows.filter((r: any) => !r.resumedFrom && !r.id.startsWith("clarify") && !r.id.includes("miss"))),
      resumes: metrics(rows.filter((r: any) => r.resumedFrom)),
    } : undefined };
}
const summary = { mode: "offline-rescore-no-new-generation", scoringSha256: fingerprint(await readFile("packages/model-runtime/src/v2/evaluation-cases.ts", "utf8")),
  explanation: "One native-thinking answer said supplying employee ID/phone cannot help. The old offline scorer treated the leading 提供 as a request. Original outputs/checks are unchanged. Regression tests now distinguish this statement from an imperative and a later request.",
  limitations: "Real model with synthetic tools; path/fixture checks do not prove every statement is entailed. Urgent weather resumptions add umbrella advice unsupported by a precipitation forecast. Timing is descriptive, with core/clarification runs overlapping; costs unavailable.", reports };
await writeFile("reports/agent-v2/qwen38-switch-summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(reports, null, 2));
