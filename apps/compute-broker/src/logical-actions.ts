import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { fenceGenerationWorkLease } from "@delegate/web-data";
import { prisma } from "./prisma";
import { SessionError } from "./session-error";

type Scope = { id: string; requestedBy: string; representativeId: string; conversationId: string | null; contactId: string | null; generationRunId: string | null };
export type ActionEffect = "read" | "write";
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function logicalActionId(representativeId: string, conversationId: string, originMessageId: string, ordinal: number) {
  return `pa_${createHash("sha256").update(JSON.stringify([representativeId, conversationId, originMessageId, ordinal])).digest("hex").slice(0, 48)}`;
}
export function logicalPayloadHash(value: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function assertUnresolved(tx: Prisma.TransactionClient, session: Scope, effect: ActionEffect, ownExecutionId?: string) {
  if (effect === "read" || !session.conversationId) return;
  const unresolved = await tx.toolExecution.findFirst({ where: {
    ...(ownExecutionId ? { id: { not: ownExecutionId } } : {}),
    session: { representativeId: session.representativeId, conversationId: session.conversationId, contactId: session.contactId, requestedBy: "AUDIENCE" },
    AND: [
      { OR: [{ status: "RUNNING" }, { transportOutcome: "outcome_unknown" }, { semanticOutcome: "unknown" }] },
      { OR: [{ actionIdentity: { path: ["effect"], equals: "write" } },
        // Unclassified legacy effects must not be made safe by changing run/tool.
        { actionIdentity: { equals: Prisma.DbNull }, capability: { in: ["EXEC", "WRITE", "PROCESS", "MCP"] } }] },
    ],
  }, select: { id: true } });
  if (unresolved) throw new SessionError(409, "logical_action_previous_unresolved");
}

/** Reserve once before any provider call. The conversation lock also prevents
 * two distinct writes from passing the unresolved-action check concurrently. */
export async function prepareLogicalAction(input: {
  session: Scope; action?: { version: 1; ordinal: number }; effect: ActionEffect;
  workLease?: { outboxId: string; leaseAttempt: number }; payloadHash: string;
  executionData: Prisma.ToolExecutionUncheckedCreateInput; needsApproval: boolean;
}) {
  if (input.session.requestedBy !== "AUDIENCE" || !input.session.generationRunId || !input.session.conversationId) {
    if (input.action) throw new SessionError(409, "logical_action_context_changed");
    return null;
  }
  return prisma.$transaction(async tx => {
    const scope = input.session;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${scope.conversationId} FOR UPDATE`;
    const run = await tx.generationRun.findUnique({ where: { id: scope.generationRunId! }, select: { inputMessageId: true, contextSnapshot: true, conversationId: true } });
    if (!run || run.conversationId !== scope.conversationId) throw new SessionError(409, "logical_action_context_changed");
    const snapshot = record(run.contextSnapshot);
    if (!input.action) {
      if (snapshot.piActionIdentityVersion === 1 || (snapshot.piExecutionProtocol && input.effect === "write")) throw new SessionError(409, "logical_action_identity_required");
      await assertUnresolved(tx, scope, input.effect); return null;
    }
    if (!input.workLease) throw new SessionError(409, "logical_action_context_changed");
    await fenceGenerationWorkLease(tx, { runId: scope.generationRunId!, ...input.workLease });
    const id = logicalActionId(scope.representativeId, scope.conversationId!, run.inputMessageId, input.action.ordinal);
    const previous = await tx.toolExecution.findUnique({ where: { id } });
    if (previous) {
      const identity = record(previous.actionIdentity);
      if (identity.originMessageId !== run.inputMessageId || identity.effect !== input.effect || identity.generationRunId !== scope.generationRunId) throw new SessionError(409, "logical_action_context_changed");
      if (previous.requestPayloadHash !== input.payloadHash) throw new SessionError(409, "logical_action_payload_changed");
      return { kind: "replay" as const, execution: previous };
    }
    // A new GenerationRun for the same input event is a recovery, not a new
    // instruction to submit additional effects under fresh action slots.
    const otherRun = await tx.toolExecution.findFirst({ where: { actionIdentity: { path: ["originMessageId"], equals: run.inputMessageId },
      session: { generationRunId: { not: scope.generationRunId! }, representativeId: scope.representativeId, conversationId: scope.conversationId } }, select: { id: true } });
    if (otherRun) throw new SessionError(409, "logical_action_origin_already_processed");
    const recorded = await tx.toolExecution.findMany({ where: { actionIdentity: { path: ["originMessageId"], equals: run.inputMessageId },
      session: { generationRunId: scope.generationRunId! } }, select: { id: true, approvalRequestId: true, actionIdentity: true } });
    const identities = recorded.map(row => ({ ...record(row.actionIdentity), executionId: row.id, approvalRequestId: row.approvalRequestId } as Record<string, unknown>));
    const latest = identities.sort((a, b) => Number(b.ordinal) - Number(a.ordinal))[0];
    if (latest) {
      const lastOrdinal = Number(latest.ordinal);
      // A changed replan cannot fill an earlier empty slot and thereby repeat
      // an already completed effect under a previously unused identifier.
      if (input.action.ordinal <= lastOrdinal) throw new SessionError(409, "logical_action_context_changed");
      const priorLease = record(latest.workLease);
      if (priorLease.outboxId !== input.workLease.outboxId || priorLease.leaseAttempt !== input.workLease.leaseAttempt) {
        const continuation = record(snapshot.piApprovalContinuation);
        const checkpoint = record(continuation.checkpoint);
        const frontier = Number(checkpoint.nextActionOrdinal);
        const approval = typeof continuation.approvalId === "string" ? await tx.approvalRequest.findUnique({ where: { id: continuation.approvalId },
          select: { status: true, generationRunId: true, toolExecutionId: true } }) : null;
        if (continuation.status !== "completed" || continuation.approvalId !== latest.approvalRequestId || approval?.status !== "APPROVED"
          || approval.generationRunId !== scope.generationRunId || approval.toolExecutionId !== latest.executionId
          || checkpoint.actionIdentityVersion !== 1 || !Number.isSafeInteger(frontier) || frontier !== lastOrdinal + 1 || input.action.ordinal < frontier) {
          throw new SessionError(409, "logical_action_recovery_checkpoint_required");
        }
      }
    }
    await assertUnresolved(tx, scope, input.effect);
    const token = input.needsApproval ? null : randomUUID();
    const execution = await tx.toolExecution.create({ data: { ...input.executionData, id, requestPayloadHash: input.payloadHash,
      status: input.needsApproval ? "BLOCKED" : "RUNNING", executionLeaseToken: token,
      startedAt: input.needsApproval ? null : new Date(),
      actionIdentity: { version: 1, originMessageId: run.inputMessageId, generationRunId: scope.generationRunId!, ordinal: input.action.ordinal,
        effect: input.effect, attemptId: randomUUID(), workLease: input.workLease },
    } });
    return { kind: "reserved" as const, execution, executionLeaseToken: token };
  });
}

/** Approval recovery must not bypass a newer unresolved write in this scope. */
export async function assertLogicalActionDispatch(session: Scope, effect: ActionEffect, executionId: string) {
  if (session.requestedBy !== "AUDIENCE" || !session.conversationId) return;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${session.conversationId} FOR UPDATE`;
    await assertUnresolved(tx, session, effect, executionId);
  });
}
