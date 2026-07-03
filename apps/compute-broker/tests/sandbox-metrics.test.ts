import { beforeEach, describe, expect, it } from "vitest";

import {
  getSandboxMetricSnapshot,
  recordSandboxMetric,
  resetSandboxMetricsForTest,
} from "../src/sandbox-metrics";

describe("sandbox metrics", () => {
  beforeEach(() => {
    resetSandboxMetricsForTest();
  });

  it("records only aggregate sandbox lifecycle counters", () => {
    recordSandboxMetric("sandbox_leases_started_total");
    recordSandboxMetric("sandbox_leases_started_total");
    recordSandboxMetric("sandbox_leases_errors_total");

    const snapshot = getSandboxMetricSnapshot(new Date("2026-07-04T12:00:00.000Z"));

    expect(snapshot).toEqual(expect.objectContaining({
      observedAt: "2026-07-04T12:00:00.000Z",
      sandbox_leases_started_total: 2,
      sandbox_leases_errors_total: 1,
    }));
    expect(JSON.stringify(snapshot)).not.toMatch(/token|secret|cookie/i);
  });
});
