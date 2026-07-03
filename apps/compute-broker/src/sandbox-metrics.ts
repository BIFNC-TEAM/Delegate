export type SandboxMetricName =
  | "sandbox_identity_upserts_total"
  | "sandbox_leases_created_total"
  | "sandbox_leases_started_total"
  | "sandbox_leases_stopped_total"
  | "sandbox_leases_idle_stopped_total"
  | "sandbox_leases_errors_total";

type SandboxMetricSnapshot = Record<SandboxMetricName, number> & {
  observedAt: string;
};

const counters: Record<SandboxMetricName, number> = {
  sandbox_identity_upserts_total: 0,
  sandbox_leases_created_total: 0,
  sandbox_leases_started_total: 0,
  sandbox_leases_stopped_total: 0,
  sandbox_leases_idle_stopped_total: 0,
  sandbox_leases_errors_total: 0,
};

export function recordSandboxMetric(name: SandboxMetricName, delta = 1) {
  counters[name] += delta;
}

export function getSandboxMetricSnapshot(now: Date = new Date()): SandboxMetricSnapshot {
  return {
    observedAt: now.toISOString(),
    ...counters,
  };
}

export function resetSandboxMetricsForTest() {
  for (const key of Object.keys(counters) as SandboxMetricName[]) {
    counters[key] = 0;
  }
}
