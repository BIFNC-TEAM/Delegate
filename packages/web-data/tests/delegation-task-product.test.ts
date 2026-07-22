import { describe, expect, it } from "vitest";

import {
  buildDelegationApprovalPolicyExplanation,
  buildDelegationTaskOwnerActionAvailability,
  type DelegationTaskProductStatus,
} from "../src/delegation-task-product";

describe("delegation task product contract", () => {
  it("allows cancellation only before an atomic operation is running", () => {
    for (const status of ["DRAFT", "CLARIFYING", "READY", "AWAITING_APPROVAL", "QUEUED", "WAITING_FOR_USER", "WAITING_FOR_OWNER"] satisfies DelegationTaskProductStatus[]) {
      expect(actions(status).cancel.enabled, status).toBe(true);
    }
    for (const status of ["RUNNING", "COMPLETED", "FAILED", "CANCELED", "EXPIRED"] satisfies DelegationTaskProductStatus[]) {
      expect(actions(status).cancel.enabled, status).toBe(false);
    }
    expect(actions("RUNNING").cancel.reason).toContain("termination is confirmed");
  });

  it("retries terminal single-step compute tasks but not completed or MCP work", () => {
    for (const status of ["FAILED", "CANCELED", "EXPIRED"] satisfies DelegationTaskProductStatus[]) {
      expect(actions(status).retry.enabled, status).toBe(true);
    }
    expect(actions("COMPLETED").retry.enabled).toBe(false);
    expect(actions("FAILED", { kind: "MCP" }).retry.enabled).toBe(false);
    expect(actions("FAILED", { hasGenerationRun: false }).retry.enabled).toBe(false);
  });

  it("continues only work explicitly waiting for the owner", () => {
    expect(actions("WAITING_FOR_OWNER").continue.enabled).toBe(true);
    expect(actions("WAITING_FOR_USER").continue.enabled).toBe(false);
    expect(actions("WAITING_FOR_USER").continue.reason).toContain("new audience input");
    const reconciliation = actions("WAITING_FOR_OWNER", {
      hasExternalEffect: true,
      hasUnreconciledExternalEffect: true,
    });
    expect(reconciliation.cancel.enabled).toBe(false);
    expect(reconciliation.continue.enabled).toBe(false);
    expect(reconciliation.cancel.reason).toContain("reconciled");
  });

  it("explains whether ASK came from a matched rule or the effective profile", () => {
    expect(buildDelegationApprovalPolicyExplanation("human_approval_required", "write-workspace"))
      .toContain("write-workspace");
    expect(buildDelegationApprovalPolicyExplanation("managed_overlay", null))
      .toContain("default or managed overlay");
  });
});

function actions(
  status: DelegationTaskProductStatus,
  overrides: Partial<{
    kind: string;
    hasGenerationRun: boolean;
    hasPendingApproval: boolean;
    hasExternalEffect: boolean;
    hasUnreconciledExternalEffect: boolean;
  }> = {},
) {
  return buildDelegationTaskOwnerActionAvailability({
    status,
    kind: overrides.kind ?? "COMPUTE",
    hasGenerationRun: overrides.hasGenerationRun ?? true,
    hasPendingApproval: overrides.hasPendingApproval ?? false,
    hasExternalEffect: overrides.hasExternalEffect ?? false,
    hasUnreconciledExternalEffect: overrides.hasUnreconciledExternalEffect ?? false,
  });
}
