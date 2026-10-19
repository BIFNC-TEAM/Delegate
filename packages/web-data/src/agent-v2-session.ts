import { z } from "zod";
import { MessageSenderType } from "@prisma/client";
import { prisma } from "./prisma";

// Stored in the existing generation trace, never raw retrieval/tool transcripts.
export const v2TaskRecordSchema = z.object({
  version: z.literal(1), taskId: z.string().max(191), scope: z.string().max(64),
  status: z.enum(["waiting_user", "completed", "partial", "failed", "cancelled"]),
  inputMessageIds: z.array(z.string().max(191)).max(32),
  attemptedWrites: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  usage: z.object({ modelTurns: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(), tokens: z.number().nonnegative(), inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(), costUsd: z.number().nonnegative(), activeMs: z.number().nonnegative() }),
}).strict();
export type V2TaskRecord = z.infer<typeof v2TaskRecordSchema>;

/** Same episode, representative version, memory policy and deletion fences as recent context. */
export async function loadGenerationV2Task(input: { conversationId: string; representativeId: string; representativeVersionId: string | null; beforeMessageId: string; scope: string }) {
  const [before, policy] = await Promise.all([
    prisma.message.findFirst({ where: { id: input.beforeMessageId, conversationId: input.conversationId, redactedAt: null }, select: { createdAt: true, episodeId: true } }),
    prisma.representativeMemoryPolicy.findUnique({ where: { representativeId: input.representativeId }, select: { shortTermMemoryEnabled: true } }),
  ]);
  if (!before?.episodeId || policy?.shortTermMemoryEnabled === false) return null;
  const previous = await prisma.generationRun.findFirst({ where: { conversationId: input.conversationId, episodeId: before.episodeId,
    representativeVersionId: input.representativeVersionId, createdAt: { lt: before.createdAt } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { contextSnapshot: true } });
  const snapshot = previous?.contextSnapshot as { agentTrace?: { v2Task?: unknown } } | null;
  const parsed = v2TaskRecordSchema.safeParse(snapshot?.agentTrace?.v2Task);
  if (!parsed.success || parsed.data.scope !== input.scope || parsed.data.status !== "waiting_user") return null;
  const record = parsed.data;
  const messages = await prisma.message.findMany({ where: { id: { in: record.inputMessageIds }, conversationId: input.conversationId,
    episodeId: before.episodeId, senderType: MessageSenderType.AUDIENCE, redactedAt: null, text: { not: null } },
    select: { id: true, text: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (messages.length !== record.inputMessageIds.length) return null;
  return { record, messages };
}
