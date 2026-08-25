import {
  stableSha256,
  type CapabilityExecutionRequest,
  type ComputeExecutionRequest,
  type McpExecutionRequest,
} from "@delegate/runtime";
import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { assertFallbackGroupAdmissionInTransaction } from "./generation-work-fence";
import { SessionError } from "./session-error";

export async function enqueueActionExecutionAttempt(input: {
  sessionId: string;
  request: CapabilityExecutionRequest;
  expectedAuthorizationVersion: number;
  billingAdmission: {
    decision: "not_billable";
    reasonCode: "generation_run_owns_conversation_billing";
  };
  externalEffect?: {
    type: string;
    target: string;
    action: string;
  };
}) {
  const request = input.request;
  if (request.executor !== "compute" && request.executor !== "mcp") {
    throw new SessionError(409, "capability_executor_not_brokered");
  }
  if (
    input.billingAdmission.reasonCode
      !== "generation_run_owns_conversation_billing"
  ) {
    throw new SessionError(409, "v3_action_billing_admission_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${request.actionId}))
    `;
    const action = await tx.conversationPlanAction.findUnique({
      where: { id: request.actionId },
      include: {
        turnPlan: { include: { activeExecutionFence: true } },
      },
    });
    if (!action || action.turnPlan.id !== request.planId) {
      throw new SessionError(409, "plan_action_coordinate_mismatch");
    }
    const fence = action.turnPlan.activeExecutionFence;
    if (
      action.turnPlan.protocolVersion !== 3
      || action.turnPlan.shadowMode
      || !fence
      || fence.activePlanId !== action.turnPlan.id
      || fence.activeRevision !== request.planRevision
      || fence.executionEpoch !== request.executionEpoch
      || action.turnPlan.revision !== request.planRevision
      || action.turnPlan.executionEpoch !== request.executionEpoch
    ) {
      throw new SessionError(409, "plan_execution_fence_lost");
    }
    if (action.status !== "READY" && action.status !== "QUEUED") {
      throw new SessionError(409, "plan_action_not_ready");
    }
    if (
      action.authorizationPhase !== "PRE_EXECUTION"
      || action.effectiveDecision !== "ALLOW"
      || action.authorizationVersion !== input.expectedAuthorizationVersion
    ) {
      throw new SessionError(409, "pre_execution_authorization_required");
    }
    await assertFallbackGroupAdmissionInTransaction(tx, action);
    if (request.executor === "mcp" && !input.externalEffect) {
      throw new SessionError(409, "external_effect_admission_required");
    }
    if (input.externalEffect && !action.delegationTaskId) {
      throw new SessionError(409, "external_effect_delegation_task_required");
    }
    const existing = await tx.toolExecution.findFirst({
      where: {
        planActionId: action.id,
        executionEpoch: request.executionEpoch,
        status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] },
      },
      orderBy: { attemptNumber: "desc" },
    });
    if (existing) return existing;
    const latest = await tx.toolExecution.findFirst({
      where: { planActionId: action.id },
      orderBy: { attemptNumber: "desc" },
      select: { attemptNumber: true },
    });
    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const idempotencyKey =
      `action.execution.requested:${request.planId}:${request.executionEpoch}:${action.id}:${attemptNumber}`;
    const outbox = await tx.outboxEvent.create({
      data: {
        conversationId: action.turnPlan.conversationId,
        aggregateType: "action_execution_attempt",
        aggregateId: action.id,
        eventType: "action.execution.requested",
        payload: {
          planId: request.planId,
          planRevision: request.planRevision,
          executionEpoch: request.executionEpoch,
          actionId: action.id,
          attemptNumber,
          sessionId: input.sessionId,
        },
        idempotencyKey,
      },
    });
    const requestHash = stripHash(stableSha256(request));
    const externalEffect = input.externalEffect
      ? await tx.delegationTaskExternalEffect.upsert({
          where: { idempotencyKey: request.idempotencyKey },
          create: {
            delegationTaskId: action.delegationTaskId!,
            delegationTaskStepId: action.delegationTaskStepId,
            planActionId: action.id,
            type: input.externalEffect.type,
            target: input.externalEffect.target,
            action: input.externalEffect.action,
            status: "APPROVED",
            idempotencyKey: request.idempotencyKey,
            requestPayload: request as unknown as Prisma.InputJsonObject,
            approvedAt: new Date(),
          },
          update: {},
        })
      : null;
    const attempt = await tx.toolExecution.create({
      data: {
        sessionId: input.sessionId,
        planActionId: action.id,
        planRevision: request.planRevision,
        executionEpoch: request.executionEpoch,
        attemptNumber,
        attemptPhase: "CREATED",
        executionOutboxId: outbox.id,
        externalEffectId: externalEffect?.id ?? null,
        billingAdmission: input.billingAdmission as Prisma.InputJsonObject,
        capability: mapCapability(request),
        subagentId: request.executor === "compute"
          && request.capability === "browser"
            ? "browser-agent"
            : "compute-agent",
        mcpBindingId: request.executor === "mcp"
          ? request.bindingId
          : null,
        status: "QUEUED",
        requestPayload: request as unknown as Prisma.InputJsonObject,
        requestPayloadHash: requestHash,
        policyDecision: "ALLOW",
      },
    });
    await tx.conversationPlanAction.update({
      where: { id: action.id },
      data: { status: "QUEUED", attemptCount: attemptNumber },
    });
    await tx.conversationTurnPlan.updateMany({
      where: { id: action.turnPlan.id, status: "VALIDATED" },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    return attempt;
  });
}

function mapCapability(request: ComputeExecutionRequest | McpExecutionRequest) {
  if (request.executor === "mcp") return "MCP" as const;
  switch (request.capability) {
    case "exec": return "EXEC" as const;
    case "read": return "READ" as const;
    case "write": return "WRITE" as const;
    case "process": return "PROCESS" as const;
    case "browser": return "BROWSER" as const;
  }
}

function stripHash(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
