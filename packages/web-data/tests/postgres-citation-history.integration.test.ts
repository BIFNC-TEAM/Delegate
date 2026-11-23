import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/prisma";
import { createAgentContextAuthorization, captureAgentExecutionSources, persistAgentExecutionSourceReceipt, isAgentContextArtifactAuthorized } from "../src/agent-context-authorization";
import { completeInlineGenerationRun } from "../src/conversation-platform";
import { allocateEpisodeCitationSource } from "../src/citation-persistence";
import { loadSafeCitationHistory } from "../src/citation-history";
import { CITATION_HISTORY_UNAVAILABLE } from "../src/citation-history-types";
import { prepared, fixture, nextRun, addKnowledge, webObservation, digest } from "./citation-postgres-fixture";
import { DelegateAgentV2, createV2PairedConversationHistory } from "../../model-runtime/src/v2";
import { createModels, fauxAssistantMessage, fauxProvider } from "../../model-runtime/tests/faux-source-fixture";

const enabled = process.env.DELEGATE_CITATION_POSTGRES_E2E === "1";
if (enabled) { const url = new URL(process.env.DATABASE_URL ?? ""); if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/delegate_citation_test") throw new Error("isolated_citation_database_required"); }
const suite = enabled ? describe : describe.skip;

suite("safe citation conversation history on real PostgreSQL", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await prisma.$disconnect(); });
  it("keeps paired roles, masks only a revoked explicit range and proves the actual model input", async () => {
    const f = await prepared(true);
    await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const original = "资料事实；通用建议";
    const result = await finish(f, original, [{ start: 0, end: 4, sourceIds: ["1"] }]);
    const current = await nextRun(f);
    const guard = await createAgentContextAuthorization(current.input);
    const safe = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 });
    expect(safe.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(safe.messages[1]!.text).toBe(original);
    await guard.registerDerivedHistory(safe);
    const retry = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 });
    expect(retry.proof).toEqual(safe.proof);
    await guard.registerDerivedHistory(retry);
    await guard.check("model"); await guard.check("release");
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    await expect(guard.check("model")).rejects.toThrow("authorization_failed");
    const next = await nextRun(f);
    const nextGuard = await createAgentContextAuthorization(next.input);
    const sanitized = await loadSafeCitationHistory({ ...next.input, byteBudget: 20_000 });
    expect(sanitized.messages[1]!.text).toBe(`${CITATION_HISTORY_UNAVAILABLE}；通用建议`);
    await nextGuard.registerDerivedHistory(sanitized);
    const faux = fauxProvider({ tokensPerSecond: 1000000 });
    faux.setResponses([context => {
      expect(context.messages[0]?.role).toBe("user"); expect(context.messages[1]?.role).toBe("assistant");
      expect(JSON.stringify(context.messages)).not.toContain("资料事实");
      expect(JSON.stringify(context.messages)).toContain("通用建议");
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "next" });
      return fauxAssistantMessage("已理解历史限制。");
    }]);
    const models = createModels(); models.setProvider(faux.provider);
    const binding = { model: faux.getModel(), provider: "faux", modelId: "faux", streamFn: models.streamSimple.bind(models) };
    await new DelegateAgentV2().run({ requestId: next.runId, sessionId: f.conversationId, scope: f.conversationId, userText: "next", timezone: "UTC",
      model: binding, tools: [], citationSourceNumber: async () => "1", history: createV2PairedConversationHistory(sanitized.messages, binding),
      context: { traceId: next.runId, runId: next.runId, sessionId: f.conversationId, timezone: "UTC", attachments: [], idempotencyKey: next.runId },
      authorize: boundary => nextGuard.check(boundary) });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: result.message.id } })).text).toBe(original);
    expect(JSON.stringify(sanitized.proof)).not.toContain("资料事实");
  });
  it("masks the whole multi-source range if just one source is revoked", async () => {
    const f = await prepared(true);
    await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const second = await addKnowledge(f);
    await f.guard.registerKnowledge(second.runId, [second.itemId]);
    expect(await allocateEpisodeCitationSource({ ...f.input, source: { id: second.itemId, channel: "knowledge", title: "second" } })).toBe("2");
    await finish(f, "组合事实；其他文字", [{ start: 0, end: 4, sourceIds: ["1", "2"] }], [f.source.id, second.itemId]);
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    const current = await nextRun(f);
    const safe = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 });
    expect(safe.messages[1]!.text).toBe(`${CITATION_HISTORY_UNAVAILABLE}；其他文字`);
  });
  it("handles old dependent answers conservatively without inventing ranges", async () => {
    const f = await prepared(true);
    await finish(f, "旧依赖回答 [S:0123456789abcdef01234567]");
    const current = await nextRun(f);
    expect((await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).messages[1]!.text).toContain("旧依赖回答");
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    expect((await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).messages[1]!.text).toBe(CITATION_HISTORY_UNAVAILABLE);
  });
  it("keeps source-free legacy answers and masks known dependencies that cannot be verified", async () => {
    const f = await fixture(); await createAgentContextAuthorization(f.input);
    const old = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "旧通用回答", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false });
    const current = await nextRun(f);
    expect((await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).messages[1]!.text).toBe("旧通用回答");
    await prisma.message.update({ where: { id: old.message.id }, data: { content: { publicSources: [{ title: "unverifiable legacy source", channel: "knowledge" }] } } });
    expect((await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).messages[1]!.text).toBe(CITATION_HISTORY_UNAVAILABLE);
  });
  it("loads at most eight recent complete pairs and removes oldest whole pairs for bytes", async () => {
    const f = await fixture(); let input = f.input;
    for (let index = 0; index < 10; index++) {
      await createAgentContextAuthorization(input);
      await completeInlineGenerationRun({ ...input, conversationId: f.conversationId, replyText: `answer-${index}`, senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false, citationRanges: [] });
      input = (await nextRun(f)).input;
    }
    const full = await loadSafeCitationHistory({ ...input, byteBudget: 20_000 });
    expect(full.proof.pairs).toHaveLength(8);
    expect(full.messages.filter(message => message.role === "assistant").map(message => message.text)).toEqual(Array.from({ length: 8 }, (_, i) => `answer-${i + 2}`));
    const bytes = Buffer.byteLength(JSON.stringify(full.messages.slice(-4)), "utf8");
    const cropped = await loadSafeCitationHistory({ ...input, byteBudget: bytes });
    expect(cropped.messages).toEqual(full.messages.slice(-4));
    expect(cropped.proof.pairs).toHaveLength(2);
    expect((await loadSafeCitationHistory({ ...input, byteBudget: 0 })).messages).toEqual([]);
  });
  it("keeps the existing strict one-hour boundary for historical Web observations", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input);
    const web = await webObservation(f, guard);
    await allocateEpisodeCitationSource({ ...f.input, source: web.source, receiptReference: web.reference });
    await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "网页事实；其他文字", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      citationRanges: [{ start: 0, end: 4, sourceIds: ["1"] }] });
    const current = await nextRun(f); const nextGuard = await createAgentContextAuthorization(current.input);
    const source = await prisma.episodeCitationSource.findFirstOrThrow({ where: { episodeId: f.episodeId } });
    const time = Date.parse((source.metadata as { observedAt: string }).observedAt);
    const now = vi.spyOn(Date, "now").mockReturnValue(time + 3600_000);
    const exact = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 });
    expect(exact.messages[1]!.text).toBe("网页事实；其他文字");
    await nextGuard.registerDerivedHistory(exact);
    const captured = await captureAgentExecutionSources({ runId: current.runId, kind: "derived_python" });
    const artifactScope = { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId };
    const session = await prisma.computeSession.create({ data: { ...artifactScope, representativeVersionId: f.versionId, generationRunId: current.runId,
      requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
    const execution = await prisma.toolExecution.create({ data: { sessionId: session.id, capability: "EXEC", status: "SUCCEEDED", finishedAt: new Date() } });
    const artifact = await prisma.artifact.create({ data: { ...artifactScope, sessionId: session.id, toolExecutionId: execution.id,
      kind: "JSON", bucket: "synthetic", objectKey: randomUUID(), mimeType: "application/json", sizeBytes: 2, sha256: digest("{}") } });
    await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, execution.id, captured!));
    now.mockReturnValue(time + 3600_001);
    await expect(nextGuard.check("model")).rejects.toThrow();
    expect(await isAgentContextArtifactAuthorized({ runId: current.runId, representativeId: f.repId, conversationId: f.conversationId,
      audienceIdentityId: f.audienceId, toolExecutionId: execution.id, artifactId: artifact.id })).toBe(true);
    await expect(loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).rejects.toThrow();
    const later = await nextRun(f);
    const expired = await loadSafeCitationHistory({ ...later.input, byteBudget: 20_000 });
    expect(expired.messages[1]!.text).toBe(`${CITATION_HISTORY_UNAVAILABLE}；其他文字`);
  });
  it("rejects copied proofs across identities or episodes", async () => {
    const a = await prepared(); await allocateEpisodeCitationSource({ ...a.input, source: a.source });
    await finish(a, "事实", [{ start: 0, end: 2, sourceIds: ["1"] }]);
    const current = await nextRun(a);
    const safe = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 });
    const b = await fixture(); const other = await createAgentContextAuthorization(b.input);
    await expect(other.registerDerivedHistory(safe)).rejects.toThrow();
    const episode = await prisma.conversationEpisode.create({ data: { conversationId: a.conversationId, representativeVersionId: a.versionId, sequence: 2 } });
    await prisma.conversation.update({ where: { id: a.conversationId }, data: { activeEpisodeId: episode.id } });
    const next = await nextRun({ ...a, episodeId: episode.id }); const otherEpisode = await createAgentContextAuthorization(next.input);
    await expect(otherEpisode.registerDerivedHistory(safe)).rejects.toThrow();
    expect((await loadSafeCitationHistory({ ...next.input, byteBudget: 20_000 })).messages).toEqual([]);
  });
  it.each(["redaction", "retention", "memory_disabled"])("rejects a signed history after %s and does not load invalid pairs", async change => {
    const f = await prepared(true); await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const old = await finish(f, "原事实", [{ start: 0, end: 3, sourceIds: ["1"] }]);
    const current = await nextRun(f); const guard = await createAgentContextAuthorization(current.input);
    const safe = await loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 }); await guard.registerDerivedHistory(safe);
    if (change === "redaction") await prisma.message.update({ where: { id: old.message.id }, data: { redactedAt: new Date() } });
    if (change === "retention") await prisma.message.update({ where: { id: old.message.id }, data: { retentionExpiresAt: new Date(Date.now() - 1) } });
    if (change === "memory_disabled") await prisma.representativeMemoryPolicy.upsert({ where: { representativeId: f.repId }, create: { representativeId: f.repId, namespaceKey: `citation-test-${f.repId}`, contactMemoryCrossChannelEnabled: false, shortTermMemoryEnabled: false }, update: { shortTermMemoryEnabled: false } });
    await expect(guard.check("model")).rejects.toThrow(); await expect(guard.check("release")).rejects.toThrow();
    await expect(loadSafeCitationHistory({ ...current.input, byteBudget: 20_000 })).rejects.toThrow();
    const later = await nextRun(f);
    expect((await loadSafeCitationHistory({ ...later.input, byteBudget: 20_000 })).messages).toEqual([]);
  });
});

function finish(f: Awaited<ReturnType<typeof prepared>>, text: string, ranges?: Array<{ start: number; end: number; sourceIds: string[] }>, items = [f.source.id]) {
  return completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: text, senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
    ...(ranges ? { citationRanges: ranges } : {}), memoryUse: { runId: f.knowledge.runId, outcome: "completed", injectedItemIds: items, citedItemIds: items } });
}
