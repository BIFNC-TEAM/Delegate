import { afterAll, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "../../model-runtime/node_modules/@earendil-works/pi-ai";
import { DelegateAgentV2 } from "../../model-runtime/src/v2/runtime";
import { prisma } from "../src/prisma";
import { allocateEpisodeCitationSource } from "../src/citation-persistence";
import { completeInlineGenerationRun, GenerationWorkLeaseLostError, markGenerationDeliveryComplete, prepareGenerationMessageChannelDelivery } from "../src/conversation-platform";
import { acknowledgePublicMemoryDisplay } from "../src/public-memory-display";
import { prepared } from "./citation-postgres-fixture";

const enabled = process.env.DELEGATE_CITATION_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/delegate_citation_test") throw Error("isolated_citation_database_required");
}
const suite = enabled ? describe : describe.skip;
suite("r003 correction, persistence and delivery on isolated PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });
  it("clears old ranges when a skipped handoff replaces the answer", async () => {
    const f = await prepared();
    await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: {
      account: { create: { authIdentities: { create: {
        provider: "LOGTO", issuer: "https://synthetic.invalid", subject: f.audienceId,
        verifiedAt: new Date(), lastAuthenticatedAt: new Date(),
      } } } },
    } });
    await prisma.representative.update({ where: { id: f.repId }, data: { humanInLoop: false } });
    await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const completed = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId,
      replyText: "Original answer", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      humanHandoff: { reason: "visitor_request", summary: "Synthetic handoff request" },
      citationRanges: [{ start: 0, end: 8, sourceIds: ["1"] }] });
    expect(completed.message.text).not.toBe("Original answer");
    expect(completed.message.content).toMatchObject({ citationProtocol: "reference-v1", citationManifest: { count: 0 } });
    expect(await prisma.messageCitationRange.count({ where: { messageId: completed.message.id } })).toBe(0);
    expect((await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe("COMPLETED");
  });
  it("counts one delivery for a corrected answer and keeps all usage in the original run", async () => {
    const f = await prepared();
    const visitor = `citation-delivery-${f.runId}`;
    await prisma.conversation.update({ where: { id: f.conversationId }, data: { channelThreadId: `web:${visitor}` } });
    const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
    const responses = [
      fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage('<reference source="99">bad draft</reference>'),
      fauxAssistantMessage('<reference source="1">corrected answer</reference>'),
    ];
    for (const r of responses) r.usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
    let responseIndex = 0;
    const result = await new DelegateAgentV2().run({ requestId: f.runId, sessionId: f.conversationId, scope: f.episodeId,
      userText: f.input.userText, timezone: "Asia/Shanghai", authorize: boundary => f.guard.check(boundary),
      model: { provider: "faux", modelId: "faux", model: faux.getModel(), streamFn: () => {
        const stream = createAssistantMessageEventStream(); const message = responses[responseIndex++]!;
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
        return stream;
      } },
      context: { traceId: f.runId, runId: f.runId, sessionId: f.conversationId, timezone: "Asia/Shanghai", attachments: [], idempotencyKey: f.runId },
      citationSourceNumber: source => allocateEpisodeCitationSource({ ...f.input, source }),
      tools: [{ name: "lookup", label: "lookup", description: "Read synthetic authorized evidence", category: "knowledge", effect: "read", parameters: Type.Object({}),
        execute: async () => ({ text: "synthetic evidence", sources: [f.source] }) }] });
    expect(result).toMatchObject({ status: "completed", requestId: f.runId, modelCalls: 3, toolCalls: 1, citationStatus: "valid" });
    expect(result.citationDiagnostics?.recoveryCount).toBe(1);
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, tokens: 330 });
    expect(result.usage.costUsd).toBeCloseTo(0.009);
    const completion = { conversationId: f.conversationId, runId: f.runId, outboxId: f.outboxId, leaseAttempt: 1,
      replyText: result.text, senderDisplayName: "Synthetic", countUsage: true, completeOutbox: false,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costCents: 1,
      citationRanges: result.citationRanges!,
      memoryUse: { runId: f.knowledge.runId, outcome: "completed" as const, injectedItemIds: [f.source.id], citedItemIds: [f.source.id] } };
    const first = await completeInlineGenerationRun(completion);
    const repeated = await completeInlineGenerationRun(completion);
    expect(repeated.message.id).toBe(first.message.id);
    expect(await prisma.message.count({ where: { conversationId: f.conversationId, senderType: "REPRESENTATIVE" } })).toBe(1);
    expect(await prisma.generationRun.count({ where: { conversationId: f.conversationId } })).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).freeRepliesUsed).toBe(0);
    const coordinates = { conversationId: f.conversationId, runId: f.runId, outboxId: f.outboxId, leaseAttempt: 1, outputMessageId: first.message.id };
    const prep = await prepareGenerationMessageChannelDelivery(coordinates);
    const delivery = { ...coordinates, deliveryAdmission: prep.deliveryAdmission };
    await markGenerationDeliveryComplete(delivery);
    // Duplicate completion may return a no-op or reject a consumed lease; in
    // both cases the durable count and original output must remain unchanged.
    await markGenerationDeliveryComplete(delivery).catch(error => { expect(error).toBeInstanceOf(GenerationWorkLeaseLostError); });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).freeRepliesUsed).toBe(1);
    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    expect(run).toMatchObject({ inputTokens: 300, outputTokens: 30, costCents: 1, outputMessageId: first.message.id });
    const ack = { representativeSlug: f.slug, generationRunId: f.runId, outputMessageId: first.message.id, audienceIdentityId: f.audienceId, audienceId: visitor };
    expect(await acknowledgePublicMemoryDisplay(ack)).toEqual({ acknowledged: true, displayedCount: 1 });
    expect(await acknowledgePublicMemoryDisplay(ack)).toEqual({ acknowledged: true, displayedCount: 1 });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).freeRepliesUsed).toBe(1);
  });
});
