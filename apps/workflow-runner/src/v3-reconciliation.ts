import { prisma } from "./prisma";

export async function reconcileV3RuntimeInvariants(input: {
  now?: Date;
  staleBefore?: Date;
} = {}) {
  const now = input.now ?? new Date();
  const staleBefore = input.staleBefore ?? new Date(now.getTime() - 15 * 60_000);
  const orphanedAttempts = await prisma.toolExecution.findMany({
    where: {
      planActionId: { not: null },
      status: "QUEUED",
      executionOutboxId: null,
      createdAt: { lt: staleBefore },
    },
    select: { id: true, planActionId: true },
    take: 100,
  });
  let attemptsClosed = 0;
  for (const attempt of orphanedAttempts) {
    const closed = await prisma.toolExecution.updateMany({
      where: {
        id: attempt.id,
        status: "QUEUED",
        executionOutboxId: null,
      },
      data: {
        status: "FAILED",
        attemptPhase: "FAILED_BEFORE_CALL",
        transportOutcome: "confirmed_not_sent",
        semanticOutcome: "failed",
        finishedAt: now,
        executionLeaseToken: null,
      },
    });
    attemptsClosed += closed.count;
    if (closed.count && attempt.planActionId) {
      await prisma.conversationPlanAction.updateMany({
        where: { id: attempt.planActionId, status: "QUEUED" },
        data: { status: "FAILED", failedAt: now },
      });
      await prisma.billableUnit.updateMany({
        where: {
          actionId: attempt.planActionId,
          status: { in: ["PENDING_RESERVATION", "RESERVED", "TRANSFERRED"] },
        },
        data: { status: "RELEASED", releasedAt: now },
      });
    }
  }

  const abandonedPreCallAttempts = await prisma.toolExecution.findMany({
    where: {
      planActionId: { not: null },
      status: "RUNNING",
      attemptPhase: { in: ["CREATED", "CLAIMED", "CALL_PREPARED"] },
      startedAt: { lt: staleBefore },
    },
    select: {
      id: true,
      planActionId: true,
      executionOutboxId: true,
      externalEffectId: true,
    },
    take: 100,
  });
  let attemptsConfirmedNotSent = 0;
  for (const attempt of abandonedPreCallAttempts) {
    const closed = await prisma.toolExecution.updateMany({
      where: {
        id: attempt.id,
        status: "RUNNING",
        attemptPhase: { in: ["CREATED", "CLAIMED", "CALL_PREPARED"] },
      },
      data: {
        status: "FAILED",
        attemptPhase: "FAILED_BEFORE_CALL",
        transportOutcome: "confirmed_not_sent",
        semanticOutcome: "failed",
        finishedAt: now,
        executionLeaseToken: null,
      },
    });
    attemptsConfirmedNotSent += closed.count;
    if (!closed.count) continue;
    await prisma.conversationPlanAction.updateMany({
      where: { id: attempt.planActionId!, status: "EXECUTING" },
      data: { status: "FAILED", failedAt: now },
    });
    await prisma.billableUnit.updateMany({
      where: {
        actionId: attempt.planActionId!,
        status: { in: ["PENDING_RESERVATION", "RESERVED", "TRANSFERRED"] },
      },
      data: { status: "RELEASED", releasedAt: now },
    });
    if (attempt.externalEffectId) {
      await prisma.delegationTaskExternalEffect.updateMany({
        where: {
          id: attempt.externalEffectId,
          status: { in: ["PROPOSED", "APPROVED"] },
        },
        data: {
          status: "FAILED",
          failureReason: "execution_lease_expired_before_call",
        },
      });
    }
    if (attempt.executionOutboxId) {
      await prisma.outboxEvent.updateMany({
        where: { id: attempt.executionOutboxId, status: { not: "PROCESSED" } },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: "execution_lease_expired_before_call",
        },
      });
    }
  }

  const abandonedStartedCalls = await prisma.toolExecution.findMany({
    where: {
      planActionId: { not: null },
      status: "RUNNING",
      attemptPhase: "CALL_STARTED",
      startedAt: { lt: staleBefore },
    },
    select: {
      id: true,
      planActionId: true,
      executionOutboxId: true,
      externalEffectId: true,
    },
    take: 100,
  });
  let attemptsHeldForReconciliation = 0;
  for (const attempt of abandonedStartedCalls) {
    const closed = await prisma.toolExecution.updateMany({
      where: {
        id: attempt.id,
        status: "RUNNING",
        attemptPhase: "CALL_STARTED",
      },
      data: {
        status: "FAILED",
        attemptPhase: "OUTCOME_UNKNOWN",
        transportOutcome: "outcome_unknown",
        semanticOutcome: "unknown",
        finishedAt: now,
        executionLeaseToken: null,
      },
    });
    attemptsHeldForReconciliation += closed.count;
    if (!closed.count) continue;
    await prisma.conversationPlanAction.updateMany({
      where: { id: attempt.planActionId!, status: "EXECUTING" },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    if (attempt.externalEffectId) {
      await prisma.delegationTaskExternalEffect.updateMany({
        where: { id: attempt.externalEffectId },
        data: {
          status: "RECONCILIATION_REQUIRED",
          failureReason: "execution_lease_expired_after_call_started",
        },
      });
    }
    await prisma.billableUnit.updateMany({
      where: {
        actionId: attempt.planActionId!,
        status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
      },
      data: {
        status: "HELD_FOR_RECONCILIATION",
        reconciliationHeldAt: now,
      },
    });
    if (attempt.executionOutboxId) {
      await prisma.outboxEvent.updateMany({
        where: { id: attempt.executionOutboxId, status: { not: "PROCESSED" } },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: "execution_outcome_unknown",
        },
      });
    }
  }

  const terminalAttemptsMissingResult = await prisma.toolExecution.findMany({
    where: {
      planActionId: { not: null },
      status: { in: ["SUCCEEDED", "FAILED"] },
      actionResult: { is: null },
      finishedAt: { lt: staleBefore },
    },
    select: {
      id: true,
      planActionId: true,
      executionOutboxId: true,
      externalEffectId: true,
    },
    take: 100,
  });
  let terminalAttemptsMissingResultHeld = 0;
  for (const attempt of terminalAttemptsMissingResult) {
    const action = await prisma.conversationPlanAction.updateMany({
      where: {
        id: attempt.planActionId!,
        status: { in: ["EXECUTING", "VERIFYING"] },
      },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    if (!action.count) continue;
    terminalAttemptsMissingResultHeld += 1;
    if (attempt.externalEffectId) {
      await prisma.delegationTaskExternalEffect.updateMany({
        where: { id: attempt.externalEffectId },
        data: {
          status: "RECONCILIATION_REQUIRED",
          failureReason: "terminal_execution_missing_verified_result",
        },
      });
    }
    await prisma.billableUnit.updateMany({
      where: {
        actionId: attempt.planActionId!,
        status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
      },
      data: {
        status: "HELD_FOR_RECONCILIATION",
        reconciliationHeldAt: now,
      },
    });
    if (attempt.executionOutboxId) {
      await prisma.outboxEvent.updateMany({
        where: {
          id: attempt.executionOutboxId,
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: "terminal_execution_missing_verified_result",
        },
      });
    }
  }

  const pendingUnits = await prisma.billableUnit.updateMany({
    where: {
      status: "PENDING_RESERVATION",
      createdAt: { lt: staleBefore },
    },
    data: { status: "RELEASED", releasedAt: now },
  });
  const heldUnits = await prisma.billableUnit.updateMany({
    where: {
      status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: "HELD_FOR_RECONCILIATION",
      reconciliationHeldAt: now,
    },
  });

  const fences = await prisma.planExecutionFence.findMany({
    include: { activePlan: { select: { revision: true, executionEpoch: true, status: true } } },
    take: 1_000,
  });
  const fenceDrift = fences.filter((fence) =>
    fence.activeRevision !== fence.activePlan.revision
    || fence.executionEpoch !== fence.activePlan.executionEpoch
    || ["CANCELED", "FAILED", "SUPERSEDED"].includes(fence.activePlan.status)).length;

  return {
    attemptsClosed,
    attemptsConfirmedNotSent,
    attemptsHeldForReconciliation,
    terminalAttemptsMissingResultHeld,
    pendingUnitsReleased: pendingUnits.count,
    unitsHeldForReconciliation: heldUnits.count,
    fenceDrift,
  };
}
