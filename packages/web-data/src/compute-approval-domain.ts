import { ComputeBrokerError } from "./compute-client";

export const workspaceSkillApprovalReason = "skill_version_update_review";

export function assertComputeApprovalDomain(approval: {
  workspaceSkillReleaseId?: string | null;
  reason?: unknown;
}) {
  if (
    approval.workspaceSkillReleaseId !== null
    || approval.reason === workspaceSkillApprovalReason
  ) {
    throw new ComputeBrokerError(
      "approval_request_domain_mismatch",
      409,
      "Approval request does not belong to this capability.",
    );
  }
}
