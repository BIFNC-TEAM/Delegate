export const actionIdentityErrorCodes = [
  "logical_action_identity_required", "logical_action_context_changed", "logical_action_payload_changed",
  "logical_action_in_progress", "logical_action_origin_already_processed", "logical_action_previous_unresolved", "logical_action_limit_reached",
  "logical_action_recovery_checkpoint_required",
] as const;
export type ActionIdentityErrorCode = typeof actionIdentityErrorCodes[number];
export function isActionIdentityError(error: unknown): error is { code: ActionIdentityErrorCode } {
  return Boolean(error && typeof error === "object" && "code" in error && actionIdentityErrorCodes.includes(error.code as ActionIdentityErrorCode));
}
export class AgentActionIdentityError extends Error {
  constructor(readonly code: ActionIdentityErrorCode) { super(code); this.name = "AgentActionIdentityError"; }
}
