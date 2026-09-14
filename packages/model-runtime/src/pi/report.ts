import { nearestRank } from "./telemetry";
import type { PiModule, PiSpan } from "./types";

export type RegressionStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIP" | "REVIEW";

export type RegressionCaseResult = {
  id: string;
  title: string;
  status: RegressionStatus;
  applicable: boolean;
  attempt: number;
  firstAnswerMs?: number;
  totalDurationMs?: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  answer?: string;
  reason?: string;
  evidence?: string[];
  spans: PiSpan[];
};

export type ModuleTimingRow = {
  module: PiModule;
  operation: string;
  calls: number;
  logicalCalls: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  retries: number;
  totalMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
  sampleSize: number;
  p95Stable: boolean;
  baselineDeltaMs?: number;
  baselineDeltaPercent?: number;
  baselineComparable: boolean;
};

export type RegressionRunReport = {
  schemaVersion: "delegate-agent-regression.1";
  runId: string;
  suite: string;
  codeVersion: string;
  piVersion: string;
  fixtureVersion: string;
  model: string;
  mode: string;
  timezone: string;
  startedAt: string;
  totalDurationMs: number;
  plannedCases: number;
  startedCases: number;
  uniqueCases: number;
  attempts: number;
  counts: Record<RegressionStatus, number>;
  strictPassRate: number | null;
  functionalConclusion: "PASS" | "FAIL";
  performanceConclusion: "PASS" | "WARN" | "NOT_DETERMINED";
  reasonDistribution: Record<string, number>;
  moduleTimings: ModuleTimingRow[];
  uncalledModules: PiModule[];
  slowestCases: Array<{
    id: string;
    durationMs: number;
    dominantStage?: string;
  }>;
  regressions: Array<{
    module: string;
    deltaMs: number;
    deltaPercent?: number;
  }>;
  cases: RegressionCaseResult[];
};

export function aggregateModuleTimings(
  spans: readonly PiSpan[],
  baseline: readonly ModuleTimingRow[] = [],
): ModuleTimingRow[] {
  const groups = new Map<string, PiSpan[]>();
  for (const span of spans) {
    const key = `${span.module}\u0000${span.operation}`;
    const values = groups.get(key) ?? [];
    values.push(span);
    groups.set(key, values);
  }
  const baselineByKey = new Map(
    baseline.map((row) => [`${row.module}\u0000${row.operation}`, row]),
  );
  return [...groups.entries()].map(([key, values]) => {
    const [module, operation] = key.split("\u0000") as [PiModule, string];
    const durations = values.map((span) => span.durationMs);
    const totalMs = durations.reduce((sum, value) => sum + value, 0);
    const logical = new Set(values.map((span) => span.logicalCallId ?? span.spanId));
    const retries = [...logical].reduce((sum, logicalCallId) =>
      sum + Math.max(0, values.filter((span) =>
        (span.logicalCallId ?? span.spanId) === logicalCallId).length - 1), 0);
    const averageMs = totalMs / values.length;
    const previous = baselineByKey.get(key);
    const baselineComparable = Boolean(previous && previous.calls > 0);
    const baselineDeltaMs = previous ? averageMs - previous.averageMs : undefined;
    const baselineDeltaPercent = previous && previous.averageMs !== 0
      ? (averageMs - previous.averageMs) / previous.averageMs * 100
      : undefined;
    return {
      module,
      operation,
      calls: values.length,
      logicalCalls: logical.size,
      succeeded: values.filter((span) => span.status === "ok").length,
      failed: values.filter((span) => span.status === "error").length,
      timedOut: values.filter((span) => span.status === "timeout").length,
      cancelled: values.filter((span) => span.status === "cancelled").length,
      retries,
      totalMs,
      averageMs,
      p50Ms: nearestRank(durations, 0.5) ?? 0,
      p95Ms: nearestRank(durations, 0.95) ?? 0,
      maximumMs: Math.max(...durations),
      sampleSize: values.length,
      p95Stable: values.length >= 20,
      ...(baselineDeltaMs !== undefined ? { baselineDeltaMs } : {}),
      ...(baselineDeltaPercent !== undefined ? { baselineDeltaPercent } : {}),
      baselineComparable,
    };
  }).sort((left, right) =>
    left.module.localeCompare(right.module) || left.operation.localeCompare(right.operation));
}

export function buildRegressionRunReport(input: {
  runId: string;
  suite: string;
  codeVersion: string;
  piVersion: string;
  fixtureVersion: string;
  model: string;
  mode: string;
  timezone?: string;
  startedAt: string;
  totalDurationMs: number;
  plannedCases: number;
  cases: RegressionCaseResult[];
  baseline?: RegressionRunReport;
}): RegressionRunReport {
  const counts = statusCounts(input.cases);
  const applicable = input.cases.filter((item) => item.applicable);
  const strictPassRate = applicable.length
    ? counts.PASS / applicable.length
    : null;
  const baselineTimings = isComparableRun(input, input.baseline)
    ? input.baseline!.moduleTimings
    : [];
  const moduleTimings = aggregateModuleTimings(
    input.cases.flatMap((item) => item.spans),
    baselineTimings,
  );
  const observedModules = new Set(moduleTimings.map((row) => row.module));
  const uncalledModules = allPiModules.filter((module) => !observedModules.has(module));
  const regressions = moduleTimings
    .filter((row) =>
      row.baselineComparable
      && (row.baselineDeltaPercent ?? 0) > 20
      && (row.p95Stable || Math.abs(row.baselineDeltaMs ?? 0) >= 50))
    .sort((left, right) => (right.baselineDeltaPercent ?? 0) - (left.baselineDeltaPercent ?? 0))
    .slice(0, 5)
    .map((row) => ({
      module: `${row.module}/${row.operation}`,
      deltaMs: row.baselineDeltaMs!,
      ...(row.baselineDeltaPercent !== undefined
        ? { deltaPercent: row.baselineDeltaPercent }
        : {}),
    }));
  const reasonDistribution: Record<string, number> = {};
  for (const item of input.cases) {
    if (!item.reason) continue;
    const key = item.reason.split(":", 1)[0] || item.reason;
    reasonDistribution[key] = (reasonDistribution[key] ?? 0) + 1;
  }
  return {
    schemaVersion: "delegate-agent-regression.1",
    runId: input.runId,
    suite: input.suite,
    codeVersion: input.codeVersion,
    piVersion: input.piVersion,
    fixtureVersion: input.fixtureVersion,
    model: input.model,
    mode: input.mode,
    timezone: input.timezone ?? "Asia/Shanghai",
    startedAt: input.startedAt,
    totalDurationMs: input.totalDurationMs,
    plannedCases: input.plannedCases,
    startedCases: input.cases.length,
    uniqueCases: new Set(input.cases.map((item) => item.id)).size,
    attempts: input.cases.length,
    counts,
    strictPassRate,
    functionalConclusion:
      counts.FAIL || counts.BLOCKED || counts.REVIEW ? "FAIL" : "PASS",
    performanceConclusion: baselineTimings.length
      ? regressions.length ? "WARN" : "PASS"
      : "NOT_DETERMINED",
    reasonDistribution,
    moduleTimings,
    uncalledModules,
    slowestCases: input.cases
      .filter((item) => item.totalDurationMs !== undefined)
      .sort((left, right) => right.totalDurationMs! - left.totalDurationMs!)
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        durationMs: item.totalDurationMs!,
        ...(dominantStage(item.spans) ? { dominantStage: dominantStage(item.spans)! } : {}),
      })),
    regressions,
    cases: input.cases,
  };
}

export function renderRegressionMarkdown(report: RegressionRunReport) {
  const rate = report.strictPassRate === null
    ? "N/A"
    : `${(report.strictPassRate * 100).toFixed(2)}%`;
  const lines = [
    `# Agent regression report — ${report.runId}`,
    "",
    `- Suite: ${report.suite}`,
    `- Version: ${report.codeVersion}`,
    `- Pi: ${report.piVersion}`,
    `- Model: ${report.model}`,
    `- Mode: ${report.mode}`,
    `- Started: ${report.startedAt}`,
    `- Total: ${report.totalDurationMs.toFixed(1)} ms`,
    `- Cases: ${report.startedCases}/${report.plannedCases}; PASS ${report.counts.PASS}, FAIL ${report.counts.FAIL}, BLOCKED ${report.counts.BLOCKED}, SKIP ${report.counts.SKIP}, REVIEW ${report.counts.REVIEW}`,
    `- Strict pass rate: ${rate}`,
    `- Functional: ${report.functionalConclusion}; Performance: ${report.performanceConclusion}`,
    "",
    "## Module timings",
    "",
    "| Module/operation | Calls | OK/Error/Timeout/Cancel | Retries | Total ms | Avg ms | p50 | p95 | Max | Baseline |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ...report.moduleTimings.map((row) =>
      `| ${row.module}/${row.operation} | ${row.calls} | ${row.succeeded}/${row.failed}/${row.timedOut}/${row.cancelled} | ${row.retries} | ${row.totalMs.toFixed(1)} | ${row.averageMs.toFixed(1)} | ${row.p50Ms.toFixed(1)} | ${row.p95Ms.toFixed(1)} | ${row.maximumMs.toFixed(1)} | ${baselineLabel(row)} |`),
    ...report.uncalledModules.map((module) =>
      `| ${module}/未调用 | — | — | — | — | — | — | — | — | N/A |`),
    "",
    "## Cases",
    "",
    "| Case | Status | First answer ms | Total ms | Model | Tools | Reason |",
    "|---|---|---:|---:|---:|---:|---|",
    ...report.cases.map((item) =>
      `| ${item.id} | ${item.status} | ${numberOrNa(item.firstAnswerMs)} | ${numberOrNa(item.totalDurationMs)} | ${item.modelCalls} | ${item.toolCalls} | ${escapeTable(item.reason ?? "")} |`),
    "",
    "## Slowest cases",
    "",
    ...report.slowestCases.map((item) =>
      `- ${item.id}: ${item.durationMs.toFixed(1)} ms${item.dominantStage ? ` (${item.dominantStage})` : ""}`),
    ...(report.slowestCases.length ? [] : ["- N/A"]),
    "",
    "## Optimization evidence",
    "",
    ...(report.regressions.length
      ? report.regressions.map((item) =>
          `- Recheck ${item.module}: +${item.deltaMs.toFixed(1)} ms${item.deltaPercent !== undefined ? ` (${item.deltaPercent.toFixed(1)}%)` : ""}.`)
      : report.performanceConclusion === "NOT_DETERMINED"
        ? ["- No comparable baseline; collect a matching run before claiming improvement or regression."]
        : ["- No module exceeded the configured 20% comparable-baseline warning threshold."]),
  ];
  return `${lines.join("\n")}\n`;
}

const allPiModules: PiModule[] = [
  "request", "context", "orchestration", "model", "knowledge", "web",
  "mcp", "skill", "sandbox", "artifact", "handoff", "response", "wait",
];

export function renderRegressionJUnit(report: RegressionRunReport) {
  const failures = report.counts.FAIL + report.counts.REVIEW;
  const skipped = report.counts.SKIP + report.counts.BLOCKED;
  const cases = report.cases.map((item) => {
    const body = item.status === "FAIL" || item.status === "REVIEW"
      ? `<failure message="${xml(item.reason ?? item.status)}"/>`
      : item.status === "SKIP" || item.status === "BLOCKED"
        ? `<skipped message="${xml(item.reason ?? item.status)}"/>`
        : "";
    return `<testcase classname="agent.${xml(report.suite)}" name="${xml(item.id)}" time="${((item.totalDurationMs ?? 0) / 1000).toFixed(6)}">${body}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="agent-${xml(report.suite)}" tests="${report.cases.length}" failures="${failures}" skipped="${skipped}" time="${(report.totalDurationMs / 1000).toFixed(6)}">${cases}</testsuite>\n`;
}

export function renderRegressionHtml(report: RegressionRunReport) {
  const markdown = renderRegressionMarkdown(report);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent regression ${xml(report.runId)}</title><style>body{font-family:Avenir Next,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1280px;margin:32px auto;padding:0 24px;color:#111827;background:#fff}pre{white-space:pre-wrap;background:#f7f8fa;border:1px solid #e5e7eb;border-radius:12px;padding:20px;line-height:1.5}h1{color:#0d9488}</style></head><body><h1>Agent regression report</h1><pre>${xml(markdown)}</pre></body></html>\n`;
}

function statusCounts(cases: readonly RegressionCaseResult[]): Record<RegressionStatus, number> {
  return {
    PASS: cases.filter((item) => item.status === "PASS").length,
    FAIL: cases.filter((item) => item.status === "FAIL").length,
    BLOCKED: cases.filter((item) => item.status === "BLOCKED").length,
    SKIP: cases.filter((item) => item.status === "SKIP").length,
    REVIEW: cases.filter((item) => item.status === "REVIEW").length,
  };
}

function isComparableRun(
  input: Parameters<typeof buildRegressionRunReport>[0],
  baseline: RegressionRunReport | undefined,
) {
  if (
    !baseline
    || baseline.suite !== input.suite
    || baseline.model !== input.model
    || baseline.mode !== input.mode
    || baseline.fixtureVersion !== input.fixtureVersion
    || baseline.plannedCases !== input.plannedCases
  ) {
    return false;
  }
  const currentIds = [...new Set(input.cases.map((item) => item.id))].sort();
  const baselineIds = [...new Set(baseline.cases.map((item) => item.id))].sort();
  return currentIds.length === baselineIds.length
    && currentIds.every((id, index) => id === baselineIds[index])
    && input.cases.every((item) => item.status === "PASS")
    && baseline.cases.every((item) => item.status === "PASS");
}

function dominantStage(spans: readonly PiSpan[]) {
  const dominant = [...spans].sort((left, right) => right.durationMs - left.durationMs)[0];
  return dominant ? `${dominant.module}/${dominant.operation}` : undefined;
}

function baselineLabel(row: ModuleTimingRow) {
  if (!row.baselineComparable || row.baselineDeltaMs === undefined) return "N/A";
  const percent = row.baselineDeltaPercent === undefined
    ? "N/A"
    : `${row.baselineDeltaPercent >= 0 ? "+" : ""}${row.baselineDeltaPercent.toFixed(1)}%`;
  return `${row.baselineDeltaMs >= 0 ? "+" : ""}${row.baselineDeltaMs.toFixed(1)} ms / ${percent}`;
}

function numberOrNa(value: number | undefined) {
  return value === undefined ? "N/A" : value.toFixed(1);
}

function escapeTable(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
