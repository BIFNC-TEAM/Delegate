import {
  stableSha256,
  normalizeEvidenceBindings,
  verifyRawActionResult,
  type SuccessContractV3,
  type TransportOutcomeV3,
} from "@delegate/runtime";
import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { SessionError } from "./session-error";

export async function persistVerifiedActionResult(input: {
  executionAttemptId: string;
  transportOutcome: TransportOutcomeV3;
  rawOutput?: unknown;
  expectedOutputSchema?: Record<string, unknown>;
  successContract?: SuccessContractV3;
  artifactRefs?: string[];
  evidenceBindings?: Array<Record<string, unknown>>;
  usageRecordIds?: string[];
  billingUnitIds?: string[];
}) {
  const attempt = await prisma.toolExecution.findUnique({
    where: { id: input.executionAttemptId },
    include: { planAction: { include: { turnPlan: true } } },
  });
  if (!attempt?.planAction || attempt.planRevision === null || attempt.executionEpoch === null) {
    throw new SessionError(409, "execution_attempt_plan_context_missing");
  }
  const initialAction = attempt.planAction;
  const initialPlan = initialAction.turnPlan;
  if (
    initialPlan.revision !== attempt.planRevision
    || initialPlan.executionEpoch !== attempt.executionEpoch
  ) {
    throw new SessionError(409, "execution_attempt_plan_fence_lost");
  }
  const storedOutputSchema = asJsonRecord(initialAction.expectedOutputSchema);
  if (!storedOutputSchema) {
    throw new SessionError(409, "action_output_schema_missing");
  }
  if (
    input.expectedOutputSchema
    && stableSha256(input.expectedOutputSchema) !== stableSha256(storedOutputSchema)
  ) {
    throw new SessionError(409, "action_output_schema_changed");
  }
  const storedSuccessContract = asSuccessContract(
    initialAction.successContract,
  );
  if (
    input.successContract
    && stableSha256(input.successContract) !== stableSha256(storedSuccessContract)
  ) {
    throw new SessionError(409, "action_success_contract_changed");
  }
  const verified = verifyRawActionResult({
    transportOutcome: input.transportOutcome,
    rawOutput: input.rawOutput,
    expectedOutputSchema: storedOutputSchema,
    ...(storedSuccessContract ? { successContract: storedSuccessContract } : {}),
  });
  const outputHash = typeof verified.sanitizedOutput === "undefined"
    ? null
    : stripHash(stableSha256(verified.sanitizedOutput));
  const now = new Date();
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
        actionResult: true,
        planAction: {
          include: {
            turnPlan: { include: { activeExecutionFence: true } },
          },
        },
      },
    });
    if (current?.actionResult) return current.actionResult;
    if (!current?.planAction) {
      throw new SessionError(409, "execution_attempt_plan_fence_lost");
    }
    const currentAction = current.planAction;
    const currentPlan = currentAction.turnPlan;
    const currentFence = currentPlan.activeExecutionFence;
    const activeResult = Boolean(
      currentFence
      && currentFence.activePlanId === currentPlan.id
      && currentFence.activeRevision === currentPlan.revision
      && currentFence.executionEpoch === currentPlan.executionEpoch
      && ["VALIDATED", "EXECUTING"].includes(currentPlan.status),
    );
    const supersededAuditResult = currentPlan.status === "SUPERSEDED"
      && ["CALL_STARTED", "RESPONSE_RECEIVED", "VERIFYING", "OUTCOME_UNKNOWN"]
        .includes(current.attemptPhase ?? "");
    if (
      current.planRevision !== attempt.planRevision
      || current.executionEpoch !== attempt.executionEpoch
      || currentPlan.protocolVersion !== 3
      || currentPlan.shadowMode
      || currentPlan.revision !== current.planRevision
      || currentPlan.executionEpoch !== current.executionEpoch
      || (!activeResult && !supersededAuditResult)
      || stableSha256(currentAction.expectedOutputSchema)
        !== stableSha256(storedOutputSchema)
      || stableSha256(currentAction.successContract)
        !== stableSha256(initialAction.successContract)
    ) {
      throw new SessionError(409, "execution_attempt_plan_fence_lost");
    }
    const result = await tx.actionResult.upsert({
      where: { executionAttemptId: input.executionAttemptId },
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
        outputHash,
        securityFindings: verified.securityFindings as unknown as Prisma.InputJsonValue,
        evidenceBindings: normalizeEvidenceBindings(
          input.evidenceBindings ?? [],
        ) as Prisma.InputJsonValue,
        artifactRefs: [...new Set(input.artifactRefs ?? [])],
        externalEffectId: current.externalEffectId,
        usageRecordIds: [...new Set(input.usageRecordIds ?? [])],
        billingUnitIds: [...new Set(input.billingUnitIds ?? [])],
        failure: verified.failureCode
          ? { code: verified.failureCode } as Prisma.InputJsonObject
          : Prisma.JsonNull,
        verifiedAt: now,
      },
      update: {},
    });
    const actionStatus = verified.semanticOutcome === "succeeded"
      ? "SUCCEEDED" as const
      : verified.transportOutcome === "outcome_unknown"
        || verified.semanticOutcome === "unknown"
        ? "RECONCILIATION_REQUIRED" as const
        : "FAILED" as const;
    await tx.toolExecution.update({
      where: { id: current.id },
      data: {
        attemptPhase: verified.transportOutcome === "outcome_unknown"
          ? "OUTCOME_UNKNOWN"
          : "FINISHED",
        transportOutcome: verified.transportOutcome,
        semanticOutcome: verified.semanticOutcome,
        responseSnapshot: typeof verified.sanitizedOutput === "undefined"
          ? Prisma.JsonNull
          : verified.sanitizedOutput as Prisma.InputJsonValue,
        status: actionStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        finishedAt: now,
        executionLeaseToken: null,
      },
    });
    await tx.conversationPlanAction.update({
      where: { id: currentAction.id },
      data: {
        status: actionStatus,
        expectedOutput: typeof verified.sanitizedOutput === "undefined"
          ? Prisma.JsonNull
          : verified.sanitizedOutput as Prisma.InputJsonValue,
        completedAt: actionStatus === "SUCCEEDED" ? now : null,
        failedAt: actionStatus === "FAILED" ? now : null,
      },
    });
    if (current.executionOutboxId) {
      await tx.outboxEvent.updateMany({
        where: {
          id: current.executionOutboxId,
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: null,
        },
      });
    }
    if (current.externalEffectId) {
      await tx.delegationTaskExternalEffect.updateMany({
        where: { id: current.externalEffectId },
        data: {
          status: actionStatus === "SUCCEEDED"
            ? "SUCCEEDED"
            : actionStatus === "FAILED"
              ? "FAILED"
              : "RECONCILIATION_REQUIRED",
          failureReason: verified.failureCode ?? null,
          executedAt: now,
          ...(actionStatus === "RECONCILIATION_REQUIRED"
            ? {}
            : { reconciledAt: now }),
        },
      });
    }
    return result;
  });
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asSuccessContract(value: unknown): SuccessContractV3 | undefined {
  const record = asJsonRecord(value);
  if (!record || typeof record["kind"] !== "string") return undefined;
  return record as SuccessContractV3;
}

function stripHash(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
