import type { Prisma } from "@prisma/client";
import {
  recordConversationPlanActionAuthorizationInTransaction,
} from "@delegate/web-data";
import {
  capabilityEffectV3Schema,
  isEffectWithinApprovalCeiling,
} from "@delegate/runtime";

import { SessionError } from "./session-error";

export type DelegatedGenerationWorkLease = {
  outboxId: string;
  leaseAttempt: number;
};

export async function lockAndFenceDelegatedGenerationWork(
  tx: Prisma.TransactionClient,
  input: DelegatedGenerationWorkLease & {
    conversationId: string;
    generationRunId: string;
    delegationTaskId: string;
  },
) {
  assertGenerationWorkLease(input);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
  `;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${input.generationRunId}))
  `;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${input.delegationTaskId}))
  `;
  const fenced = await tx.$executeRaw`
    UPDATE "OutboxEvent"
    SET "status" = "status"
    WHERE "id" = ${input.outboxId}
      AND "aggregateType" = 'generation_run'
      AND "aggregateId" = ${input.generationRunId}
      AND "eventType" = 'generation.requested'
      AND "status" = 'PROCESSING'
      AND "attemptCount" = ${input.leaseAttempt}
      AND "availableAt" > clock_timestamp()
  `;
  if (fenced !== 1) {
    throw new SessionError(409, "generation_work_lease_lost");
  }
}

export async function claimDelegatedGenerationExecution(
  tx: Prisma.TransactionClient,
  input: DelegatedGenerationWorkLease & {
    sessionId: string;
    conversationId: string;
    generationRunId: string;
    delegationTaskId: string;
    delegationTaskStepId: string;
    requestPayloadHash: string;
    authorization?: {
      decision: "allow" | "ask" | "deny";
      reason: string;
      policyVersion?: string;
    };
    execution: Omit<
      Prisma.ToolExecutionUncheckedCreateInput,
      | "sessionId"
      | "generationOutboxId"
      | "generationLeaseAttempt"
      | "requestPayloadHash"
      | "responseSnapshot"
    >;
  },
) {
  await lockAndFenceDelegatedGenerationWork(tx, input);

  const session = await tx.computeSession.findUnique({
    where: { id: input.sessionId },
    select: {
      id: true,
      conversationId: true,
      generationRunId: true,
      generationOutboxId: true,
      delegationTaskId: true,
      delegationTaskStepId: true,
    },
  });
  if (
    !session
    || session.conversationId !== input.conversationId
    || session.generationRunId !== input.generationRunId
    || session.generationOutboxId !== input.outboxId
    || session.delegationTaskId !== input.delegationTaskId
    || session.delegationTaskStepId !== input.delegationTaskStepId
  ) {
    throw new SessionError(409, "generation_execution_context_mismatch");
  }

  const [run, task, conversation] = await Promise.all([
    tx.generationRun.findUnique({
      where: { id: input.generationRunId },
      select: {
        status: true,
        delegationTaskId: true,
        delegationTaskStepId: true,
      },
    }),
    tx.delegationTask.findUnique({
      where: { id: input.delegationTaskId },
      select: {
        status: true,
        steps: {
          where: { id: input.delegationTaskStepId },
          select: { id: true, status: true },
          take: 1,
        },
      },
    }),
    tx.conversation.findUnique({
      where: { id: input.conversationId },
      select: { state: true },
    }),
  ]);
  if (
    run?.status !== "PROCESSING"
    || run.delegationTaskId !== input.delegationTaskId
    || run.delegationTaskStepId !== input.delegationTaskStepId
    || !task
    || !["READY", "QUEUED", "RUNNING"].includes(task.status)
    || !["READY", "QUEUED", "RUNNING"].includes(task.steps[0]?.status ?? "")
    || conversation?.state === "HUMAN_ACTIVE"
    || conversation?.state === "NEEDS_HUMAN"
  ) {
    throw new SessionError(409, "generation_execution_context_mismatch");
  }

  let existing = await tx.toolExecution.findUnique({
    where: { generationOutboxId: input.outboxId },
  });
  if (!existing) {
    const legacyExecution = await tx.toolExecution.findFirst({
      where: {
        sessionId: input.sessionId,
        generationOutboxId: null,
      },
      orderBy: { createdAt: "asc" },
    });
    if (legacyExecution) {
      existing = await tx.toolExecution.update({
        where: { id: legacyExecution.id },
        data: {
          generationOutboxId: input.outboxId,
          generationLeaseAttempt: input.leaseAttempt,
          requestPayloadHash:
            legacyExecution.requestPayloadHash ?? input.requestPayloadHash,
        },
      });
    }
  }

  if (existing) {
    if (
      existing.sessionId !== input.sessionId
      || (
        existing.requestPayloadHash
        && existing.requestPayloadHash !== input.requestPayloadHash
      )
    ) {
      throw new SessionError(409, "generation_execution_request_mismatch");
    }
    const execution = existing.generationLeaseAttempt === input.leaseAttempt
      && existing.requestPayloadHash
      ? existing
      : await tx.toolExecution.update({
          where: { id: existing.id },
          data: {
            generationLeaseAttempt: input.leaseAttempt,
            requestPayloadHash: input.requestPayloadHash,
          },
        });
    return { claimed: false as const, execution };
  }

  const v3Admission = input.authorization
    ? await prepareV3DelegatedActionAdmission(tx, {
        delegationTaskId: input.delegationTaskId,
        delegationTaskStepId: input.delegationTaskStepId,
        generationRunId: input.generationRunId,
        sessionId: input.sessionId,
        requestPayloadHash: input.requestPayloadHash,
        decision: input.authorization.decision,
        reason: input.authorization.reason,
        ...(input.authorization.policyVersion
          ? { policyVersion: input.authorization.policyVersion }
          : {}),
        hasExecutionLease: Boolean(input.execution.executionLeaseToken),
      })
    : null;

  const execution = await tx.toolExecution.create({
    data: {
      ...input.execution,
      ...(v3Admission?.executionData ?? {}),
      sessionId: input.sessionId,
      generationOutboxId: input.outboxId,
      generationLeaseAttempt: input.leaseAttempt,
      requestPayloadHash: input.requestPayloadHash,
    },
  });
  return { claimed: true as const, execution };
}

/**
 * Converts an approved, policy-revalidated V3 ActionIntent into an atomic
 * execution admission. The approval itself never revives an old lease; the
 * caller must first bind the ToolExecution to a fresh ComputeSession.
 */
export async function admitApprovedV3ActionExecutionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    executionId: string;
    approvalId: string;
    executionLeaseToken: string;
    decisionReason: string;
    policyVersion: string;
  },
) {
  const execution = await tx.toolExecution.findUnique({
    where: { id: input.executionId },
    include: {
      planAction: {
        include: {
          turnPlan: { include: { activeExecutionFence: true } },
          externalEffects: true,
        },
      },
    },
  });
  if (!execution?.planAction) return false;
  const approval = await tx.approvalRequest.findUnique({
    where: { id: input.approvalId },
  });
  const action = execution.planAction;
  const plan = action.turnPlan;
  const fence = plan.activeExecutionFence;
  const requestedEffect = readEffect(action.inputSnapshot);
  const approvedEffect = readEffectValue(approval?.maximumApprovedEffect);
  if (
    execution.status !== "RUNNING"
    || execution.executionLeaseToken !== input.executionLeaseToken
    || execution.approvalRequestId !== input.approvalId
    || approval?.status !== "APPROVED"
    || approval.toolExecutionId !== execution.id
    || action.status !== "WAITING_APPROVAL"
    || !fence
    || fence.activePlanId !== plan.id
    || fence.activeRevision !== plan.revision
    || fence.executionEpoch !== plan.executionEpoch
    || execution.planRevision !== plan.revision
    || execution.executionEpoch !== plan.executionEpoch
    || !requestedEffect
    || !approvedEffect
    || !isEffectWithinApprovalCeiling(requestedEffect, approvedEffect)
  ) {
    throw new SessionError(409, "approved_plan_action_fence_lost");
  }
  await assertPlanActionDependenciesAndActivation(tx, action);
  await recordConversationPlanActionAuthorizationInTransaction(tx, {
    planActionId: action.id,
    phase: "post_approval",
    decision: "allow",
    reason: "The immutable ActionIntent was approved by its authorized Owner.",
    policyVersion: input.policyVersion,
    policySnapshot: {
      source: "approval_intent",
      approvalId: input.approvalId,
      requestPayloadHash: execution.requestPayloadHash,
    },
  });
  await recordConversationPlanActionAuthorizationInTransaction(tx, {
    planActionId: action.id,
    phase: "pre_execution",
    decision: "allow",
    reason: input.decisionReason,
    policyVersion: input.policyVersion,
    policySnapshot: {
      source: "compute_broker_pre_execution",
      approvalId: input.approvalId,
      requestPayloadHash: execution.requestPayloadHash,
    },
  });
  const attemptNumber = execution.attemptNumber ?? 1;
  const outbox = execution.executionOutboxId
    ? await tx.outboxEvent.findUniqueOrThrow({
        where: { id: execution.executionOutboxId },
      })
    : await tx.outboxEvent.create({
        data: {
          conversationId: plan.conversationId,
          aggregateType: "action_execution_attempt",
          aggregateId: action.id,
          eventType: "action.execution.requested",
          payload: {
            planId: plan.id,
            planRevision: plan.revision,
            executionEpoch: plan.executionEpoch,
            actionId: action.id,
            attemptNumber,
            sessionId: execution.sessionId,
            approvalId: input.approvalId,
          },
          idempotencyKey:
            `action.execution.requested:${plan.id}:${plan.executionEpoch}:${action.id}:${attemptNumber}`,
        },
      });
  const effect = action.externalEffects.length === 1
    ? action.externalEffects[0]!
    : null;
  if (action.capabilityKey.startsWith("mcp.") && !effect) {
    throw new SessionError(409, "external_effect_admission_required");
  }
  if (action.externalEffects.length > 1) {
    throw new SessionError(409, "external_effect_coordinate_ambiguous");
  }
  await tx.toolExecution.update({
    where: { id: execution.id },
    data: {
      executionOutboxId: outbox.id,
      attemptPhase: "CALL_PREPARED",
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
      externalEffectId: effect?.id ?? null,
    },
  });
  await tx.conversationPlanAction.update({
    where: { id: action.id },
    data: {
      status: "EXECUTING",
      attemptCount: attemptNumber,
      startedAt: execution.startedAt ?? new Date(),
    },
  });
  await tx.conversationTurnPlan.updateMany({
    where: { id: plan.id, status: "VALIDATED" },
    data: { status: "EXECUTING", startedAt: new Date() },
  });
  if (effect) {
    await tx.delegationTaskExternalEffect.update({
      where: { id: effect.id },
      data: {
        status: "APPROVED",
        approvalRequestId: input.approvalId,
        approvedAt: approval.resolvedAt ?? new Date(),
        failureReason: null,
      },
    });
  }
  return true;
}

function readEffect(inputSnapshot: unknown) {
  if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot)) {
    return null;
  }
  return readEffectValue((inputSnapshot as Record<string, unknown>)["effect"]);
}

function readEffectValue(value: unknown) {
  const parsed = capabilityEffectV3Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function prepareV3DelegatedActionAdmission(
  tx: Prisma.TransactionClient,
  input: {
    delegationTaskId: string;
    delegationTaskStepId: string;
    generationRunId: string;
    sessionId: string;
    requestPayloadHash: string;
    decision: "allow" | "ask" | "deny";
    reason: string;
    policyVersion?: string;
    hasExecutionLease: boolean;
  },
) {
  const candidates = await tx.conversationPlanAction.findMany({
    where: {
      delegationTaskId: input.delegationTaskId,
      delegationTaskStepId: input.delegationTaskStepId,
      turnPlan: { protocolVersion: 3, shadowMode: false },
    },
    include: {
      turnPlan: { include: { activeExecutionFence: true } },
      externalEffects: true,
    },
    take: 2,
  });
  if (!candidates.length) return null;
  if (candidates.length !== 1) {
    throw new SessionError(409, "plan_action_delegation_coordinate_ambiguous");
  }
  const action = candidates[0]!;
  const plan = action.turnPlan;
  const fence = plan.activeExecutionFence;
  if (
    plan.generationRunId !== input.generationRunId
    || !fence
    || fence.activePlanId !== plan.id
    || fence.activeRevision !== plan.revision
    || fence.executionEpoch !== plan.executionEpoch
    || !["PLANNED", "AUTHORIZING", "WAITING_APPROVAL", "READY"].includes(action.status)
  ) {
    throw new SessionError(409, "plan_execution_fence_lost");
  }
  await assertPlanActionDependenciesAndActivation(tx, action);

  if (!action.authorizationPhase) {
    await recordConversationPlanActionAuthorizationInTransaction(tx, {
      planActionId: action.id,
      phase: "initial",
      decision: input.decision,
      reason: input.reason,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      policySnapshot: {
        source: "compute_broker_policy",
        requestPayloadHash: input.requestPayloadHash,
      },
    });
  }
  if (input.decision === "allow") {
    await recordConversationPlanActionAuthorizationInTransaction(tx, {
      planActionId: action.id,
      phase: "pre_execution",
      decision: "allow",
      reason: input.reason,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      policySnapshot: {
        source: "compute_broker_pre_execution",
        requestPayloadHash: input.requestPayloadHash,
      },
    });
  }

  const latestAttempt = await tx.toolExecution.findFirst({
    where: { planActionId: action.id },
    orderBy: { attemptNumber: "desc" },
    select: { attemptNumber: true },
  });
  const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
  const externalEffect = action.externalEffects.length === 1
    ? action.externalEffects[0]!
    : null;
  if (action.capabilityKey.startsWith("mcp.") && !externalEffect) {
    throw new SessionError(409, "external_effect_admission_required");
  }
  if (action.externalEffects.length > 1) {
    throw new SessionError(409, "external_effect_coordinate_ambiguous");
  }

  let executionOutboxId: string | null = null;
  if (input.decision === "allow") {
    if (!input.hasExecutionLease) {
      throw new SessionError(409, "compute_execution_claim_missing");
    }
    const outbox = await tx.outboxEvent.create({
      data: {
        conversationId: plan.conversationId,
        aggregateType: "action_execution_attempt",
        aggregateId: action.id,
        eventType: "action.execution.requested",
        payload: {
          planId: plan.id,
          planRevision: plan.revision,
          executionEpoch: plan.executionEpoch,
          actionId: action.id,
          attemptNumber,
          sessionId: input.sessionId,
        },
        idempotencyKey:
          `action.execution.requested:${plan.id}:${plan.executionEpoch}:${action.id}:${attemptNumber}`,
      },
    });
    executionOutboxId = outbox.id;
    await tx.conversationPlanAction.update({
      where: { id: action.id },
      data: {
        status: "EXECUTING",
        attemptCount: attemptNumber,
        startedAt: new Date(),
      },
    });
    await tx.conversationTurnPlan.updateMany({
      where: { id: plan.id, status: "VALIDATED" },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    if (externalEffect) {
      await tx.delegationTaskExternalEffect.update({
        where: { id: externalEffect.id },
        data: { status: "APPROVED", failureReason: null },
      });
    }
  }

  return {
    executionData: {
      planActionId: action.id,
      planRevision: plan.revision,
      executionEpoch: plan.executionEpoch,
      attemptNumber,
      attemptPhase: input.decision === "allow" ? "CALL_PREPARED" as const : "CREATED" as const,
      executionOutboxId,
      externalEffectId: externalEffect?.id ?? null,
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
    },
  };
}

async function assertPlanActionDependenciesAndActivation(
  tx: Prisma.TransactionClient,
  action: {
    id: string;
    turnPlanId: string;
    dependsOnActionIds: string[];
    dependencyPolicy: unknown;
    activationPolicy: unknown;
  },
) {
  const dependencyPolicy = Array.isArray(action.dependencyPolicy)
    ? action.dependencyPolicy.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const dependencyIds = [...new Set([
    ...(action.dependsOnActionIds ?? []),
    ...dependencyPolicy.flatMap((dependency) =>
      typeof dependency["actionId"] === "string" ? [dependency["actionId"]] : []),
  ])];
  const dependencies = dependencyIds.length
    ? await tx.conversationPlanAction.findMany({
        where: { id: { in: dependencyIds } },
        include: { actionResults: { orderBy: { verifiedAt: "desc" }, take: 1 } },
      })
    : [];
  const dependencyById = new Map(
    dependencies.map((dependency) => [dependency.id, dependency]),
  );
  for (const dependencyId of dependencyIds) {
    const dependency = dependencyById.get(dependencyId);
    const policy = dependencyPolicy.find((item) =>
      item["actionId"] === dependencyId);
    const allowedStatuses = Array.isArray(policy?.["allowedStatuses"])
      ? policy!["allowedStatuses"] as unknown[]
      : ["succeeded"];
    const runtimeStatus = dependency
      ? mapPlanActionStatus(dependency.status)
      : null;
    if (!runtimeStatus || !allowedStatuses.includes(runtimeStatus)) {
      throw new SessionError(409, "plan_action_dependency_not_satisfied");
    }
    const allowedFailureCodes = Array.isArray(policy?.["allowedFailureCodes"])
      ? policy!["allowedFailureCodes"] as unknown[]
      : [];
    if (allowedFailureCodes.length && runtimeStatus === "failed") {
      const failure = asRecord(dependency?.actionResults[0]?.failure);
      if (!allowedFailureCodes.includes(failure?.["code"])) {
        throw new SessionError(
          409,
          "plan_action_dependency_failure_code_not_allowed",
        );
      }
    }
  }
  const activation = asRecord(action.activationPolicy);
  if (activation?.["mode"] === "on_failure") {
    const sourceActionId = activation["sourceActionId"];
    const source = typeof sourceActionId === "string"
      ? dependencyById.get(sourceActionId)
        ?? await tx.conversationPlanAction.findUnique({
          where: { id: sourceActionId },
          include: { actionResults: { orderBy: { verifiedAt: "desc" }, take: 1 } },
        })
      : null;
    const failure = asRecord(source?.actionResults[0]?.failure);
    const allowedCodes = Array.isArray(activation["allowedFailureCodes"])
      ? activation["allowedFailureCodes"] as unknown[]
      : [];
    if (
      !source
      || mapPlanActionStatus(source.status) !== "failed"
      || !allowedCodes.includes(failure?.["code"])
    ) {
      throw new SessionError(409, "plan_action_fallback_not_activated");
    }
    await assertFallbackGroupAdmissionInTransaction(tx, action);
  }
}

export async function assertFallbackGroupAdmissionInTransaction(
  tx: Prisma.TransactionClient,
  action: {
    id: string;
    turnPlanId: string;
    activationPolicy: unknown;
  },
) {
  const activation = asRecord(action.activationPolicy);
  if (activation?.["mode"] !== "on_failure") return;
  const sourceActionId = activation["sourceActionId"];
  const fallbackGroupKey = activation["fallbackGroupKey"];
  const priority = activation["priority"];
  if (
    typeof sourceActionId !== "string"
    || typeof fallbackGroupKey !== "string"
    || !Number.isSafeInteger(priority)
  ) {
    throw new SessionError(409, "plan_action_fallback_policy_invalid");
  }
  const currentPriority = priority as number;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`fallback:${action.turnPlanId}:${sourceActionId}:${fallbackGroupKey}`})
    )
  `;
  const siblings = await tx.conversationPlanAction.findMany({
    where: { turnPlanId: action.turnPlanId },
    select: { id: true, status: true, activationPolicy: true },
  });
  const group = siblings.flatMap((candidate) => {
    const candidateActivation = asRecord(candidate.activationPolicy);
    return candidateActivation?.["mode"] === "on_failure"
      && candidateActivation["sourceActionId"] === sourceActionId
      && candidateActivation["fallbackGroupKey"] === fallbackGroupKey
      && Number.isSafeInteger(candidateActivation["priority"])
      ? [{
          id: candidate.id,
          status: candidate.status,
          priority: candidateActivation["priority"] as number,
        }]
      : [];
  }).sort((left, right) => left.priority - right.priority);
  if (!group.some((candidate) => candidate.id === action.id)) {
    throw new SessionError(409, "plan_action_fallback_policy_drift");
  }
  if (new Set(group.map((candidate) => candidate.priority)).size !== group.length) {
    throw new SessionError(409, "plan_action_fallback_priority_ambiguous");
  }
  if (group.some((candidate) =>
    candidate.id !== action.id
    && [
      "QUEUED",
      "EXECUTING",
      "VERIFYING",
      "SUCCEEDED",
      "RECONCILIATION_REQUIRED",
    ].includes(candidate.status))) {
    throw new SessionError(409, "plan_action_fallback_group_already_claimed");
  }
  const earlier = group.filter((candidate) =>
    candidate.priority < currentPriority);
  if (earlier.some((candidate) =>
    !["FAILED", "CANCELED", "SKIPPED"].includes(candidate.status))) {
    throw new SessionError(409, "plan_action_fallback_higher_priority_pending");
  }
}

function mapPlanActionStatus(status: string) {
  switch (status) {
    case "SUCCEEDED": return "succeeded";
    case "SKIPPED": return "skipped";
    case "FAILED": return "failed";
    case "CANCELED": return "canceled";
    case "RECONCILIATION_REQUIRED": return "reconciliation_required";
    default: return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertGenerationWorkLease(
  input: Partial<DelegatedGenerationWorkLease>,
) {
  if (
    !input.outboxId
    || !Number.isSafeInteger(input.leaseAttempt)
    || (input.leaseAttempt ?? 0) < 1
  ) {
    throw new SessionError(409, "generation_work_lease_lost");
  }
}
