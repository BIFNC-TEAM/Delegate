import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { digest, finalVerdict, reportExitCode, safeJson } from "../semantic/engine";
import { productCases, assertProductStep } from "./cases";
import { PRODUCT_SCOPE } from "./scope";

/** Offline recheck only. Preserves original semantic judgments; never replays requests. */
export function recheckReport(parent: any) {
  if (parent.mode !== "real-product-api-sse-db" || parent.scope?.slug !== PRODUCT_SCOPE.slug || parent.scope?.origin !== PRODUCT_SCOPE.origin
    || !parent.fixture?.versionId || !Array.isArray(parent.rows) || !parent.finalSafety || Object.values(parent.finalSafety).some(v => v !== true)) throw Error("invalid_parent_report");
  const seen = new Set<string>();
  const rows = parent.rows.map((row: any) => {
    const test = productCases.find(c => c.id === row.caseId);
    const variant = test?.variants.find(v => v.id === row.variant);
    const key = `${row.caseId}:${row.variant}:${row.repeat}`;
    if (!test || !variant || seen.has(key) || !Number.isInteger(row.repeat) || row.repeat < 1 || row.repeat > parent.repeats) throw Error("invalid_parent_case");
    seen.add(key);
    if (row.observed?.length !== variant.steps.length || !row.semantic || !row.finishedAt) return { ...row, verdict: "review", recheckError: "incomplete_saved_evidence" };
    const hard = variant.steps.flatMap((step, i) => {
      if (row.observed[i].input !== step.question) throw Error("saved_input_changed");
      return assertProductStep(test, step, row.observed[i], parent.fixture.versionId, i ? row.observed[i - 1] : undefined);
    });
    const streamChecks = row.hard.filter((h: any) => h.id === "sse-db-answer-match");
    if (streamChecks.length !== row.observed.length) throw Error("missing_stream_evidence");
    hard.push(...streamChecks);
    return { ...row, originalVerdict: row.verdict, originalHard: row.hard, hard, verdict: finalVerdict(hard, row.semantic) };
  });
  const summary = parent.definitions.map((test: any) => {
    const results = rows.filter((r: any) => r.caseId === test.id);
    const expectedRows = test.variants.length * parent.repeats;
    return { id: test.id, expectedRows, actualRows: results.length,
      verdict: results.some((r: any) => r.verdict === "fail") ? "fail" : results.length !== expectedRows || results.some((r: any) => r.verdict !== "pass") ? "review" : "pass" };
  });
  return { ...parent, mode: "offline-hard-assertion-recheck", sourceMode: parent.mode, originalSummary: parent.summary, rows, summary,
    newProductRequests: 0, newJudgeCalls: 0, note: "Only deterministic assertions recomputed against saved evidence. Original semantic judgments, failures and uncertain reviews retained. This is not a fresh product run. Missing-plan specification does not forbid RAG; removed that extra constraint." };
}
async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--");
  if (args.length !== 1) throw Error("provide_one_report_path");
  const directory = resolve("reports/agent-v2/product10"); const path = resolve(args[0]!);
  if (!path.startsWith(directory + sep) || !path.endsWith(".json")) throw Error("report_path_out_of_scope");
  const text = await readFile(path, "utf8");
  const result = { ...recheckReport(JSON.parse(text)), parentFile: basename(path), parentSha256: digest(text),
    currentCasesSha256: digest(await readFile(new URL("cases.ts", import.meta.url), "utf8")) };
  const output = resolve(directory, `recheck-${randomUUID()}.json`);
  await writeFile(output, safeJson(result) + "\n", { mode: 0o600 });
  console.log(`Report: ${output}`); process.exitCode = reportExitCode(result.rows.map((r: any) => r.verdict), result.expectedRows);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Offline recheck rejected invalid or incomplete report input."); process.exitCode = 2; });
