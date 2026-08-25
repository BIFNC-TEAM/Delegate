import { z } from "zod";

export const workflowKindSchema = z.enum([
  "handoff_follow_up",
  "approval_expiration",
  "delegation_execution",
]);

export const workflowEngineSchema = z.enum([
  "local_runner",
  "temporal",
]);

export const workflowEnginePhaseSchema = z.enum([
  "dispatch_pending",
  "waiting_timer",
  "waiting_signal",
  "activity_running",
  "retry_backoff",
  "cancel_requested",
  "completed",
  "failed",
  "canceled",
]);

export const workflowStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);

export const handoffFollowUpInputSchema = z.object({
  handoffId: z.string().min(1),
  handoffWindowHours: z.number().int().positive(),
});

export const approvalExpirationInputSchema = z.object({
  approvalId: z.string().min(1),
  timeoutMinutes: z.number().int().positive(),
});

export const delegationExecutionInputSchema = z.object({
  workflowRunId: z.string().min(1),
  delegationTaskId: z.string().min(1),
  turnPlanId: z.string().min(1).optional(),
});

export const delegationExecutionPhaseSchema = z.enum([
  "running",
  "waiting_approval",
  "waiting_user",
  "waiting_reconciliation",
  "completed",
  "failed",
  "canceled",
]);

const occurredAtSchema = z.string().datetime({ offset: true });
const delegationSignalIdSchema = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const delegationApprovalSignalSchema = z.object({
  signalId: delegationSignalIdSchema,
  kind: z.literal("approval_resolved"),
  approvalId: z.string().min(1),
  resolution: z.enum(["approved", "rejected", "expired"]),
  occurredAt: occurredAtSchema,
});

export const delegationUserInputSignalSchema = z.object({
  signalId: delegationSignalIdSchema,
  kind: z.literal("user_input_received"),
  messageId: z.string().min(1),
  occurredAt: occurredAtSchema,
});

export const delegationCancelSignalSchema = z.object({
  signalId: delegationSignalIdSchema,
  kind: z.literal("cancel_requested"),
  requestedBy: z.string().min(1),
  reason: z.string().min(1).optional(),
  occurredAt: occurredAtSchema,
});

export const delegationPolicyRevokedSignalSchema = z.object({
  signalId: delegationSignalIdSchema,
  kind: z.literal("policy_revoked"),
  reason: z.string().min(1),
  policyVersion: z.string().min(1).optional(),
  occurredAt: occurredAtSchema,
});

export const delegationReconciliationSignalSchema = z.object({
  signalId: delegationSignalIdSchema,
  kind: z.literal("reconciliation_resolved"),
  externalEffectId: z.string().min(1),
  outcome: z.enum(["succeeded", "failed", "compensated"]),
  occurredAt: occurredAtSchema,
});

export const delegationExecutionSignalSchema = z.discriminatedUnion("kind", [
  delegationApprovalSignalSchema,
  delegationUserInputSignalSchema,
  delegationCancelSignalSchema,
  delegationPolicyRevokedSignalSchema,
  delegationReconciliationSignalSchema,
]);

export const delegationExecutionStateSchema = z.object({
  workflowRunId: z.string().min(1),
  delegationTaskId: z.string().min(1),
  turnPlanId: z.string().min(1).optional(),
  phase: delegationExecutionPhaseSchema,
  revision: z.number().int().nonnegative(),
  lastTransitionId: z.string().min(1),
  lastSignal: delegationExecutionSignalSchema.optional(),
});

export const delegationExecutionTransitionInputSchema = z.object({
  workflowRunId: z.string().min(1),
  delegationTaskId: z.string().min(1),
  turnPlanId: z.string().min(1).optional(),
  transitionId: z.string().min(1),
  signal: delegationExecutionSignalSchema.optional(),
});

export const workflowEngineConfigSchema = z.object({
  configuredEngine: workflowEngineSchema,
  effectiveEngine: workflowEngineSchema,
  localQueueName: z.string().min(1),
  temporalAddress: z.string().min(1).optional(),
  temporalNamespace: z.string().min(1).optional(),
  temporalTaskQueue: z.string().min(1).optional(),
  temporalReady: z.boolean(),
  fallbackReason: z.string().min(1).optional(),
});

export const workflowDispatchTargetSchema = z.object({
  configuredEngine: workflowEngineSchema,
  effectiveEngine: workflowEngineSchema,
  queueName: z.string().min(1),
  externalWorkflowId: z.string().min(1),
  temporalReady: z.boolean(),
  fallbackReason: z.string().min(1).optional(),
});

export const temporalWorkflowRunInputSchema = z.object({
  workflowRunId: z.string().min(1),
  scheduledAt: z.string().datetime({ offset: true }),
});

export type WorkflowKind = z.infer<typeof workflowKindSchema>;
export type WorkflowEngine = z.infer<typeof workflowEngineSchema>;
export type WorkflowEnginePhase = z.infer<typeof workflowEnginePhaseSchema>;
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type HandoffFollowUpInput = z.infer<typeof handoffFollowUpInputSchema>;
export type ApprovalExpirationInput = z.infer<typeof approvalExpirationInputSchema>;
export type DelegationExecutionInput = z.infer<typeof delegationExecutionInputSchema>;
export type DelegationExecutionPhase = z.infer<typeof delegationExecutionPhaseSchema>;
export type DelegationExecutionSignal = z.infer<typeof delegationExecutionSignalSchema>;
export type DelegationApprovalSignal = z.infer<typeof delegationApprovalSignalSchema>;
export type DelegationUserInputSignal = z.infer<typeof delegationUserInputSignalSchema>;
export type DelegationCancelSignal = z.infer<typeof delegationCancelSignalSchema>;
export type DelegationPolicyRevokedSignal = z.infer<typeof delegationPolicyRevokedSignalSchema>;
export type DelegationReconciliationSignal = z.infer<typeof delegationReconciliationSignalSchema>;
export type DelegationExecutionState = z.infer<typeof delegationExecutionStateSchema>;
export type DelegationExecutionTransitionInput = z.infer<typeof delegationExecutionTransitionInputSchema>;
export type WorkflowEngineConfig = z.infer<typeof workflowEngineConfigSchema>;
export type WorkflowDispatchTarget = z.infer<typeof workflowDispatchTargetSchema>;
export type TemporalWorkflowRunInput = z.infer<typeof temporalWorkflowRunInputSchema>;

export const LOCAL_WORKFLOW_QUEUE = "local:workflow-runner";
export const DELEGATION_APPROVAL_SIGNAL = "delegation.approval_resolved";
export const DELEGATION_USER_INPUT_SIGNAL = "delegation.user_input_received";
export const DELEGATION_CANCEL_SIGNAL = "delegation.cancel_requested";
export const DELEGATION_POLICY_REVOKED_SIGNAL = "delegation.policy_revoked";
export const DELEGATION_RECONCILIATION_SIGNAL = "delegation.reconciliation_resolved";

export function delegationExecutionSignalName(
  signal: DelegationExecutionSignal,
): string {
  switch (signal.kind) {
    case "approval_resolved":
      return DELEGATION_APPROVAL_SIGNAL;
    case "user_input_received":
      return DELEGATION_USER_INPUT_SIGNAL;
    case "cancel_requested":
      return DELEGATION_CANCEL_SIGNAL;
    case "policy_revoked":
      return DELEGATION_POLICY_REVOKED_SIGNAL;
    case "reconciliation_resolved":
      return DELEGATION_RECONCILIATION_SIGNAL;
  }
}

export function handoffFollowUpDedupeKey(handoffId: string): string {
  return `handoff_follow_up:${handoffId}`;
}

export function approvalExpirationDedupeKey(approvalId: string): string {
  return `approval_expiration:${approvalId}`;
}

export function scheduleHandoffFollowUp(
  now: Date,
  handoffWindowHours: number,
): Date {
  return new Date(now.getTime() + handoffWindowHours * 60 * 60 * 1000);
}

export function scheduleApprovalExpiration(
  now: Date,
  timeoutMinutes: number,
): Date {
  return new Date(now.getTime() + timeoutMinutes * 60 * 1000);
}

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function isWorkflowEnginePhaseTerminal(phase: WorkflowEnginePhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}

export function shouldDispatchWorkflowViaTemporalOutbox(params: {
  effectiveEngine: WorkflowEngine;
}): boolean {
  return params.effectiveEngine === "temporal";
}

export function getWorkflowEngineConfig(
  env: Record<string, string | undefined> = process.env,
): WorkflowEngineConfig {
  const configuredValue = env.WORKFLOW_ENGINE?.trim();
  if (!configuredValue && env.NODE_ENV?.trim() === "production") {
    throw new Error("workflow_engine_must_be_explicit_in_production");
  }
  const parsedEngine = workflowEngineSchema.safeParse(
    configuredValue || "local_runner",
  );
  if (!parsedEngine.success) throw new Error("workflow_engine_invalid");
  const configuredEngine = parsedEngine.data;
  const temporalAddress = env.WORKFLOW_TEMPORAL_ADDRESS?.trim() || undefined;
  const temporalNamespace = env.WORKFLOW_TEMPORAL_NAMESPACE?.trim() || undefined;
  const temporalTaskQueue = env.WORKFLOW_TEMPORAL_TASK_QUEUE?.trim() || undefined;
  const temporalReady =
    configuredEngine === "temporal" &&
    Boolean(temporalAddress && temporalNamespace && temporalTaskQueue);

  return workflowEngineConfigSchema.parse({
    configuredEngine,
    // Production Temporal configuration fails closed. Local execution remains
    // available only when it was selected explicitly.
    effectiveEngine: configuredEngine,
    localQueueName: LOCAL_WORKFLOW_QUEUE,
    temporalAddress,
    temporalNamespace,
    temporalTaskQueue,
    temporalReady,
    fallbackReason:
      configuredEngine === "temporal" && !temporalReady
        ? "temporal_not_fully_configured"
        : undefined,
  });
}

export function buildWorkflowExternalId(params: {
  kind: WorkflowKind;
  representativeKey: string;
  subjectId: string;
}): string {
  if (params.kind === "delegation_execution") {
    return buildDelegationExecutionWorkflowId(params.subjectId);
  }
  return `delegate:${params.representativeKey}:${params.kind}:${params.subjectId}`;
}

export function buildDelegationExecutionWorkflowId(
  delegationTaskId: string,
): string {
  const normalized = delegationTaskId.trim();
  if (!normalized) throw new Error("delegation_task_id_required");
  return `delegate:delegation_execution:${normalized}`;
}

export function resolveWorkflowDispatchTarget(params: {
  config: WorkflowEngineConfig;
  kind: WorkflowKind;
  representativeKey: string;
  subjectId: string;
}): WorkflowDispatchTarget {
  if (
    params.config.configuredEngine === "temporal"
    && !params.config.temporalReady
  ) {
    throw new Error("temporal_not_fully_configured");
  }
  return workflowDispatchTargetSchema.parse({
    configuredEngine: params.config.configuredEngine,
    effectiveEngine: params.config.effectiveEngine,
    queueName:
      params.config.effectiveEngine === "temporal"
        ? params.config.temporalTaskQueue
        : params.config.localQueueName,
    externalWorkflowId: buildWorkflowExternalId({
      kind: params.kind,
      representativeKey: params.representativeKey,
      subjectId: params.subjectId,
    }),
    temporalReady: params.config.temporalReady,
    fallbackReason: params.config.fallbackReason,
  });
}
