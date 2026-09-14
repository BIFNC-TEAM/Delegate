import { describe, expect, it } from "vitest";

import {
  aggregateModuleTimings,
  buildRegressionRunReport,
  renderRegressionJUnit,
  renderRegressionMarkdown,
  type RegressionCaseResult,
} from "../src/pi";

describe("Pi regression reporting", () => {
  it("counts mixed outcomes with BLOCKED in the strict denominator", () => {
    const cases = [
      result("A", "PASS"),
      result("B", "FAIL"),
      result("C", "BLOCKED"),
      result("D", "SKIP", false),
      result("E", "REVIEW"),
    ];
    const report = buildRegressionRunReport({
      runId: "run",
      suite: "smoke",
      codeVersion: "test",
      piVersion: "0.85.1",
      fixtureVersion: "1",
      model: "faux",
      mode: "controlled",
      startedAt: "2026-09-08T01:00:00.000Z",
      totalDurationMs: 100,
      plannedCases: 5,
      cases,
    });
    expect(report.counts).toEqual({ PASS: 1, FAIL: 1, BLOCKED: 1, SKIP: 1, REVIEW: 1 });
    expect(report.strictPassRate).toBe(0.25);
    expect(report.functionalConclusion).toBe("FAIL");
    expect(report.performanceConclusion).toBe("NOT_DETERMINED");
    expect(report.uncalledModules).toContain("sandbox");
    expect(renderRegressionMarkdown(report)).toContain("No comparable baseline");
    expect(renderRegressionMarkdown(report)).toContain("sandbox/未调用");
    expect(renderRegressionJUnit(report)).toContain('failures="2"');
    expect(renderRegressionJUnit(report)).toContain('skipped="2"');
  });

  it("aggregates retry attempts without averaging percentiles", () => {
    const rows = aggregateModuleTimings([
      span(100, "error", "logic-1", 1),
      span(300, "ok", "logic-1", 2),
      span(50, "cancelled", "logic-2", 1),
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({
      calls: 3,
      logicalCalls: 2,
      retries: 1,
      totalMs: 450,
      p50Ms: 100,
      p95Ms: 300,
      failed: 1,
      cancelled: 1,
    }));
  });

  it("does not flag sub-millisecond one-sample noise as a regression", () => {
    const baseline = buildRegressionRunReport({
      runId: "baseline",
      suite: "smoke",
      codeVersion: "before",
      piVersion: "0.85.1",
      fixtureVersion: "1",
      model: "model",
      mode: "controlled",
      startedAt: "2026-09-08T01:00:00.000Z",
      totalDurationMs: 10,
      plannedCases: 1,
      cases: [{ ...result("A", "PASS"), spans: [span(0.1, "ok", "a", 1)] }],
    });
    const report = buildRegressionRunReport({
      runId: "current",
      suite: "smoke",
      codeVersion: "after",
      piVersion: "0.85.1",
      fixtureVersion: "1",
      model: "model",
      mode: "controlled",
      startedAt: "2026-09-08T02:00:00.000Z",
      totalDurationMs: 10,
      plannedCases: 1,
      cases: [{ ...result("A", "PASS"), spans: [span(0.2, "ok", "a", 1)] }],
      baseline,
    });
    expect(report.regressions).toEqual([]);
    expect(report.performanceConclusion).toBe("PASS");
  });

  it("does not compare timings against a baseline with blocked coverage", () => {
    const baseline = buildRegressionRunReport({
      runId: "baseline",
      suite: "smoke",
      codeVersion: "before",
      piVersion: "0.85.1",
      fixtureVersion: "1",
      model: "model",
      mode: "controlled",
      startedAt: "2026-09-08T01:00:00.000Z",
      totalDurationMs: 10,
      plannedCases: 2,
      cases: [
        { ...result("A", "PASS"), spans: [span(10, "ok", "a", 1)] },
        result("ARCH-03", "BLOCKED"),
      ],
    });
    const report = buildRegressionRunReport({
      runId: "current",
      suite: "smoke",
      codeVersion: "after",
      piVersion: "0.85.1",
      fixtureVersion: "1",
      model: "model",
      mode: "controlled",
      startedAt: "2026-09-08T02:00:00.000Z",
      totalDurationMs: 20,
      plannedCases: 2,
      cases: [
        { ...result("A", "PASS"), spans: [span(20, "ok", "a", 1)] },
        result("ARCH-03", "PASS"),
      ],
      baseline,
    });
    expect(report.performanceConclusion).toBe("NOT_DETERMINED");
    expect(report.moduleTimings[0]?.baselineComparable).toBe(false);
  });
});

function result(
  id: string,
  status: RegressionCaseResult["status"],
  applicable = true,
): RegressionCaseResult {
  return { id, title: id, status, applicable, attempt: 1, modelCalls: 0, toolCalls: 0, spans: [] };
}

function span(
  durationMs: number,
  status: "ok" | "error" | "cancelled",
  logicalCallId: string,
  attempt: number,
) {
  return {
    traceId: "trace",
    runId: "run",
    spanId: `${logicalCallId}-${attempt}`,
    module: "mcp" as const,
    operation: "orders.get",
    logicalCallId,
    attempt,
    startOffsetMs: 0,
    durationMs,
    status,
  };
}
