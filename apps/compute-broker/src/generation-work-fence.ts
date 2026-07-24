import type { Prisma } from "@prisma/client";

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

  const run = await tx.generationRun.findUnique({
    where: { id: input.generationRunId },
    select: {
      status: true,
      delegationTaskId: true,
      delegationTaskStepId: true,
    },
  });
  const task = await tx.delegationTask.findUnique({
    where: { id: input.delegationTaskId },
    select: {
      status: true,
      steps: {
        where: { id: input.delegationTaskStepId },
        select: { id: true, status: true },
        take: 1,
      },
    },
  });
  if (
    run?.status !== "PROCESSING"
    || run.delegationTaskId !== input.delegationTaskId
    || run.delegationTaskStepId !== input.delegationTaskStepId
    || !task
    || !["READY", "QUEUED", "RUNNING"].includes(task.status)
    || !["READY", "QUEUED", "RUNNING"].includes(task.steps[0]?.status ?? "")
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

  const execution = await tx.toolExecution.create({
    data: {
      ...input.execution,
      sessionId: input.sessionId,
      generationOutboxId: input.outboxId,
      generationLeaseAttempt: input.leaseAttempt,
      requestPayloadHash: input.requestPayloadHash,
    },
  });
  return { claimed: true as const, execution };
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
