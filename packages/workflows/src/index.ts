import { z } from "zod";

export const workflowKindSchema = z.enum([
  "handoff_follow_up",
  "approval_expiration",
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
export type WorkflowEngineConfig = z.infer<typeof workflowEngineConfigSchema>;
export type WorkflowDispatchTarget = z.infer<typeof workflowDispatchTargetSchema>;
export type TemporalWorkflowRunInput = z.infer<typeof temporalWorkflowRunInputSchema>;

export const LOCAL_WORKFLOW_QUEUE = "local:workflow-runner";
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
  return `delegate:${params.representativeKey}:${params.kind}:${params.subjectId}`;
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
