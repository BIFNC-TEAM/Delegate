import {
  ApprovalStatus,
  HandoffStatus,
  Prisma,
  WorkflowCommandType,
  WorkflowEngine,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import {
  approvalExpirationInputSchema,
  creatorTrainingReviewInputSchema,
  handoffFollowUpInputSchema,
} from "@delegate/workflows";
import {
  buildCreatorTrainingSuggestions,
  finalizeComputeApprovalConversation,
} from "@delegate/web-data";

import { prisma } from "./prisma";

const DEFAULT_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";
const WORKFLOW_COMMAND_CLAIM_LEASE_MS = 30_000;
const WORKFLOW_COMMAND_INITIAL_BACKOFF_MS = 5_000;
const WORKFLOW_COMMAND_MAX_BACKOFF_MS = 5 * 60 * 1_000;

type WorkflowRunRecord = Awaited<ReturnType<typeof loadWorkflowRun>>;
type WorkflowCommandRecord = Awaited<ReturnType<typeof loadWorkflowCommand>>;

export type WorkflowTickSummary = {
  processed: number;
  completed: number;
  dispatched: number;
  failed: number;
};

export type TemporalWorkflowStartResult = {
  outcome: "started" | "already_started";
  runId?: string | null;
  observedAt?: Date;
};

export type TemporalWorkflowCancelResult = {
  outcome: "canceled" | "already_closed" | "not_found";
  runId?: string | null;
  observedAt?: Date;
};

export type TemporalWorkflowDispatcher = {
  startWorkflowExecution(params: {
    workflowRunId: string;
    workflowKind: WorkflowKind;
    workflowId: string;
    taskQueue: string;
    scheduledAt: Date;
  }): Promise<TemporalWorkflowStartResult>;
  cancelWorkflowExecution(params: {
    workflowRunId: string;
    workflowKind: WorkflowKind;
    workflowId: string;
    runId?: string;
  }): Promise<TemporalWorkflowCancelResult>;
};

export async function runWorkflowTick(options?: {
  limit?: number;
  engine?: WorkflowEngine;
  temporalDispatcher?: TemporalWorkflowDispatcher;
}): Promise<WorkflowTickSummary> {
  const engine = options?.engine ?? WorkflowEngine.LOCAL_RUNNER;

  if (engine === WorkflowEngine.TEMPORAL) {
    return runTemporalWorkflowCommandTick(options);
  }

  return runLocalWorkflowTick(options);
}

async function runLocalWorkflowTick(options?: {
  limit?: number;
  engine?: WorkflowEngine;
  temporalDispatcher?: TemporalWorkflowDispatcher;
}): Promise<WorkflowTickSummary> {
  const now = new Date();
  const dueRuns = await prisma.workflowRun.findMany({
    where: {
      engine: WorkflowEngine.LOCAL_RUNNER,
      status: WorkflowStatus.QUEUED,
      scheduledAt: {
        lte: now,
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    take: options?.limit ?? 10,
    select: {
      id: true,
    },
  });

  let processed = 0;
  let completed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const run of dueRuns) {
    const claimed = await prisma.workflowRun.updateMany({
      where: {
        id: run.id,
        engine: WorkflowEngine.LOCAL_RUNNER,
        status: WorkflowStatus.QUEUED,
      },
      data: {
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.ACTIVITY_RUNNING,
        nextWakeAt: null,
        startedAt: now,
        lastObservedAt: now,
        lastEngineError: null,
        attemptCount: {
          increment: 1,
        },
      },
    });

    if (!claimed.count) {
      continue;
    }

    processed += 1;

    let workflow: WorkflowRunRecord = null;

    try {
      workflow = await loadWorkflowRun(run.id);
      if (!workflow) {
        continue;
      }

      await processWorkflowRunById(workflow.id);
      completed += 1;
    } catch (error) {
      failed += 1;
      const failureMessage =
        error instanceof Error ? error.message : "workflow_failed";
      await markWorkflowRunFailed(run.id, failureMessage);
      if (workflow) {
        await prisma.eventAudit.create({
          data: {
            representativeId: workflow.representativeId,
            contactId: workflow.contactId,
            conversationId: workflow.conversationId,
            type: "WORKFLOW_FAILED",
            payload: {
              workflowRunId: workflow.id,
              workflowKind: workflowKindForAudit(workflow.kind),
              ...(workflow.subagentId ? { subagentId: workflow.subagentId } : {}),
              error: failureMessage,
            },
          },
        });
      }
    }
  }

  return {
    processed,
    completed,
    dispatched,
    failed,
  };
}

async function runTemporalWorkflowCommandTick(options?: {
  limit?: number;
  engine?: WorkflowEngine;
  temporalDispatcher?: TemporalWorkflowDispatcher;
}): Promise<WorkflowTickSummary> {
  const temporalDispatcher = options?.temporalDispatcher;
  if (!temporalDispatcher) {
    throw new Error("temporal_dispatcher_missing");
  }

  const now = new Date();
  const commands = await prisma.workflowCommandOutbox.findMany({
    where: {
      processedAt: null,
      availableAt: {
        lte: now,
      },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: options?.limit ?? 10,
    select: {
      id: true,
      attemptCount: true,
    },
  });

  let processed = 0;
  let completed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const command of commands) {
    const leaseUntil = new Date(now.getTime() + WORKFLOW_COMMAND_CLAIM_LEASE_MS);
    const claimed = await prisma.workflowCommandOutbox.updateMany({
      where: {
        id: command.id,
        processedAt: null,
        availableAt: {
          lte: now,
        },
        attemptCount: command.attemptCount,
      },
      data: {
        attemptCount: {
          increment: 1,
        },
        availableAt: leaseUntil,
      },
    });

    if (!claimed.count) {
      continue;
    }

    processed += 1;

    const loadedCommand = await loadWorkflowCommand(command.id);
    if (!loadedCommand) {
      continue;
    }

    try {
      await dispatchWorkflowCommand(loadedCommand, temporalDispatcher);
      dispatched += 1;
    } catch (error) {
      failed += 1;
      await markWorkflowCommandFailed(loadedCommand, error);
    }
  }

  return {
    processed,
    completed,
    dispatched,
    failed,
  };
}

async function dispatchWorkflowCommand(
  command: NonNullable<WorkflowCommandRecord>,
  temporalDispatcher: TemporalWorkflowDispatcher,
) {
  switch (command.commandType) {
    case WorkflowCommandType.START:
      await dispatchWorkflowStartCommand(command, temporalDispatcher);
      break;
    case WorkflowCommandType.CANCEL:
      await dispatchWorkflowCancelCommand(command, temporalDispatcher);
      break;
  }
}

async function dispatchWorkflowStartCommand(
  command: NonNullable<WorkflowCommandRecord>,
  temporalDispatcher: TemporalWorkflowDispatcher,
) {
  const workflow = command.workflowRun;
  if (!workflow) {
    await markWorkflowCommandProcessed(command.id, new Date());
    return;
  }

  const observedAt = new Date();
  if (
    workflow.status === WorkflowStatus.CANCELED ||
    workflow.status === WorkflowStatus.COMPLETED ||
    workflow.status === WorkflowStatus.FAILED
  ) {
    await prisma.$transaction([
      prisma.workflowRun.update({
        where: { id: workflow.id },
        data: {
          enginePhase: enginePhaseForTerminalStatus(workflow.status),
          nextWakeAt: null,
          lastObservedAt: observedAt,
          lastEngineError: null,
          dispatchAttemptCount: {
            increment: 1,
          },
        },
      }),
      prisma.workflowCommandOutbox.update({
        where: { id: command.id },
        data: {
          processedAt: observedAt,
          lastError: null,
        },
      }),
    ]);
    return;
  }

  if (workflow.engine !== WorkflowEngine.TEMPORAL) {
    throw new Error("workflow_engine_not_temporal");
  }
  if (!workflow.externalWorkflowId) {
    throw new Error("workflow_external_id_missing");
  }

  const dispatchResult = await temporalDispatcher.startWorkflowExecution({
    workflowRunId: workflow.id,
    workflowKind: workflow.kind,
    workflowId: workflow.externalWorkflowId,
    taskQueue: workflow.queueName ?? DEFAULT_TEMPORAL_TASK_QUEUE,
    scheduledAt: workflow.scheduledAt,
  });
  const effectiveObservedAt = dispatchResult.observedAt ?? new Date();

  const activated = await prisma.workflowRun.updateMany({
    where: {
      id: workflow.id,
      status: {
        in: [WorkflowStatus.QUEUED, WorkflowStatus.RUNNING],
      },
    },
    data: {
      status: WorkflowStatus.RUNNING,
      enginePhase: WorkflowEnginePhase.WAITING_TIMER,
      externalRunId: dispatchResult.runId ?? workflow.externalRunId ?? null,
      startedAt: workflow.startedAt ?? effectiveObservedAt,
      nextWakeAt: workflow.scheduledAt,
      lastObservedAt: effectiveObservedAt,
      lastEngineError: null,
      dispatchAttemptCount: {
        increment: 1,
      },
    },
  });

  if (activated.count) {
    await markWorkflowCommandProcessed(command.id, effectiveObservedAt);
    return;
  }

  const latestWorkflow = await prisma.workflowRun.findUnique({
    where: { id: workflow.id },
    select: {
      id: true,
      status: true,
      enginePhase: true,
      startedAt: true,
      externalRunId: true,
    },
  });

  await prisma.$transaction([
    ...(latestWorkflow
      ? [
          prisma.workflowRun.update({
            where: { id: workflow.id },
            data: {
              externalRunId:
                dispatchResult.runId ?? latestWorkflow.externalRunId ?? null,
              startedAt: latestWorkflow.startedAt ?? effectiveObservedAt,
              lastObservedAt: effectiveObservedAt,
              lastEngineError: null,
              dispatchAttemptCount: {
                increment: 1,
              },
              ...(latestWorkflow.enginePhase
                ? {}
                : {
                    enginePhase: enginePhaseForTerminalStatus(latestWorkflow.status),
                  }),
            },
          }),
        ]
      : []),
    prisma.workflowCommandOutbox.update({
      where: { id: command.id },
      data: {
        processedAt: effectiveObservedAt,
        lastError: null,
      },
    }),
  ]);
}

async function dispatchWorkflowCancelCommand(
  command: NonNullable<WorkflowCommandRecord>,
  temporalDispatcher: TemporalWorkflowDispatcher,
) {
  const workflow = command.workflowRun;
  if (!workflow) {
    await markWorkflowCommandProcessed(command.id, new Date());
    return;
  }

  const cleanupAsCanceled = async (observedAt: Date) => {
    await prisma.$transaction([
      prisma.workflowRun.update({
        where: { id: workflow.id },
        data: {
          enginePhase: WorkflowEnginePhase.CANCELED,
          nextWakeAt: null,
          lastObservedAt: observedAt,
          lastEngineError: null,
          dispatchAttemptCount: {
            increment: 1,
          },
        },
      }),
      prisma.workflowCommandOutbox.update({
        where: { id: command.id },
        data: {
          processedAt: observedAt,
          lastError: null,
        },
      }),
    ]);
  };

  if (workflow.engine !== WorkflowEngine.TEMPORAL || !workflow.externalWorkflowId) {
    await cleanupAsCanceled(new Date());
    return;
  }

  const cancelResult = await temporalDispatcher.cancelWorkflowExecution({
    workflowRunId: workflow.id,
    workflowKind: workflow.kind,
    workflowId: workflow.externalWorkflowId,
    ...(workflow.externalRunId ? { runId: workflow.externalRunId } : {}),
  });

  await cleanupAsCanceled(cancelResult.observedAt ?? new Date());
}

async function markWorkflowCommandProcessed(commandId: string, observedAt: Date) {
  await prisma.workflowCommandOutbox.update({
    where: { id: commandId },
    data: {
      processedAt: observedAt,
      lastError: null,
    },
  });
}

async function markWorkflowCommandFailed(
  command: NonNullable<WorkflowCommandRecord>,
  error: unknown,
) {
  const observedAt = new Date();
  const failureMessage =
    error instanceof Error ? error.message : "workflow_command_failed";
  const retryAt = new Date(
    observedAt.getTime() + workflowCommandRetryBackoffMs(command.attemptCount),
  );

  const workflowUpdate = command.workflowRun
    ? prisma.workflowRun.update({
        where: {
          id: command.workflowRun.id,
        },
        data: {
          dispatchAttemptCount: {
            increment: 1,
          },
          lastObservedAt: observedAt,
          lastEngineError: failureMessage,
          enginePhase:
            command.commandType === WorkflowCommandType.CANCEL
              ? WorkflowEnginePhase.CANCEL_REQUESTED
              : WorkflowEnginePhase.RETRY_BACKOFF,
          nextWakeAt: retryAt,
        },
      })
    : null;

  await prisma.$transaction([
    prisma.workflowCommandOutbox.update({
      where: { id: command.id },
      data: {
        availableAt: retryAt,
        lastError: failureMessage,
      },
    }),
    ...(workflowUpdate ? [workflowUpdate] : []),
  ]);
}

function workflowCommandRetryBackoffMs(attemptCount: number) {
  return Math.min(
    WORKFLOW_COMMAND_INITIAL_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1),
    WORKFLOW_COMMAND_MAX_BACKOFF_MS,
  );
}

function enginePhaseForTerminalStatus(status: WorkflowStatus) {
  switch (status) {
    case WorkflowStatus.COMPLETED:
      return WorkflowEnginePhase.COMPLETED;
    case WorkflowStatus.FAILED:
      return WorkflowEnginePhase.FAILED;
    case WorkflowStatus.CANCELED:
      return WorkflowEnginePhase.CANCELED;
    default:
      return null;
  }
}

export async function processWorkflowRunById(workflowRunId: string) {
  const workflow = await loadWorkflowRun(workflowRunId);
  if (!workflow) {
    return;
  }

  if (workflow.status === WorkflowStatus.CANCELED) {
    await markWorkflowRunCanceledObserved(workflow.id);
    return;
  }

  if (workflow.status === WorkflowStatus.COMPLETED || workflow.status === WorkflowStatus.FAILED) {
    return;
  }

  switch (workflow.kind) {
    case WorkflowKind.APPROVAL_EXPIRATION:
      await processApprovalExpiration(workflow);
      break;
    case WorkflowKind.HANDOFF_FOLLOW_UP:
      await processHandoffFollowUp(workflow);
      break;
    case WorkflowKind.CREATOR_TRAINING_REVIEW:
      await processCreatorTrainingReview(workflow);
      break;
  }
}

export async function markWorkflowRunFailed(workflowRunId: string, failureMessage: string) {
  await prisma.workflowRun.updateMany({
    where: {
      id: workflowRunId,
      status: {
        not: WorkflowStatus.CANCELED,
      },
    },
    data: {
      status: WorkflowStatus.FAILED,
      enginePhase: WorkflowEnginePhase.FAILED,
      nextWakeAt: null,
      failedAt: new Date(),
      lastObservedAt: new Date(),
      lastError: failureMessage,
    },
  });
}

async function markWorkflowRunCanceledObserved(workflowRunId: string) {
  await prisma.workflowRun.update({
    where: { id: workflowRunId },
    data: {
      enginePhase: WorkflowEnginePhase.CANCELED,
      nextWakeAt: null,
      lastObservedAt: new Date(),
      lastEngineError: null,
    },
  });
}

async function processApprovalExpiration(workflow: NonNullable<WorkflowRunRecord>) {
  const input = approvalExpirationInputSchema.parse(workflow.input);
  const now = new Date();

  const approval = workflow.approvalRequest;
  if (!approval) {
    await completeWorkflowRun(workflow.id, {
      outcome: "skipped_missing_approval",
      approvalId: input.approvalId,
    });
    return;
  }

  if (approval.status !== ApprovalStatus.PENDING) {
    if (approval.status === ApprovalStatus.EXPIRED) {
      await finalizeComputeApprovalConversation({
        approvalId: approval.id,
        outcome: "expired",
      });
    }
    await completeWorkflowRun(workflow.id, {
      outcome: "skipped_already_resolved",
      approvalId: approval.id,
      approvalStatus: approval.status.toLowerCase(),
    });
    return;
  }

  const didExpire = await prisma.$transaction(async (tx) => {
    const expired = await tx.approvalRequest.updateMany({
      where: { id: approval.id, status: ApprovalStatus.PENDING },
      data: {
        status: ApprovalStatus.EXPIRED,
        resolvedAt: now,
        resolvedBy: "workflow-runner",
      },
    });
    if (expired.count !== 1) return false;

    if (approval.toolExecutionId) {
      await tx.toolExecution.updateMany({
        where: {
          approvalRequestId: approval.id,
          status: "BLOCKED",
        },
        data: {
          status: "CANCELED",
          finishedAt: now,
        },
      });
    }

    await tx.eventAudit.create({
      data: {
        representativeId: workflow.representativeId,
        contactId: workflow.contactId,
        conversationId: workflow.conversationId,
        type: "APPROVAL_RESOLVED",
        payload: {
          workflowRunId: workflow.id,
          workflowKind: "approval_expiration",
          approvalRequestId: approval.id,
          ...(workflow.subagentId ? { subagentId: workflow.subagentId } : {}),
          resolution: "expired",
          resolvedBy: "workflow-runner",
        },
      },
    });
    return true;
  });

  if (!didExpire) {
    await completeWorkflowRun(workflow.id, {
      outcome: "skipped_concurrent_resolution",
      approvalId: approval.id,
    });
    return;
  }

  await finalizeComputeApprovalConversation({
    approvalId: approval.id,
    outcome: "expired",
  });

  await completeWorkflowRun(workflow.id, {
    outcome: "approval_expired",
    approvalId: approval.id,
    timeoutMinutes: input.timeoutMinutes,
  });
}

async function processHandoffFollowUp(workflow: NonNullable<WorkflowRunRecord>) {
  const input = handoffFollowUpInputSchema.parse(workflow.input);

  const handoff = workflow.handoffRequest;
  if (!handoff) {
    await completeWorkflowRun(workflow.id, {
      outcome: "skipped_missing_handoff",
      handoffId: input.handoffId,
    });
    return;
  }

  if (handoff.status !== HandoffStatus.OPEN && handoff.status !== HandoffStatus.REVIEWING) {
    await completeWorkflowRun(workflow.id, {
      outcome: "skipped_handoff_resolved",
      handoffId: handoff.id,
      handoffStatus: handoff.status.toLowerCase(),
    });
    return;
  }

  await prisma.eventAudit.create({
    data: {
      representativeId: workflow.representativeId,
      contactId: workflow.contactId,
      conversationId: workflow.conversationId,
      type: "WORKFLOW_COMPLETED",
      payload: {
        workflowRunId: workflow.id,
        workflowKind: "handoff_follow_up",
        handoffId: handoff.id,
        ...(workflow.subagentId ? { subagentId: workflow.subagentId } : {}),
        status: handoff.status.toLowerCase(),
        action: "owner_follow_up_due",
      },
    },
  });

  await completeWorkflowRun(workflow.id, {
    outcome: "handoff_follow_up_due",
    handoffId: handoff.id,
    handoffStatus: handoff.status.toLowerCase(),
    handoffWindowHours: input.handoffWindowHours,
  });
}

async function processCreatorTrainingReview(workflow: NonNullable<WorkflowRunRecord>) {
  const input = creatorTrainingReviewInputSchema.parse(workflow.input);
  const suggestions = await buildCreatorTrainingSuggestions(input.representativeSlug, {
    ...(input.feedbackLimit !== undefined ? { feedbackLimit: input.feedbackLimit } : {}),
    ...(input.unknownQuestionLimit !== undefined
      ? { unknownQuestionLimit: input.unknownQuestionLimit }
      : {}),
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: workflow.representativeId,
      contactId: workflow.contactId,
      conversationId: workflow.conversationId,
      type: "WORKFLOW_COMPLETED",
      payload: {
        workflowRunId: workflow.id,
        workflowKind: "creator_training_review",
        representativeSlug: input.representativeSlug,
        suggestionCount: suggestions.length,
        action: "creator_training_suggestions_built",
      },
    },
  });

  await completeWorkflowRun(workflow.id, {
    outcome: "creator_training_suggestions_built",
    representativeSlug: input.representativeSlug,
    suggestionCount: suggestions.length,
  });
}

async function completeWorkflowRun(workflowRunId: string, output: Record<string, unknown>) {
  await prisma.workflowRun.updateMany({
    where: {
      id: workflowRunId,
      status: {
        not: WorkflowStatus.CANCELED,
      },
    },
    data: {
      status: WorkflowStatus.COMPLETED,
      enginePhase: WorkflowEnginePhase.COMPLETED,
      nextWakeAt: null,
      completedAt: new Date(),
      lastObservedAt: new Date(),
      lastEngineError: null,
      output: output as Prisma.InputJsonValue,
    },
  });
}

async function loadWorkflowRun(workflowRunId: string) {
  return prisma.workflowRun.findUnique({
    where: { id: workflowRunId },
    include: {
      approvalRequest: true,
      handoffRequest: true,
      representative: {
        select: {
          slug: true,
        },
      },
    },
  });
}

function workflowKindForAudit(kind: WorkflowKind) {
  switch (kind) {
    case WorkflowKind.HANDOFF_FOLLOW_UP:
      return "handoff_follow_up";
    case WorkflowKind.CREATOR_TRAINING_REVIEW:
      return "creator_training_review";
    case WorkflowKind.APPROVAL_EXPIRATION:
    default:
      return "approval_expiration";
  }
}

async function loadWorkflowCommand(commandId: string) {
  return prisma.workflowCommandOutbox.findUnique({
    where: { id: commandId },
    include: {
      workflowRun: {
        select: {
          id: true,
          kind: true,
          engine: true,
          status: true,
          enginePhase: true,
          queueName: true,
          externalWorkflowId: true,
          externalRunId: true,
          scheduledAt: true,
          startedAt: true,
          nextWakeAt: true,
          lastObservedAt: true,
          cancelRequestedAt: true,
        },
      },
    },
  });
}

export async function cancelWorkflowRunsForApproval(approvalId: string) {
  return prisma.workflowRun.updateMany({
    where: {
      approvalRequestId: approvalId,
      status: WorkflowStatus.QUEUED,
    },
    data: {
      status: WorkflowStatus.CANCELED,
      enginePhase: WorkflowEnginePhase.CANCELED,
      nextWakeAt: null,
      completedAt: new Date(),
      lastObservedAt: new Date(),
      output: {
        outcome: "canceled_after_manual_resolution",
      },
    },
  });
}

export async function cancelWorkflowRunsForHandoff(handoffId: string) {
  return prisma.workflowRun.updateMany({
    where: {
      handoffRequestId: handoffId,
      status: WorkflowStatus.QUEUED,
    },
    data: {
      status: WorkflowStatus.CANCELED,
      enginePhase: WorkflowEnginePhase.CANCELED,
      nextWakeAt: null,
      completedAt: new Date(),
      lastObservedAt: new Date(),
      output: {
        outcome: "canceled_after_handoff_resolution",
      },
    },
  });
}

export function deriveApprovalExpirationOutcome(status: ApprovalStatus) {
  return status === ApprovalStatus.PENDING ? "expire" : "skip";
}

export function deriveHandoffFollowUpOutcome(status: HandoffStatus) {
  return status === HandoffStatus.OPEN || status === HandoffStatus.REVIEWING
    ? "follow_up"
    : "skip";
}
