import { describe, expect, it } from "vitest";

import {
  buildExternalEffectActionAvailability,
  readDelegationTaskStepRequest,
  selectNextDelegationTaskStep,
  validateDelegationStepDependencies,
} from "../src/delegation-task-orchestration";

describe("delegation task orchestration", () => {
  it("selects the first dependency-ready step", () => {
    const steps = [
      { id: "step-1", sequence: 1, status: "COMPLETED", dependsOnStepIds: [], inputSnapshot: null },
      { id: "step-3", sequence: 3, status: "READY", dependsOnStepIds: ["step-2"], inputSnapshot: null },
      { id: "step-2", sequence: 2, status: "DRAFT", dependsOnStepIds: ["step-1"], inputSnapshot: null },
    ];
    expect(selectNextDelegationTaskStep(steps)?.id).toBe("step-2");
  });

  it("restores the concrete request captured on a step", () => {
    expect(readDelegationTaskStepRequest({
      inputSnapshot: {
        request: {
          capability: "read",
          path: "notes/p1.txt",
          displayTarget: "读取 notes/p1.txt",
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        },
      },
    })).toMatchObject({ capability: "read", path: "notes/p1.txt" });
  });

  it("requires reconciliation before retrying an unknown MCP outcome", () => {
    const unknown = buildExternalEffectActionAvailability({ status: "RECONCILIATION_REQUIRED", hasPersistedRequest: true });
    expect(unknown.reconcile.enabled).toBe(true);
    expect(unknown.retry.enabled).toBe(false);
    expect(unknown.retry.reason).toContain("Reconcile");
  });

  it("rejects self, forward, and negative step dependencies", () => {
    expect(() => validateDelegationStepDependencies([0], 0)).toThrow("earlier plan step");
    expect(() => validateDelegationStepDependencies([2], 1)).toThrow("earlier plan step");
    expect(() => validateDelegationStepDependencies([-1], 2)).toThrow("earlier plan step");
    expect(() => validateDelegationStepDependencies([0, 1], 2)).not.toThrow();
  });
});
