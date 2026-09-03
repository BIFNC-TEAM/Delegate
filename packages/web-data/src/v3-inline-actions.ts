import {
  stableSha256,
  normalizeEvidenceBindings,
  turnPlanV3Schema,
  verifyRawActionResult,
  type SuccessContractV3,
  type TransportOutcomeV3,
} from "@delegate/runtime";
import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export async function loadV3GovernedCompositionContext(input: {
  delegationTaskId: string;
}) {
  const plan = await prisma.conversationTurnPlan.findFirst({
    where: {
      delegationTaskId: input.delegationTaskId,
      protocolVersion: 3,
      shadowMode: false,
      status: { in: ["VALIDATED", "EXECUTING"] },
    },
    orderBy: { revision: "desc" },
    include: {
      activeExecutionFence: true,
      actions: {
        orderBy: { sequence: "asc" },
        include: {
          actionResults: { orderBy: { verifiedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!plan) return null;
  const fence = plan.activeExecutionFence;
  if (
    !fence
    || fence.activePlanId !== plan.id
    || fence.activeRevision !== plan.revision
    || fence.executionEpoch !== plan.executionEpoch
  ) {
    throw new Error("V3 governed composition fence is no longer current.");
  }
  const parsedPlan = turnPlanV3Schema.parse(plan.planSnapshot);
  const actionByKey = new Map(plan.actions.map((action) => [action.actionKey, action]));
  const composeDefinition = parsedPlan.actions.find((action) =>
    action.capability.key === "response.compose");
  const composeAction = composeDefinition
    ? actionByKey.get(composeDefinition.id)
    : null;
  if (!composeDefinition || !composeAction) {
    throw new Error("V3 governed plan has no response.compose action.");
  }
  return {
    plan,
    parsedPlan,
    composeDefinition,
    composeAction,
  };
}

export async function prepareV3InlineAction(input: {
  planActionId: string;
  expectedAuthorizationVersion: number;
  executor: "builtin" | "knowledge";
  billingAdmission: {
    decision: "not_billable";
    reasonCode: "generation_run_owns_conversation_billing";
  };
  generationWorkLease: {
    outboxId: string;
    leaseAttempt: number;
  };
  leaseMs?: number;
}) {
  if (
    input.billingAdmission.reasonCode
      !== "generation_run_owns_conversation_billing"
  ) {
    throw new Error("V3 inline Action billing admission is invalid.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.planActionId}))`;
    const action = await tx.conversationPlanAction.findUnique({
      where: { id: input.planActionId },
      include: { turnPlan: { include: { activeExecutionFence: true } } },
    });
    if (!action) throw new Error("V3 inline action not found.");
    const plan = action.turnPlan;
    const fence = plan.activeExecutionFence;
    if (
      plan.protocolVersion !== 3
      || plan.shadowMode
      || !["VALIDATED", "EXECUTING"].includes(plan.status)
      || !fence
      || fence.activePlanId !== plan.id
      || fence.activeRevision !== plan.revision
      || fence.executionEpoch !== plan.executionEpoch
    ) {
      throw new Error("V3 inline action lost its active plan fence.");
    }
    await assertInlineGenerationWorkLease(tx, plan, input.generationWorkLease);
    await assertInlineActionDependenciesAndActivation(tx, action);
    const existing = await tx.toolExecution.findFirst({
      where: {
        planActionId: action.id,
        executionEpoch: plan.executionEpoch,
        status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] },
      },
      orderBy: { attemptNumber: "desc" },
    });
    if (existing?.status === "SUCCEEDED") {
      return { plan, action, attempt: existing };
    }
    const leasePrefix = inlineExecutionLeasePrefix(
      input.generationWorkLease,
      action.id,
    );
    if (existing) {
      if (existing.executionLeaseToken?.startsWith(leasePrefix)) {
        return { plan, action, attempt: existing };
      }
      if (
        existing.status === "RUNNING"
        && existing.attemptPhase === "CALL_STARTED"
      ) {
        const reconciledAt = new Date();
        const unknown = await tx.toolExecution.updateMany({
          where: {
            id: existing.id,
            status: "RUNNING",
            attemptPhase: "CALL_STARTED",
          },
          data: {
            status: "FAILED",
            attemptPhase: "OUTCOME_UNKNOWN",
            transportOutcome: "outcome_unknown",
            semanticOutcome: "unknown",
            executionLeaseToken: null,
            finishedAt: reconciledAt,
          },
        });
        if (unknown.count !== 1) {
          const settled = await tx.toolExecution.findUnique({
            where: { id: existing.id },
          });
          if (settled?.status === "SUCCEEDED") {
            return { plan, action, attempt: settled };
          }
          throw new Error("V3 inline prior call changed during reconciliation.");
        }
        await tx.conversationPlanAction.updateMany({
          where: { id: action.id, status: "EXECUTING" },
          data: { status: "RECONCILIATION_REQUIRED" },
        });
        if (existing.executionOutboxId) {
          await tx.outboxEvent.updateMany({
            where: {
              id: existing.executionOutboxId,
              status: { in: ["PENDING", "PROCESSING", "FAILED"] },
            },
            data: {
              status: "PROCESSED",
              processedAt: reconciledAt,
              lastError: "inline_execution_outcome_unknown",
            },
          });
        }
        throw new Error("V3 inline action has an unresolved prior call outcome.");
      }
      const reclaimedAt = new Date();
      const reclaimed = await tx.toolExecution.updateMany({
        where: {
          id: existing.id,
          status: { in: ["QUEUED", "RUNNING"] },
          attemptPhase: { in: ["CREATED", "CLAIMED", "CALL_PREPARED"] },
        },
        data: {
          status: "FAILED",
          attemptPhase: "FAILED_BEFORE_CALL",
          transportOutcome: "confirmed_not_sent",
          semanticOutcome: "failed",
          executionLeaseToken: null,
          finishedAt: reclaimedAt,
        },
      });
      if (reclaimed.count !== 1) {
        throw new Error("V3 inline execution changed during pre-call reclaim.");
      }
      if (existing.executionOutboxId) {
        await tx.outboxEvent.updateMany({
          where: {
            id: existing.executionOutboxId,
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          data: {
            status: "PROCESSED",
            processedAt: reclaimedAt,
            lastError: "inline_execution_lease_reclaimed_before_call",
          },
        });
      }
      await tx.conversationPlanAction.updateMany({
        where: { id: action.id, status: "EXECUTING" },
        data: { status: "READY", startedAt: null },
      });
    }
    if (
      (action.status !== "READY" && action.status !== "EXECUTING")
      || action.authorizationPhase !== "PRE_EXECUTION"
      || action.effectiveDecision !== "ALLOW"
      || action.authorizationVersion !== input.expectedAuthorizationVersion
    ) {
      throw new Error("V3 inline action requires current pre-execution authorization.");
    }
    const latest = await tx.toolExecution.findFirst({
      where: { planActionId: action.id },
      orderBy: { attemptNumber: "desc" },
      select: { attemptNumber: true },
    });
    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const outbox = await tx.outboxEvent.create({
      data: {
        conversationId: plan.conversationId,
        aggregateType: "action_execution_attempt",
        aggregateId: action.id,
        eventType: "action.execution.requested",
        status: "PROCESSING",
        availableAt: new Date(Date.now() + (input.leaseMs ?? 5 * 60_000)),
        payload: {
          planId: plan.id,
          planRevision: plan.revision,
          executionEpoch: plan.executionEpoch,
          actionId: action.id,
          attemptNumber,
          executor: input.executor,
        },
        idempotencyKey:
          `action.execution.requested:${plan.id}:${plan.executionEpoch}:${action.id}:${attemptNumber}`,
      },
    });
    const now = new Date();
    const attempt = await tx.toolExecution.create({
      data: {
        sessionId: null,
        planActionId: action.id,
        planRevision: plan.revision,
        executionEpoch: plan.executionEpoch,
        attemptNumber,
        attemptPhase: "CALL_PREPARED",
        executionOutboxId: outbox.id,
        capability: input.executor === "knowledge" ? "KNOWLEDGE" : "BUILTIN",
        status: "RUNNING",
        requestPayload: action.inputSnapshot as Prisma.InputJsonValue,
        requestPayloadHash: action.requestPayloadHash,
        billingAdmission: input.billingAdmission as Prisma.InputJsonObject,
        startedAt: now,
        executionLeaseToken: `${leasePrefix}${attemptNumber}`,
      },
    });
    await tx.conversationPlanAction.update({
      where: { id: action.id },
      data: { status: "EXECUTING", attemptCount: attemptNumber, startedAt: now },
    });
    await tx.conversationTurnPlan.updateMany({
      where: { id: plan.id, status: "VALIDATED" },
      data: { status: "EXECUTING", startedAt: now },
    });
    return { plan, action, attempt };
  });
}

export async function markV3InlineActionCallStarted(input: {
  executionAttemptId: string;
  expectedExecutionLeaseToken: string;
  leaseMs?: number;
}) {
  const initial = await prisma.toolExecution.findUnique({
    where: { id: input.executionAttemptId },
    include: { planAction: { include: { turnPlan: true } } },
  });
  if (!initial?.planAction) {
    throw new Error("V3 inline attempt context is missing before call start.");
  }
  const initialPlan = initial.planAction.turnPlan;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.executionAttemptId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${initialPlan.scopeKey ?? initialPlan.id})
      )
    `;
    const current = await tx.toolExecution.findUnique({
      where: { id: input.executionAttemptId },
      include: {
        planAction: {
          include: {
            turnPlan: { include: { activeExecutionFence: true } },
          },
        },
      },
    });
    if (!current?.planAction) {
      throw new Error("V3 inline attempt lost its plan before call start.");
    }
    const action = current.planAction;
    const plan = action.turnPlan;
    const fence = plan.activeExecutionFence;
    if (
      current.status !== "RUNNING"
      || current.executionLeaseToken !== input.expectedExecutionLeaseToken
      || action.status !== "EXECUTING"
      || !["VALIDATED", "EXECUTING"].includes(plan.status)
      || !fence
      || fence.activePlanId !== plan.id
      || fence.activeRevision !== plan.revision
      || fence.executionEpoch !== plan.executionEpoch
      || current.planRevision !== plan.revision
      || current.executionEpoch !== plan.executionEpoch
    ) {
      throw new Error("V3 inline execution claim was lost before call start.");
    }
    if (current.attemptPhase === "CALL_STARTED") return current;
    if (current.attemptPhase !== "CALL_PREPARED") {
      throw new Error("V3 inline attempt is not prepared for an external call.");
    }
    const started = await tx.toolExecution.updateMany({
      where: {
        id: current.id,
        status: "RUNNING",
        attemptPhase: "CALL_PREPARED",
        executionLeaseToken: input.expectedExecutionLeaseToken,
      },
      data: { attemptPhase: "CALL_STARTED" },
    });
    if (started.count !== 1) {
      throw new Error("V3 inline execution claim changed before call start.");
    }
    if (current.executionOutboxId) {
      const renewed = await tx.outboxEvent.updateMany({
        where: {
          id: current.executionOutboxId,
          status: "PROCESSING",
        },
        data: {
          availableAt: new Date(Date.now() + (input.leaseMs ?? 5 * 60_000)),
          lastError: null,
        },
      });
      if (renewed.count !== 1) {
        throw new Error("V3 inline execution Outbox lost its call-start fence.");
      }
    }
    return { ...current, attemptPhase: "CALL_STARTED" as const };
  });
}

export async function completeV3InlineAction(input: {
  executionAttemptId: string;
  expectedExecutionLeaseToken: string;
  transportOutcome: TransportOutcomeV3;
  rawOutput?: unknown;
  expectedOutputSchema?: Record<string, unknown>;
  successContract?: SuccessContractV3;
  evidenceBindings?: Array<Record<string, unknown>>;
  artifactRefs?: string[];
  billingUnitIds?: string[];
}) {
  const attempt = await prisma.toolExecution.findUnique({
    where: { id: input.executionAttemptId },
    include: { planAction: { include: { turnPlan: true } } },
  });
  if (!attempt?.planAction || attempt.executionOutboxId === null) {
    throw new Error("V3 inline attempt context is missing.");
  }
  const initialAction = attempt.planAction;
  const initialPlan = initialAction.turnPlan;
  const storedOutputSchema = asJsonRecord(initialAction.expectedOutputSchema);
  if (!storedOutputSchema) {
    throw new Error("V3 inline action output schema is missing.");
  }
  if (
    input.expectedOutputSchema
    && stableSha256(input.expectedOutputSchema) !== stableSha256(storedOutputSchema)
  ) {
    throw new Error("V3 inline action output schema changed after validation.");
  }
  const storedSuccessContract = asSuccessContract(initialAction.successContract);
  if (
    input.successContract
    && (!storedSuccessContract
      || stableSha256(input.successContract) !== stableSha256(storedSuccessContract))
  ) {
    throw new Error("V3 inline action success contract changed after validation.");
  }
  const verified = verifyRawActionResult({
    transportOutcome: input.transportOutcome,
    rawOutput: input.rawOutput,
    expectedOutputSchema: storedOutputSchema,
    ...(storedSuccessContract ? { successContract: storedSuccessContract } : {}),
  });
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${attempt.id}))`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${initialPlan.scopeKey ?? initialPlan.id})
      )
    `;
    const current = await tx.toolExecution.findUnique({
      where: { id: attempt.id },
      include: {
        actionResult: true,
        planAction: {
          include: {
            turnPlan: { include: { activeExecutionFence: true } },
          },
        },
      },
    });
    if (!current?.planAction) {
      throw new Error("V3 inline action lost its active plan fence during completion.");
    }
    const currentAction = current.planAction;
    const currentPlan = currentAction.turnPlan;
    const currentFence = currentPlan.activeExecutionFence;
    if (current.actionResult) {
      const replayStatus = currentAction.status === "SUCCEEDED"
        ? "SUCCEEDED" as const
        : currentAction.status === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED" as const
          : "FAILED" as const;
      return { result: current.actionResult, verified, actionStatus: replayStatus };
    }
    const activeCompletion = Boolean(
      currentFence
      && currentFence.activePlanId === currentPlan.id
      && currentFence.activeRevision === currentPlan.revision
      && currentFence.executionEpoch === currentPlan.executionEpoch
      && ["VALIDATED", "EXECUTING"].includes(currentPlan.status),
    );
    const supersededAuditCompletion = currentPlan.status === "SUPERSEDED";
    if (
      currentPlan.protocolVersion !== 3
      || currentPlan.shadowMode
      || current.planRevision !== currentPlan.revision
      || current.executionEpoch !== currentPlan.executionEpoch
      || current.status !== "RUNNING"
      || (
        activeCompletion
          ? currentAction.status !== "EXECUTING"
          : !["EXECUTING", "RECONCILIATION_REQUIRED"].includes(currentAction.status)
      )
      || current.executionLeaseToken !== input.expectedExecutionLeaseToken
      || current.attemptPhase !== "CALL_STARTED"
      || (!activeCompletion && !supersededAuditCompletion)
      || stableSha256(currentAction.expectedOutputSchema)
        !== stableSha256(storedOutputSchema)
      || stableSha256(currentAction.successContract)
        !== stableSha256(initialAction.successContract)
    ) {
      throw new Error("V3 inline action lost its active plan fence during completion.");
    }
    const actionStatus = verified.semanticOutcome === "succeeded"
      ? "SUCCEEDED" as const
      : verified.semanticOutcome === "unknown"
        || verified.transportOutcome === "outcome_unknown"
        ? "RECONCILIATION_REQUIRED" as const
        : "FAILED" as const;
    const result = await tx.actionResult.upsert({
      where: { executionAttemptId: current.id },
      create: {
        planId: currentPlan.id,
        actionId: currentAction.id,
        executionAttemptId: current.id,
        planRevision: current.planRevision!,
        executionEpoch: current.executionEpoch!,
        transportOutcome: verified.transportOutcome,
        semanticOutcome: verified.semanticOutcome,
        output: typeof verified.sanitizedOutput === "undefined"
          ? Prisma.JsonNull
          : verified.sanitizedOutput as Prisma.InputJsonValue,
        outputSchemaHash: stripHash(stableSha256(storedOutputSchema)),
        outputHash: typeof verified.sanitizedOutput === "undefined"
          ? null
          : stripHash(stableSha256(verified.sanitizedOutput)),
        securityFindings: verified.securityFindings as unknown as Prisma.InputJsonValue,
        evidenceBindings: normalizeEvidenceBindings(
          input.evidenceBindings ?? [],
        ) as Prisma.InputJsonValue,
        artifactRefs: [...new Set(input.artifactRefs ?? [])],
        usageRecordIds: [],
        billingUnitIds: [...new Set(input.billingUnitIds ?? [])],
        failure: verified.failureCode
          ? { code: verified.failureCode } as Prisma.InputJsonObject
          : Prisma.JsonNull,
        verifiedAt: now,
      },
      update: {},
    });
    const attemptUpdated = await tx.toolExecution.updateMany({
      where: {
        id: current.id,
        status: "RUNNING",
        attemptPhase: "CALL_STARTED",
        executionLeaseToken: input.expectedExecutionLeaseToken,
      },
      data: {
        status: actionStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        attemptPhase: verified.transportOutcome === "outcome_unknown"
          ? "OUTCOME_UNKNOWN"
          : "FINISHED",
        transportOutcome: verified.transportOutcome,
        semanticOutcome: verified.semanticOutcome,
        responseSnapshot: typeof verified.sanitizedOutput === "undefined"
          ? Prisma.JsonNull
          : verified.sanitizedOutput as Prisma.InputJsonValue,
        executionLeaseToken: null,
        finishedAt: now,
      },
    });
    if (attemptUpdated.count !== 1) {
      throw new Error("V3 inline execution claim changed during completion.");
    }
    const actionUpdated = await tx.conversationPlanAction.updateMany({
      where: {
        id: currentAction.id,
        status: activeCompletion
          ? "EXECUTING"
          : { in: ["EXECUTING", "RECONCILIATION_REQUIRED"] },
      },
      data: {
        status: actionStatus,
        expectedOutput: typeof verified.sanitizedOutput === "undefined"
          ? Prisma.JsonNull
          : verified.sanitizedOutput as Prisma.InputJsonValue,
        completedAt: actionStatus === "SUCCEEDED" ? now : null,
        failedAt: actionStatus === "FAILED" ? now : null,
      },
    });
    if (actionUpdated.count !== 1) {
      throw new Error("V3 inline action changed during completion.");
    }
    const outboxUpdated = await tx.outboxEvent.updateMany({
      where: {
        id: current.executionOutboxId!,
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "PROCESSED",
        processedAt: now,
        lastError: verified.failureCode ?? null,
      },
    });
    if (outboxUpdated.count !== 1) {
      throw new Error("V3 inline execution Outbox changed during completion.");
    }
    return { result, verified, actionStatus };
  });
}

/**
 * Atomically closes the read-only V3 execution lane after a confirmed inline
 * executor failure. Inline actions have no external business side effect, so
 * a provider/validation failure is a confirmed terminal outcome rather than a
 * reconciliation case.
 */
export async function failV3InlinePlanExecution(input: {
  executionAttemptId: string;
  expectedExecutionLeaseToken: string;
  reasonCode: string;
}) {
  const reasonCode = input.reasonCode.trim().slice(0, 2_000)
    || "v3_inline_execution_failed";
  const initial = await prisma.toolExecution.findUnique({
    where: { id: input.executionAttemptId },
    include: { planAction: { include: { turnPlan: true } } },
  });
  if (!initial?.planAction) {
    throw new Error("V3 inline attempt context is missing during failure closure.");
  }
  const initialPlan = initial.planAction.turnPlan;
  const failedAt = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.executionAttemptId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${initialPlan.scopeKey ?? initialPlan.id})
      )
    `;
    const attempt = await tx.toolExecution.findUnique({
      where: { id: input.executionAttemptId },
      include: {
        actionResult: true,
        planAction: {
          include: {
            turnPlan: { include: { activeExecutionFence: true } },
          },
        },
      },
    });
    if (!attempt?.planAction) {
      throw new Error("V3 inline attempt lost its plan during failure closure.");
    }
    const action = attempt.planAction;
    const plan = action.turnPlan;
    const fence = plan.activeExecutionFence;
    if (attempt.actionResult) {
      return {
        attemptsClosed: 0,
        actionsFailed: 0,
        planFailed: plan.status === "FAILED",
        memoryRunsFailed: 0,
      };
    }
    if (
      plan.protocolVersion !== 3
      || plan.shadowMode
      || !["VALIDATED", "EXECUTING"].includes(plan.status)
      || !fence
      || fence.activePlanId !== plan.id
      || fence.activeRevision !== plan.revision
      || fence.executionEpoch !== plan.executionEpoch
      || attempt.planRevision !== plan.revision
      || attempt.executionEpoch !== plan.executionEpoch
      || attempt.status !== "RUNNING"
      || attempt.executionLeaseToken !== input.expectedExecutionLeaseToken
      || !["CALL_PREPARED", "CALL_STARTED"].includes(attempt.attemptPhase ?? "")
      || action.status !== "EXECUTING"
    ) {
      throw new Error("V3 inline execution claim was lost during failure closure.");
    }
    // A dispatched read-only inline call may consume remote compute, but it
    // cannot mutate Delegate or an external system. Preserving it as an
    // unknown business outcome leaves the Plan EXECUTING forever and makes a
    // recoverable composer/knowledge failure look like reconciliation work.
    // Only a call whose immutable Action contract carries a side effect needs
    // the unknown-outcome hold.
    if (
      attempt.attemptPhase === "CALL_STARTED"
      && action.sideEffectClass !== "NONE"
    ) {
      const unknownAttempts = await tx.toolExecution.updateMany({
        where: {
          id: attempt.id,
          status: "RUNNING",
          attemptPhase: "CALL_STARTED",
          executionLeaseToken: input.expectedExecutionLeaseToken,
        },
        data: {
          status: "FAILED",
          attemptPhase: "OUTCOME_UNKNOWN",
          transportOutcome: "outcome_unknown",
          semanticOutcome: "unknown",
          executionLeaseToken: null,
          finishedAt: failedAt,
        },
      });
      if (unknownAttempts.count !== 1) {
        throw new Error("V3 inline execution changed while preserving an unknown outcome.");
      }
      const reconciledActions = await tx.conversationPlanAction.updateMany({
        where: { id: action.id, status: "EXECUTING" },
        data: { status: "RECONCILIATION_REQUIRED" },
      });
      if (reconciledActions.count !== 1) {
        throw new Error("V3 inline Action changed during reconciliation closure.");
      }
      await tx.billableUnit.updateMany({
        where: {
          actionId: action.id,
          status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
        },
        data: {
          status: "HELD_FOR_RECONCILIATION",
          reconciliationHeldAt: failedAt,
        },
      });
      if (attempt.executionOutboxId) {
        await tx.outboxEvent.updateMany({
          where: {
            id: attempt.executionOutboxId,
            eventType: "action.execution.requested",
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          data: {
            status: "PROCESSED",
            processedAt: failedAt,
            lastError: "inline_action_outcome_unknown",
          },
        });
      }
      return {
        attemptsClosed: unknownAttempts.count,
        actionsFailed: 0,
        planFailed: false,
        memoryRunsFailed: 0,
        reconciliationRequired: true,
      };
    }
    const closedAttempts = await tx.toolExecution.updateMany({
      where: {
        id: attempt.id,
        status: "RUNNING",
        executionLeaseToken: input.expectedExecutionLeaseToken,
        attemptPhase: { in: ["CALL_PREPARED", "CALL_STARTED"] },
      },
      data: {
        status: "FAILED",
        attemptPhase: attempt.attemptPhase === "CALL_PREPARED"
          ? "FAILED_BEFORE_CALL"
          : "FINISHED",
        transportOutcome: attempt.attemptPhase === "CALL_PREPARED"
          ? "confirmed_not_sent"
          : "transport_failed",
        semanticOutcome: "failed",
        executionLeaseToken: null,
        finishedAt: failedAt,
      },
    });
    if (closedAttempts.count !== 1) {
      throw new Error("V3 inline execution claim changed during failure closure.");
    }
    const failedActions = await tx.conversationPlanAction.updateMany({
      where: { id: action.id, status: "EXECUTING" },
      data: { status: "FAILED", failedAt },
    });
    if (failedActions.count !== 1) {
      throw new Error("V3 inline Action changed during failure closure.");
    }
    if (attempt.executionOutboxId) {
      const outboxClosed = await tx.outboxEvent.updateMany({
        where: {
          id: attempt.executionOutboxId,
          eventType: "action.execution.requested",
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: failedAt,
          lastError: reasonCode,
        },
      });
      if (outboxClosed.count !== 1) {
        throw new Error("V3 inline execution Outbox changed during failure closure.");
      }
    }
    const otherActiveAttempts = await tx.toolExecution.count({
      where: {
        planAction: { turnPlanId: plan.id },
        id: { not: attempt.id },
        status: { in: ["QUEUED", "RUNNING"] },
      },
    });
    let failedPlan = { count: 0 };
    let failedMemoryRuns = { count: 0 };
    if (otherActiveAttempts === 0) {
      await tx.conversationPlanAction.updateMany({
        where: {
          turnPlanId: plan.id,
          id: { not: action.id },
          status: {
            in: ["PLANNED", "AUTHORIZING", "WAITING_APPROVAL", "READY", "QUEUED"],
          },
        },
        data: { status: "CANCELED", completedAt: failedAt },
      });
      failedPlan = await tx.conversationTurnPlan.updateMany({
        where: {
          id: plan.id,
          status: { in: ["PROPOSED", "VALIDATED", "EXECUTING"] },
        },
        data: {
          status: "FAILED",
          failedAt,
          validationResult: {
            ok: false,
            reason: reasonCode,
            failedActionId: action.id,
            failedAt: failedAt.toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
      failedMemoryRuns = plan.generationRunId
        ? await tx.memoryUseRun.updateMany({
          where: {
            generationRunId: plan.generationRunId,
            status: "STARTED",
          },
          data: {
            status: "FAILED",
            reasonCode: "memory_generation_failed",
            completedAt: failedAt,
          },
        })
        : { count: 0 };
    }

    return {
      attemptsClosed: closedAttempts.count,
      actionsFailed: failedActions.count,
      planFailed: failedPlan.count === 1,
      memoryRunsFailed: failedMemoryRuns.count,
      reconciliationRequired: false,
    };
  });
}

export async function failActiveV3InlinePlanExecution(input: {
  planId: string;
  generationWorkLease: { outboxId: string; leaseAttempt: number };
  reasonCode: string;
}) {
  const leasePrefix = `inline:${input.generationWorkLease.outboxId}:${input.generationWorkLease.leaseAttempt}:`;
  const active = await prisma.toolExecution.findMany({
    where: {
      planAction: { turnPlanId: input.planId },
      status: "RUNNING",
      executionLeaseToken: { startsWith: leasePrefix },
      capability: { in: ["BUILTIN", "KNOWLEDGE"] },
    },
    select: { id: true, executionLeaseToken: true },
    take: 2,
  });
  if (!active.length) return null;
  if (active.length !== 1 || !active[0]!.executionLeaseToken) {
    throw new Error("V3 inline failure closure found an ambiguous active attempt.");
  }
  return failV3InlinePlanExecution({
    executionAttemptId: active[0]!.id,
    expectedExecutionLeaseToken: active[0]!.executionLeaseToken,
    reasonCode: input.reasonCode,
  });
}

function stripHash(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

async function assertInlineGenerationWorkLease(
  tx: Prisma.TransactionClient,
  plan: { generationRunId: string | null; delegationTaskId: string | null },
  lease: { outboxId: string; leaseAttempt: number },
) {
  if (!plan.generationRunId || !Number.isSafeInteger(lease.leaseAttempt)) {
    throw new Error("V3 inline action is missing its Generation work lease.");
  }
  const outbox = await tx.outboxEvent.findUnique({
    where: { id: lease.outboxId },
    select: {
      aggregateType: true,
      aggregateId: true,
      eventType: true,
      status: true,
      attemptCount: true,
      availableAt: true,
    },
  });
  if (
    !outbox
    || outbox.aggregateType !== "generation_run"
    || outbox.eventType !== "generation.requested"
    || outbox.status !== "PROCESSING"
    || outbox.attemptCount !== lease.leaseAttempt
    || outbox.availableAt <= new Date()
  ) {
    throw new Error("V3 inline action lost its Generation work lease.");
  }
  if (outbox.aggregateId === plan.generationRunId) return;
  const continuation = plan.delegationTaskId
    ? await tx.generationRun.findUnique({
        where: { id: outbox.aggregateId },
        select: {
          delegationTaskId: true,
          status: true,
        },
      })
    : null;
  if (!isV3InlineGenerationLeaseOwner({
    planGenerationRunId: plan.generationRunId,
    planDelegationTaskId: plan.delegationTaskId,
    outboxGenerationRunId: outbox.aggregateId,
    continuation,
  })) {
    throw new Error("V3 inline action lost its Generation work lease.");
  }
}

export function isV3InlineGenerationLeaseOwner(input: {
  planGenerationRunId: string;
  planDelegationTaskId: string | null;
  outboxGenerationRunId: string;
  continuation: {
    delegationTaskId: string | null;
    status: string;
  } | null;
}) {
  if (input.outboxGenerationRunId === input.planGenerationRunId) return true;
  return Boolean(
    input.planDelegationTaskId
    && input.continuation
    && input.continuation.delegationTaskId === input.planDelegationTaskId
    && input.continuation.status === "PROCESSING",
  );
}

function inlineExecutionLeasePrefix(
  lease: { outboxId: string; leaseAttempt: number },
  actionId: string,
) {
  return `inline:${lease.outboxId}:${lease.leaseAttempt}:${actionId}:`;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asSuccessContract(value: unknown): SuccessContractV3 | undefined {
  const record = asJsonRecord(value);
  return record && typeof record["kind"] === "string"
    ? record as SuccessContractV3
    : undefined;
}

async function assertInlineActionDependenciesAndActivation(
  tx: Prisma.TransactionClient,
  action: {
    dependsOnActionIds: string[];
    dependencyPolicy: Prisma.JsonValue | null;
    activationPolicy: Prisma.JsonValue | null;
  },
) {
  const policies = Array.isArray(action.dependencyPolicy)
    ? action.dependencyPolicy.filter((item): item is Prisma.JsonObject =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const dependencyIds = [...new Set([
    ...(action.dependsOnActionIds ?? []),
    ...policies.flatMap((policy) =>
      typeof policy["actionId"] === "string" ? [policy["actionId"]] : []),
  ])];
  if (dependencyIds.length) {
    const dependencies = await tx.conversationPlanAction.findMany({
      where: { id: { in: dependencyIds } },
      include: { actionResults: { orderBy: { verifiedAt: "desc" }, take: 1 } },
    });
    const byId = new Map(dependencies.map((dependency) => [dependency.id, dependency]));
    for (const dependencyId of dependencyIds) {
      const dependency = byId.get(dependencyId);
      const policy = policies.find((candidate) =>
        candidate["actionId"] === dependencyId);
      const allowed = Array.isArray(policy?.["allowedStatuses"])
        ? policy!["allowedStatuses"] as unknown[]
        : ["succeeded"];
      const status = dependency ? mapInlineDependencyStatus(dependency.status) : null;
      if (!status || !allowed.includes(status)) {
        throw new Error("V3 inline action dependency is not satisfied.");
      }
    }
  }
  const activation = asJsonRecord(action.activationPolicy);
  if (activation?.["mode"] === "on_failure") {
    throw new Error("V3 inline fallback actions require a governed activation executor.");
  }
}

function mapInlineDependencyStatus(status: string) {
  switch (status) {
    case "SUCCEEDED": return "succeeded";
    case "SKIPPED": return "skipped";
    case "FAILED": return "failed";
    case "CANCELED": return "canceled";
    case "RECONCILIATION_REQUIRED": return "reconciliation_required";
    default: return null;
  }
}
