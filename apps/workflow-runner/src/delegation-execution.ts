import {
  Prisma,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import {
  delegationExecutionStateSchema,
  delegationExecutionTransitionInputSchema,
  type DelegationExecutionPhase,
  type DelegationExecutionSignal,
  type DelegationExecutionState,
  type DelegationExecutionTransitionInput,
} from "@delegate/workflows";

import { prisma } from "./prisma";

/**
 * Persists one deterministic Temporal transition. The DelegationTask aggregate
 * remains the business source of truth; this activity records only orchestration
 * progress and is safe to replay with the same transitionId.
 */
export async function executeDelegationExecutionTransition(
  rawInput: DelegationExecutionTransitionInput,
): Promise<DelegationExecutionState> {
  const input = delegationExecutionTransitionInputSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT "id"
      FROM "WorkflowRun"
      WHERE "id" = ${input.workflowRunId}
      FOR UPDATE
    `;

    const workflow = await tx.workflowRun.findUnique({
      where: { id: input.workflowRunId },
      select: {
        id: true,
        kind: true,
        delegationTaskId: true,
        turnPlanId: true,
        output: true,
        delegationTask: {
          select: { status: true },
        },
      },
    });
    if (!workflow) throw new Error("delegation_execution_workflow_not_found");
    if (workflow.kind !== WorkflowKind.DELEGATION_EXECUTION) {
      throw new Error("delegation_execution_workflow_kind_mismatch");
    }
    if (workflow.delegationTaskId !== input.delegationTaskId) {
      throw new Error("delegation_execution_workflow_context_mismatch");
    }

    const previous = readDelegationExecutionState(workflow.output);
    if (previous?.lastTransitionId === input.transitionId) return previous;

    const phase = resolveDelegationExecutionPhase({
      taskStatus: workflow.delegationTask?.status ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const state = delegationExecutionStateSchema.parse({
      workflowRunId: workflow.id,
      delegationTaskId: input.delegationTaskId,
      ...(workflow.turnPlanId ? { turnPlanId: workflow.turnPlanId } : {}),
      phase,
      revision: (previous?.revision ?? 0) + 1,
      lastTransitionId: input.transitionId,
      ...(input.signal ? { lastSignal: input.signal } : {}),
    });
    const terminal = terminalWorkflowStateForPhase(phase);
    const observedAt = new Date();
    const updated = await tx.workflowRun.updateMany({
      where: {
        id: workflow.id,
        kind: WorkflowKind.DELEGATION_EXECUTION,
        delegationTaskId: input.delegationTaskId,
      },
      data: {
        status: terminal.status,
        enginePhase: terminal.enginePhase,
        lastObservedAt: observedAt,
        nextWakeAt: null,
        ...(terminal.status === WorkflowStatus.COMPLETED
          ? { completedAt: observedAt, failedAt: null }
          : {}),
        ...(terminal.status === WorkflowStatus.FAILED
          ? { failedAt: observedAt }
          : {}),
        ...(terminal.status === WorkflowStatus.CANCELED
          ? { completedAt: observedAt }
          : {}),
        output: state as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      throw new Error("delegation_execution_workflow_transition_lost");
    }
    return state;
  });
}

export function resolveDelegationExecutionPhase(input: {
  taskStatus: string | null;
  signal?: DelegationExecutionSignal;
}): DelegationExecutionPhase {
  switch (input.taskStatus) {
    case "AWAITING_APPROVAL":
      return "waiting_approval";
    case "WAITING_FOR_USER":
    case "CLARIFYING":
      return "waiting_user";
    case "WAITING_FOR_OWNER":
      return "waiting_reconciliation";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "EXPIRED":
      return "failed";
    case "CANCELED":
      return "canceled";
  }
  // Signals are wake-up notifications only. The API that emits a signal must
  // commit the corresponding DelegationTask mutation first.
  return input.taskStatus ? "running" : "failed";
}

export function isDelegationExecutionTerminalPhase(
  phase: DelegationExecutionPhase,
): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}

function readDelegationExecutionState(value: unknown) {
  const parsed = delegationExecutionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function terminalWorkflowStateForPhase(phase: DelegationExecutionPhase): {
  status: WorkflowStatus;
  enginePhase: WorkflowEnginePhase;
} {
  switch (phase) {
    case "completed":
      return {
        status: WorkflowStatus.COMPLETED,
        enginePhase: WorkflowEnginePhase.COMPLETED,
      };
    case "failed":
      return {
        status: WorkflowStatus.FAILED,
        enginePhase: WorkflowEnginePhase.FAILED,
      };
    case "canceled":
      return {
        status: WorkflowStatus.CANCELED,
        enginePhase: WorkflowEnginePhase.CANCELED,
      };
    case "waiting_approval":
    case "waiting_user":
    case "waiting_reconciliation":
      return {
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.WAITING_SIGNAL,
      };
    case "running":
    default:
      return {
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.ACTIVITY_RUNNING,
      };
  }
}
