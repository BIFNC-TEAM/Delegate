import { Prisma } from "@prisma/client";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import { citationHistoryScopeInTransaction, revalidateCitationHistoryAcquisitionInTransaction, type CitationHistoryScope } from "./agent-context-authorization";
import { citationFingerprint, parseCitationAcquisition, readCitationRangesInTransaction, type CitationAcquisition } from "./citation-persistence";
import { CITATION_HISTORY_UNAVAILABLE, derivedCitationHistorySchema, type CitationHistoryMessage, type DerivedCitationHistoryProof } from "./citation-history-types";
import { fenceGenerationWorkLease } from "./conversation-platform";
import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const reject = (): never => { throw new AgentContextAuthorizationError(); };
const alive = (message: { redactedAt: Date | null; retentionExpiresAt: Date | null }) => !message.redactedAt && (!message.retentionExpiresAt || message.retentionExpiresAt > new Date());

async function authorized(tx: Tx, scope: CitationHistoryScope, originRunId: string, acquisition: unknown, modelTime: number) {
  const parsed = parseCitationAcquisition(acquisition);
  if (!parsed) return false;
  try { await revalidateCitationHistoryAcquisitionInTransaction(tx, scope, originRunId, parsed, { modelTime }); return true; } catch { return false; }
}

async function projectAnswer(tx: Tx, scope: CitationHistoryScope, run: { id: string; contextSnapshot: unknown }, message: { id: string; text: string; content: unknown }, modelTime: number) {
  const content = object(message.content);
  if (content.citationProtocol === "reference-v1") {
    const ranges = await readCitationRangesInTransaction(tx, message.id, message.text);
    if (!ranges) return { text: CITATION_HISTORY_UNAVAILABLE, annotationHash: citationFingerprint(["corrupt", content.citationManifest]) };
    const expectedIdentity = citationFingerprint([scope.representativeId, scope.representativeVersionId, scope.conversationId, scope.contactId, scope.audienceIdentityId, scope.episodeId]);
    let text = message.text;
    for (const range of [...ranges].reverse()) {
      const checks = await Promise.all(range.sources.map(item => item.source.episodeId === scope.episodeId
        && item.source.representativeId === scope.representativeId && item.source.identityScopeHash === expectedIdentity
        ? authorized(tx, scope, run.id, item.acquisition, modelTime) : false));
      if (checks.some(value => !value)) text = text.slice(0, range.start) + CITATION_HISTORY_UNAVAILABLE + text.slice(range.end);
    }
    return { text, annotationHash: citationFingerprint(ranges) };
  }

  // Legacy records have no trustworthy sentence-level mapping. Only ledger
  // links and server-owned receipts count as dependencies; never match titles.
  const [citations, memory] = await Promise.all([
    tx.messageCitation.findMany({ where: { messageId: message.id }, include: { memoryUseItem: { select: { id: true, useRunId: true } } } }),
    tx.memoryUseRun.findUnique({ where: { generationRunId_conversationId: { generationRunId: run.id, conversationId: scope.conversationId } }, select: { id: true, injectedCount: true, citedCount: true, items: { where: { OR: [{ injectedAt: { not: null } }, { citedAt: { not: null } }] }, select: { id: true } } } }),
  ]);
  const context = object(object(run.contextSnapshot).agentContextAuthorization);
  const remote = Array.isArray(context.remote) ? context.remote : [];
  const dependencies: CitationAcquisition[] = [
    ...(memory?.items ?? []).map(item => ({ kind: "memory" as const, useRunId: memory!.id, itemId: item.id })),
    ...remote.flatMap(item => { const parsed = parseCitationAcquisition({ kind: "remote", ...object(item) }); return parsed ? [parsed] : []; }),
  ];
  const missing = citations.some(citation => !citation.memoryUseItem) || (memory?.injectedCount ?? 0) > (memory?.items.length ?? 0)
    || remote.length !== dependencies.filter(item => item.kind === "remote").length;
  const knownPublic = Array.isArray(content.publicSources) && content.publicSources.length > 0;
  const traceSources = object(object(run.contextSnapshot).agentTrace).sources;
  const known = citations.length > 0 || dependencies.length > 0 || knownPublic || (memory?.injectedCount ?? 0) > 0 || (memory?.citedCount ?? 0) > 0
    || (Array.isArray(traceSources) && traceSources.length > 0) || /\[S:[^\]\s]+\]/u.test(message.text);
  const checks = await Promise.all(dependencies.map(item => authorized(tx, scope, run.id, item, modelTime)));
  const valid = !missing && (!known || dependencies.length > 0) && checks.every(Boolean);
  return { text: known && !valid ? CITATION_HISTORY_UNAVAILABLE : message.text,
    annotationHash: citationFingerprint([citations.map(citation => ({ id: citation.id, memoryUseItem: citation.memoryUseItem })), dependencies, knownPublic]) };
}

async function projectPair(tx: Tx, scope: CitationHistoryScope, runId: string, modelTime: number) {
  const current = await tx.message.findUniqueOrThrow({ where: { id: scope.inputMessageId }, select: { createdAt: true } });
  const run = await tx.generationRun.findFirst({ where: { id: runId, conversationId: scope.conversationId, episodeId: scope.episodeId,
    representativeVersionId: scope.representativeVersionId, status: "COMPLETED" }, include: { inputMessage: true, outputMessage: true } });
  if (!run || !run.outputMessage || run.inputMessage.senderType !== "AUDIENCE" || run.outputMessage.senderType !== "REPRESENTATIVE"
    || run.inputMessage.episodeId !== scope.episodeId || run.outputMessage.episodeId !== scope.episodeId
    || run.inputMessage.conversationId !== scope.conversationId || run.outputMessage.conversationId !== scope.conversationId
    || run.inputMessage.createdAt >= current.createdAt || run.outputMessage.createdAt >= current.createdAt
    || !alive(run.inputMessage) || !alive(run.outputMessage) || !run.inputMessage.text || !run.outputMessage.text) return reject();
  const status = object(object(run.contextSnapshot).agentTrace).status;
  if (status && !["completed", "partial"].includes(status)) return reject();
  const projected = await projectAnswer(tx, scope, run, { ...run.outputMessage, text: run.outputMessage.text }, modelTime);
  const messages: CitationHistoryMessage[] = [
    { id: run.inputMessageId, role: "user", text: run.inputMessage.text, timestamp: run.inputMessage.createdAt.getTime() },
    { id: run.outputMessage.id, role: "assistant", text: projected.text, timestamp: run.outputMessage.createdAt.getTime() },
  ];
  return { messages, proof: { runId, inputMessageId: run.inputMessageId, outputMessageId: run.outputMessage.id,
    inputHash: citationFingerprint([run.inputMessage.text, run.inputMessage.createdAt]), outputHash: citationFingerprint([run.outputMessage.text, run.outputMessage.createdAt]),
    annotationHash: projected.annotationHash, derivedHash: citationFingerprint(projected.text) } };
}

/** Current request/system/tools retain their own reserved byte budget. Drop
 * oldest complete pairs rather than slicing either role or inventing a pair.
 */
export async function loadSafeCitationHistory(input: { runId: string; outboxId: string; leaseAttempt: number; byteBudget: number; excludeInputIds?: string[] }) {
  return prisma.$transaction(async tx => {
    await fenceGenerationWorkLease(tx, input);
    const scope = await citationHistoryScopeInTransaction(tx, input.runId);
    const policy = await tx.representativeMemoryPolicy.findUnique({ where: { representativeId: scope.representativeId }, select: { shortTermMemoryEnabled: true } });
    const current = await tx.message.findUniqueOrThrow({ where: { id: scope.inputMessageId }, select: { createdAt: true } });
    const byteBudget = Math.max(0, Math.min(512000, Math.floor(input.byteBudget)));
    const run = await tx.generationRun.findUniqueOrThrow({ where: { id: input.runId }, select: { contextSnapshot: true } });
    const existing = object(object(run.contextSnapshot).agentContextAuthorization).derivedHistory;
    if (existing) {
      const proof = derivedCitationHistorySchema.parse(existing);
      const messages = await revalidateDerivedCitationHistoryInTransaction(tx, scope, proof);
      if (Buffer.byteLength(JSON.stringify(messages), "utf8") > byteBudget) return reject();
      return { messages, proof };
    }
    const formedAt = Date.now();
    const selected: Array<Awaited<ReturnType<typeof projectPair>>> = [];
    const seen = new Set(input.excludeInputIds ?? []);
    let cursor: string | undefined;
    if (policy?.shortTermMemoryEnabled !== false && byteBudget > 0) {
      while (selected.length < 8) {
        const rows = await tx.generationRun.findMany({ where: { id: { not: input.runId }, conversationId: scope.conversationId, episodeId: scope.episodeId,
          representativeVersionId: scope.representativeVersionId, status: "COMPLETED", outputMessageId: { not: null },
          inputMessage: { createdAt: { lt: current.createdAt } }, outputMessage: { createdAt: { lt: current.createdAt } } },
          orderBy: [{ inputMessage: { createdAt: "desc" } }, { id: "desc" }], take: 16, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, inputMessageId: true, contextSnapshot: true } });
        if (!rows.length) break;
        for (const row of rows) {
          if (seen.has(row.inputMessageId)) continue;
          seen.add(row.inputMessageId);
          const status = object(object(row.contextSnapshot).agentTrace).status;
          if (status && !["completed", "partial"].includes(status)) continue;
          try { selected.push(await projectPair(tx, scope, row.id, formedAt)); } catch (error) { if (!(error instanceof AgentContextAuthorizationError)) throw error; }
          if (selected.length === 8) break;
        }
        cursor = rows.at(-1)!.id;
        if (rows.length < 16) break;
      }
    }
    selected.reverse();
    while (selected.length && Buffer.byteLength(JSON.stringify(selected.flatMap(pair => pair.messages)), "utf8") > byteBudget) selected.shift();
    const messages = selected.flatMap(pair => pair.messages);
    const proof = derivedCitationHistorySchema.parse({ version: 1, formedAt, byteBudget, pairs: selected.map(pair => pair.proof), transcriptHash: citationFingerprint(messages) });
    return { messages, proof };
  });
}

export async function revalidateDerivedCitationHistoryInTransaction(tx: Tx, scope: CitationHistoryScope, proof: DerivedCitationHistoryProof, delivery = false, modelTime = Date.now()) {
  const parsed = derivedCitationHistorySchema.parse(proof);
  if (parsed.pairs.length) {
    const policy = await tx.representativeMemoryPolicy.findUnique({ where: { representativeId: scope.representativeId }, select: { shortTermMemoryEnabled: true } });
    if (policy?.shortTermMemoryEnabled === false) return reject();
  }
  const rebuilt = await Promise.all(parsed.pairs.map(pair => projectPair(tx, scope, pair.runId, delivery ? parsed.formedAt : modelTime)));
  const messages = rebuilt.flatMap(pair => pair.messages);
  if (new Set(messages.map(message => message.id)).size !== messages.length
    || messages.some((message, index) => index % 2 === 0 && index > 0 && message.timestamp < messages[index - 2]!.timestamp)) return reject();
  if (citationFingerprint(rebuilt.map(pair => pair.proof)) !== citationFingerprint(parsed.pairs)
    || citationFingerprint(messages) !== parsed.transcriptHash || Buffer.byteLength(JSON.stringify(messages), "utf8") > parsed.byteBudget) return reject();
  return messages;
}
