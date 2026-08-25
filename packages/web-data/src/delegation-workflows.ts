import {
  EventType,
  Prisma,
  WorkflowEngine,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowCommandType,
  WorkflowStatus,
} from "@prisma/client";
import {
  delegationExecutionSignalSchema,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";
import type { DelegationExecutionSignal } from "@delegate/workflows";
import sha256 from "fast-sha256";

export async function ensureDelegationExecutionWorkflowInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    representativeSlug: string;
    contactId?: string | null;
    conversationId?: string | null;
    delegationTaskId: string;
    delegationTaskStepId?: string | null;
  },
) {
  const dedupeKey = `delegation_execution:${input.delegationTaskId}`;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${input.delegationTaskId}))
  `;
  const task = await tx.delegationTask.findUnique({
    where: { id: input.delegationTaskId },
    select: {
      representativeId: true,
      originConversationId: true,
      generationRuns: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, inputMessageId: true },
      },
    },
  });
  if (
    !task
    || task.representativeId !== input.representativeId
    || task.originConversationId !== (input.conversationId ?? null)
  ) {
    throw new Error("Delegation workflow task coordinate does not match.");
  }

  const runIds = task.generationRuns.map((run) => run.id);
  const inputMessageIds = [
    ...new Set(task.generationRuns.map((run) => run.inputMessageId)),
  ];
  const activePlan = await tx.conversationTurnPlan.findFirst({
    where: {
      shadowMode: false,
      status: { in: ["VALIDATED", "EXECUTING"] },
      OR: [
        { delegationTaskId: input.delegationTaskId },
        ...(runIds.length ? [{ generationRunId: { in: runIds } }] : []),
        ...(
          task.originConversationId && inputMessageIds.length
            ? [{
                conversationId: task.originConversationId,
                inputMessageId: { in: inputMessageIds },
              }]
            : []
        ),
      ],
    },
    orderBy: { revision: "desc" },
    select: { id: true, delegationTaskId: true },
  });
  if (
    activePlan?.delegationTaskId
    && activePlan.delegationTaskId !== input.delegationTaskId
  ) {
    throw new Error("Active turn plan already belongs to another delegation task.");
  }
  if (activePlan && !activePlan.delegationTaskId) {
    const bound = await tx.conversationTurnPlan.updateMany({
      where: { id: activePlan.id, delegationTaskId: null },
      data: { delegationTaskId: input.delegationTaskId },
    });
    if (bound.count !== 1) {
      throw new Error("Active turn plan changed while binding its task.");
    }
    await tx.conversationPlanAction.updateMany({
      where: { turnPlanId: activePlan.id, delegationTaskId: null },
      data: { delegationTaskId: input.delegationTaskId },
    });
  }

  const existing = await tx.workflowRun.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true, turnPlanId: true, input: true },
  });
  if (existing) {
    if (
      activePlan
      && existing.turnPlanId !== activePlan.id
      && !["COMPLETED", "FAILED", "CANCELED"].includes(existing.status)
    ) {
      const currentInput = existing.input
        && typeof existing.input === "object"
        && !Array.isArray(existing.input)
          ? existing.input as Prisma.JsonObject
          : {};
      await tx.workflowRun.update({
        where: { id: existing.id },
        data: {
          turnPlanId: activePlan.id,
          input: {
            ...currentInput,
            delegationTaskId: input.delegationTaskId,
            turnPlanId: activePlan.id,
          },
        },
      });
    }
    return existing.id;
  }
  const config = getWorkflowEngineConfig(process.env);
  const dispatchTarget = resolveWorkflowDispatchTarget({
    config,
    kind: "delegation_execution",
    representativeKey: input.representativeSlug,
    subjectId: input.delegationTaskId,
  });
  const isTemporal = shouldDispatchWorkflowViaTemporalOutbox(dispatchTarget);
  const scheduledAt = new Date();
  const workflow = await tx.workflowRun.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      delegationTaskId: input.delegationTaskId,
      delegationTaskStepId: input.delegationTaskStepId ?? null,
      turnPlanId: activePlan?.id ?? null,
      kind: WorkflowKind.DELEGATION_EXECUTION,
      engine: isTemporal ? WorkflowEngine.TEMPORAL : WorkflowEngine.LOCAL_RUNNER,
      status: WorkflowStatus.QUEUED,
      enginePhase: isTemporal
        ? WorkflowEnginePhase.DISPATCH_PENDING
        : WorkflowEnginePhase.ACTIVITY_RUNNING,
      dedupeKey,
      queueName: dispatchTarget.queueName,
      externalWorkflowId: dispatchTarget.externalWorkflowId,
      scheduledAt,
      nextWakeAt: scheduledAt,
      input: {
        delegationTaskId: input.delegationTaskId,
        ...(activePlan ? { turnPlanId: activePlan.id } : {}),
      },
      ...(isTemporal
        ? {
            commandOutbox: {
              create: {
                commandType: "START",
                payload: {
                  source: "delegation_task_created",
                  scheduledAt: scheduledAt.toISOString(),
                },
              },
            },
          }
        : {}),
    },
  });
  await tx.eventAudit.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      delegationTaskId: input.delegationTaskId,
      type: EventType.WORKFLOW_ENQUEUED,
      payload: {
        workflowRunId: workflow.id,
        workflowKind: "delegation_execution",
        configuredEngine: dispatchTarget.configuredEngine,
        effectiveEngine: dispatchTarget.effectiveEngine,
        queueName: dispatchTarget.queueName,
        externalWorkflowId: dispatchTarget.externalWorkflowId,
        temporalReady: dispatchTarget.temporalReady,
        ...(activePlan ? { turnPlanId: activePlan.id } : {}),
      },
    },
  });
  return workflow.id;
}

export async function enqueueDelegationExecutionSignalInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    delegationTaskId: string;
    signal: DelegationExecutionSignal;
  },
) {
  const signal = delegationExecutionSignalSchema.parse(input.signal);
  const workflow = await tx.workflowRun.findUnique({
    where: { dedupeKey: `delegation_execution:${input.delegationTaskId}` },
    select: {
      id: true,
      engine: true,
      status: true,
    },
  });
  if (!workflow || ["COMPLETED", "FAILED", "CANCELED"].includes(workflow.status)) {
    return null;
  }
  const signalHash = Array.from(
    sha256(new TextEncoder().encode(`${workflow.id}:${signal.signalId}`)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (workflow.engine === WorkflowEngine.TEMPORAL) {
    return tx.workflowCommandOutbox.upsert({
      where: { id: `workflow_signal_${signalHash}` },
      create: {
        id: `workflow_signal_${signalHash}`,
        workflowRunId: workflow.id,
        commandType: WorkflowCommandType.SIGNAL,
        payload: { signal } as Prisma.InputJsonObject,
      },
      update: {},
    });
  }
  await tx.workflowRun.update({
    where: { id: workflow.id },
    data: {
      status: WorkflowStatus.QUEUED,
      enginePhase: WorkflowEnginePhase.ACTIVITY_RUNNING,
      scheduledAt: new Date(),
      nextWakeAt: new Date(),
    },
  });
  return null;
}
