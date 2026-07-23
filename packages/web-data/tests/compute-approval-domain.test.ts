import { describe, expect, it } from "vitest";

import {
  assertComputeApprovalDomain,
  workspaceSkillApprovalReason,
} from "../src/compute-approval-domain";

describe("compute approval domain guard", () => {
  it("accepts only approvals that explicitly have no workspace skill release", () => {
    expect(() => assertComputeApprovalDomain({
      workspaceSkillReleaseId: null,
    })).not.toThrow();

    for (const approval of [
      { workspaceSkillReleaseId: "release-1" },
      {
        workspaceSkillReleaseId: null,
        reason: workspaceSkillApprovalReason,
      },
      {},
    ]) {
      expect(() => assertComputeApprovalDomain(approval)).toThrow(
        expect.objectContaining({
          code: "approval_request_domain_mismatch",
          message: "Approval request does not belong to this capability.",
          statusCode: 409,
        }),
      );
    }
  });
});
