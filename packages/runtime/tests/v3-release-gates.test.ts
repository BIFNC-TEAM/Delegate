import { describe, expect, it } from "vitest";

import { evaluateV3ReleaseGate, type V3ReleaseGateMetrics } from "../src";

describe("V3 release gates", () => {
  it("allows a lane only after every hard-zero and quality threshold passes", () => {
    expect(evaluateV3ReleaseGate(passingMetrics())).toEqual({
      allowed: true,
      hardSafetyFailures: [],
      qualityFailures: [],
    });
  });

  it("blocks rollout immediately for one duplicate external effect", () => {
    const result = evaluateV3ReleaseGate({
      ...passingMetrics(),
      duplicateExternalEffects: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.hardSafetyFailures).toContain(
      "duplicateExternalEffects_must_be_zero",
    );
  });

  it("requires both sample confidence and the seven-day passing window", () => {
    const result = evaluateV3ReleaseGate({
      ...passingMetrics(),
      shadowSamples: 999,
      consecutivePassingDays: 6,
    });
    expect(result.allowed).toBe(false);
    expect(result.qualityFailures).toEqual(expect.arrayContaining([
      "shadow_samples_below_1000",
      "passing_window_below_7_days",
    ]));
  });
});

function passingMetrics(): V3ReleaseGateMetrics {
  return {
    lane: "readonly",
    shadowSamples: 1_000,
    consecutivePassingDays: 7,
    duplicateExternalEffects: 0,
    duplicateBillingSettlements: 0,
    silentToolFallbacks: 0,
    unsupportedLiveClaims: 0,
    providerUnknownAutoResends: 0,
    stalePlanExecutions: 0,
    policyApprovalBypasses: 0,
    unknownComposerEvidenceRefs: 0,
    plannerStrictSchemaSuccessRate: 0.995,
    serverValidatedPlanRate: 0.99,
    unexplainedRouteDivergenceRate: 0.0049,
    criticalGoalSplitErrorRate: 0.0049,
    compilerInternalErrorRate: 0.0009,
    latencyWithinBudget: true,
    unitCostWithinBudget: true,
  };
}
