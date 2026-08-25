export type V3ReleaseGateMetrics = {
  lane: string;
  shadowSamples: number;
  consecutivePassingDays: number;
  duplicateExternalEffects: number;
  duplicateBillingSettlements: number;
  silentToolFallbacks: number;
  unsupportedLiveClaims: number;
  providerUnknownAutoResends: number;
  stalePlanExecutions: number;
  policyApprovalBypasses: number;
  unknownComposerEvidenceRefs: number;
  plannerStrictSchemaSuccessRate: number;
  serverValidatedPlanRate: number;
  unexplainedRouteDivergenceRate: number;
  criticalGoalSplitErrorRate: number;
  compilerInternalErrorRate: number;
  latencyWithinBudget: boolean;
  unitCostWithinBudget: boolean;
};

export type V3ReleaseGateResult = {
  allowed: boolean;
  hardSafetyFailures: string[];
  qualityFailures: string[];
};

const hardZeroMetrics = [
  "duplicateExternalEffects",
  "duplicateBillingSettlements",
  "silentToolFallbacks",
  "unsupportedLiveClaims",
  "providerUnknownAutoResends",
  "stalePlanExecutions",
  "policyApprovalBypasses",
  "unknownComposerEvidenceRefs",
] as const satisfies ReadonlyArray<keyof V3ReleaseGateMetrics>;

export function evaluateV3ReleaseGate(
  metrics: V3ReleaseGateMetrics,
): V3ReleaseGateResult {
  const hardSafetyFailures = hardZeroMetrics.flatMap((key) =>
    metrics[key] === 0 ? [] : [`${key}_must_be_zero`]);
  const qualityFailures = [
    ...(metrics.shadowSamples >= 1_000 ? [] : ["shadow_samples_below_1000"]),
    ...(metrics.consecutivePassingDays >= 7 ? [] : ["passing_window_below_7_days"]),
    ...(metrics.plannerStrictSchemaSuccessRate >= 0.995
      ? [] : ["planner_strict_schema_success_below_99_5_percent"]),
    ...(metrics.serverValidatedPlanRate >= 0.99
      ? [] : ["validated_plan_rate_below_99_percent"]),
    ...(metrics.unexplainedRouteDivergenceRate < 0.005
      ? [] : ["unexplained_route_divergence_at_or_above_0_5_percent"]),
    ...(metrics.criticalGoalSplitErrorRate < 0.005
      ? [] : ["critical_goal_split_error_at_or_above_0_5_percent"]),
    ...(metrics.compilerInternalErrorRate < 0.001
      ? [] : ["compiler_internal_error_at_or_above_0_1_percent"]),
    ...(metrics.latencyWithinBudget ? [] : ["latency_budget_exceeded"]),
    ...(metrics.unitCostWithinBudget ? [] : ["unit_cost_budget_exceeded"]),
  ];
  return {
    allowed: hardSafetyFailures.length === 0 && qualityFailures.length === 0,
    hardSafetyFailures,
    qualityFailures,
  };
}
