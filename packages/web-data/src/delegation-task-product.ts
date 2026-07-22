export type DelegationTaskProductStatus =
  | "DRAFT"
  | "CLARIFYING"
  | "READY"
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_USER"
  | "WAITING_FOR_OWNER"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED";

export function buildDelegationTaskOwnerActionAvailability(input: {
  status: DelegationTaskProductStatus;
  kind: string;
  hasGenerationRun: boolean;
  hasPendingApproval: boolean;
}) {
  const cancelable = new Set<DelegationTaskProductStatus>([
    "DRAFT",
    "CLARIFYING",
    "READY",
    "AWAITING_APPROVAL",
    "QUEUED",
    "WAITING_FOR_USER",
    "WAITING_FOR_OWNER",
  ]).has(input.status);
  const retryable = new Set<DelegationTaskProductStatus>([
    "FAILED",
    "CANCELED",
    "EXPIRED",
  ]).has(input.status) && input.kind !== "MCP" && input.hasGenerationRun;
  const continuable = input.status === "WAITING_FOR_OWNER" && input.hasGenerationRun;
  return {
    cancel: {
      enabled: cancelable,
      reason: cancelable
        ? input.hasPendingApproval
          ? "Canceling will reject the pending approval and preserve its decision record."
          : "The task has not entered an uncancelable atomic operation."
        : input.status === "RUNNING"
          ? "The current atomic operation cannot be presented as canceled until broker termination is confirmed."
          : "Only active or waiting tasks can be canceled.",
    },
    retry: {
      enabled: retryable,
      reason: retryable
        ? "Retry creates a new attempt on the same task and re-evaluates current policy."
        : input.kind === "MCP"
          ? "MCP retries require external-effect reconciliation and are not available in P0."
          : "Retry is available for failed, canceled, or expired single-step tasks with execution context.",
    },
    continue: {
      enabled: continuable,
      reason: continuable
        ? "The task is waiting for an Owner decision and can return to the system queue."
        : input.status === "WAITING_FOR_USER"
          ? "This task needs new audience input; the Owner cannot continue it on the audience's behalf."
          : "Continue is available only while a task is waiting for the Owner.",
    },
  };
}

export function buildDelegationApprovalPolicyExplanation(
  reason: string,
  matchedPolicyRuleId: string | null,
) {
  return matchedPolicyRuleId
    ? `Deterministic policy rule “${matchedPolicyRuleId}” returned ASK. ${reason}`
    : `The effective policy profile returned ASK using its default or managed overlay. ${reason}`;
}
