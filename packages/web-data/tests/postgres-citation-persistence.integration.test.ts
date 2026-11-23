import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/prisma";
import { createAgentContextAuthorization, captureAgentExecutionSources, persistAgentExecutionSourceReceipt } from "../src/agent-context-authorization";
import { recordMemoryUseSearchHits, startOrReuseMemoryUseRun } from "../src/memory-use-execution";
import { allocateEpisodeCitationSource, persistCitationRangesInTransaction, readCitationRangesInTransaction, citationBodyHash } from "../src/citation-persistence";
import { completeInlineGenerationRun } from "../src/conversation-platform";

import { prepared, fixture, nextRun, webObservation, digest, canary } from "./citation-postgres-fixture";

const enabled = process.env.DELEGATE_CITATION_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/delegate_citation_test") throw new Error("isolated_citation_database_required");
}
const suite = enabled ? describe : describe.skip;


suite("r003 source registry on real isolated PostgreSQL and source authorization", () => {
  afterAll(async () => { await prisma.$disconnect(); });
  it("allocates one stable number under concurrent registration", async () => {
    const f = await prepared();
    const numbers = await Promise.all(Array.from({ length: 12 }, () => allocateEpisodeCitationSource({ ...f.input, source: f.source })));
    expect(new Set(numbers)).toEqual(new Set(["1"]));
    expect(await prisma.episodeCitationSource.count({ where: { episodeId: f.episodeId } })).toBe(1);
  });
  it("reuses the immutable resource across runs but not the old acquisition grant", async () => {
    const f = await prepared();
    expect(await allocateEpisodeCitationSource({ ...f.input, source: f.source })).toBe("1");
    const next = await nextRun(f);
    await createAgentContextAuthorization(next.input);
    const output = await prisma.message.create({ data: { conversationId: f.conversationId, episodeId: f.episodeId, senderType: "REPRESENTATIVE", text: "answer" } });
    await expect(prisma.$transaction(tx => persistCitationRangesInTransaction(tx, { runId: next.runId, messageId: output.id, text: "answer", ranges: [{ start: 0, end: 6, sourceIds: ["1"] }] }))).rejects.toThrow();
    const projection = await prisma.publicKnowledgeProjectionItem.findUniqueOrThrow({ where: { id: f.knowledge.projectionId } });
    const use = await startOrReuseMemoryUseRun({ generationRunId: next.runId, sourceChannel: "web" });
    const hits = await recordMemoryUseSearchHits({ useRunId: use.run.id, hits: [{ sourceKind: "PUBLIC_KNOWLEDGE", publicKnowledgeProjectionId: projection.id }] });
    const itemId = hits.eligibleItems[0]!.memoryUseItemId;
    const guard = await createAgentContextAuthorization(next.input);
    await guard.registerKnowledge(use.run.id, [itemId]);
    expect(itemId).not.toBe(f.source.id);
    expect(await allocateEpisodeCitationSource({ ...next.input, source: { ...f.source, id: itemId } })).toBe("1");
    expect(await prisma.episodeCitationSource.count({ where: { episodeId: f.episodeId } })).toBe(1);
  });
  it("rejects current revocation and stale leases without creating numbers", async () => {
    const f = await prepared();
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    await expect(allocateEpisodeCitationSource({ ...f.input, source: f.source })).rejects.toThrow();
    expect(await prisma.episodeCitationSource.count({ where: { episodeId: f.episodeId } })).toBe(0);
    const asset = await prepared(true);
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: asset.assetId, representativeId: asset.repId }, data: { enabled: false } });
    await expect(allocateEpisodeCitationSource({ ...asset.input, source: asset.source })).rejects.toThrow();
  });
  it("keeps the pinned published body when an original asset is edited", async () => {
    const f = await prepared(true);
    expect(await allocateEpisodeCitationSource({ ...f.input, source: f.source })).toBe("1");
    await prisma.knowledgeAsset.update({ where: { id: f.assetId }, data: { extractedText: "SYNTHETIC_NEW_DRAFT", checksum: digest("SYNTHETIC_NEW_DRAFT") } });
    expect(await allocateEpisodeCitationSource({ ...f.input, source: f.source })).toBe("1");
    const row = await prisma.episodeCitationSource.findFirstOrThrow({ where: { episodeId: f.episodeId } });
    expect(row.contentHash).toBe(digest(canary));
    const resource = await prisma.representativeVersionResource.findUniqueOrThrow({ where: { publishedVersionId_resourceKey: { publishedVersionId: f.versionId, resourceKey: `knowledge/${f.assetId}.md` } } });
    expect(resource.safeText).toBe(canary);
  });
  it("preserves separate ranges and rolls back a whole output transaction on failure", async () => {
    const f = await prepared(); await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const text = "甲😀乙";
    const message = await prisma.$transaction(async tx => {
      const row = await tx.message.create({ data: { conversationId: f.conversationId, episodeId: f.episodeId, senderType: "REPRESENTATIVE", text } });
      await persistCitationRangesInTransaction(tx, { runId: f.runId, messageId: row.id, text, ranges: [{ start: 0, end: 1, sourceIds: ["1"] }, { start: 1, end: 4, sourceIds: ["1"] }] });
      return row;
    });
    const ranges = await prisma.$transaction(tx => readCitationRangesInTransaction(tx, message.id, text));
    expect(ranges).toHaveLength(2);
    expect(ranges![0]!.bodyHash).toBe(citationBodyHash(text));
    expect(ranges!.flatMap(range => range.sources)).toHaveLength(2);
    const before = await prisma.message.count({ where: { conversationId: f.conversationId } });
    await expect(prisma.$transaction(async tx => {
      const row = await tx.message.create({ data: { conversationId: f.conversationId, episodeId: f.episodeId, senderType: "REPRESENTATIVE", text } });
      await persistCitationRangesInTransaction(tx, { runId: f.runId, messageId: row.id, text, ranges: [{ start: 0, end: 1, sourceIds: ["1"] }, { start: 1, end: 4, sourceIds: ["99"] }] });
    })).rejects.toThrow();
    expect(await prisma.message.count({ where: { conversationId: f.conversationId } })).toBe(before);
    expect(await prisma.messageCitationRange.count({ where: { messageId: message.id } })).toBe(2);
    expect(await prisma.$transaction(tx => readCitationRangesInTransaction(tx, message.id, "modified"))).toBeNull();
    await prisma.messageCitationRange.deleteMany({ where: { messageId: message.id } });
    expect(await prisma.$transaction(tx => readCitationRangesInTransaction(tx, message.id, text))).toBeNull();
  });
  it("isolates identities and episodes even when their visible number is the same", async () => {
    const a = await prepared(), b = await prepared();
    expect(await allocateEpisodeCitationSource({ ...a.input, source: a.source })).toBe("1");
    expect(await allocateEpisodeCitationSource({ ...b.input, source: b.source })).toBe("1");
    await expect(allocateEpisodeCitationSource({ ...a.input, source: b.source })).rejects.toThrow();
    const sources = await prisma.episodeCitationSource.findMany({ where: { episodeId: { in: [a.episodeId, b.episodeId] } } });
    expect(new Set(sources.map(s => s.identityScopeHash)).size).toBe(2);
    const { message: old } = await completeInlineGenerationRun({ conversationId: a.conversationId, runId: a.runId,
      outboxId: a.outboxId, leaseAttempt: 1, replyText: "old [S:24-digit-id]", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      memoryUse: { runId: a.knowledge.runId, outcome: "completed", injectedItemIds: [a.source.id], citedItemIds: [a.source.id] } });
    expect(await prisma.$transaction(tx => readCitationRangesInTransaction(tx, old.id, old.text!))).toEqual([]);
    expect(await prisma.messageCitation.findMany({ where: { messageId: old.id } })).toHaveLength(1);
  });
  it("binds Web observations to exact receipts rather than equal URLs", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input);
    const first = await webObservation(f, guard), second = await webObservation(f, guard);
    expect(await allocateEpisodeCitationSource({ ...f.input, source: first.source, receiptReference: first.reference })).toBe("1");
    expect(await allocateEpisodeCitationSource({ ...f.input, source: second.source, receiptReference: second.reference })).toBe("2");
    expect(await allocateEpisodeCitationSource({ ...f.input, source: first.source, receiptReference: first.reference })).toBe("1");
    await expect(allocateEpisodeCitationSource({ ...f.input, source: first.source, receiptReference: second.reference })).rejects.toThrow();
  });
  it("commits exact final text, range relationships and legacy citations once in the completion transaction", async () => {
    const f = await prepared(); await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const text = " 甲😀乙 ";
    const input = { conversationId: f.conversationId, runId: f.runId, outboxId: f.outboxId, leaseAttempt: 1,
      replyText: text, senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      citationRanges: [{ start: 1, end: 2, sourceIds: ["1"] }, { start: 2, end: 5, sourceIds: ["1"] }],
      memoryUse: { runId: f.knowledge.runId, outcome: "completed" as const, injectedItemIds: [f.source.id], citedItemIds: [f.source.id] } };
    const first = await completeInlineGenerationRun(input);
    const second = await completeInlineGenerationRun(input);
    expect(first.message.text).toBe(text); expect(second.message.id).toBe(first.message.id);
    expect(await prisma.messageCitationRange.count({ where: { messageId: first.message.id } })).toBe(2);
    expect(await prisma.messageCitation.count({ where: { messageId: first.message.id } })).toBe(1);
    expect(first.run.outputMessageId).toBe(first.message.id);
    expect(first.message.content).toMatchObject({ citationProtocol: "reference-v1" });
  });
  it("keeps MCP receipts versioned and rejects re-use after the existing one-hour limit", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input);
    const binding = await prisma.representativeMcpBinding.create({ data: { representativeId: f.repId, slug: "fixture", displayName: "Synthetic public service",
      serverUrl: "https://open-meteo.caseyjhand.com/mcp", allowedToolNames: ["openmeteo_search_locations"], approvalRequired: true } });
    await prisma.mcpToolDefinition.create({ data: { bindingId: binding.id, bindingRevision: 1, exactToolName: "openmeteo_search_locations",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      toolSchemaHash: "af23eb22e1651a38e705d9ceeff31faca25ef327324256088ca275b8d2849968", bindingDefinitionHash: "a".repeat(64), observedAt: new Date() } });
    const captured = await captureAgentExecutionSources({ runId: f.runId, kind: "public_mcp", bindingId: binding.id, toolName: "openmeteo_search_locations" });
    const scope = { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId };
    const session = await prisma.computeSession.create({ data: { ...scope, representativeVersionId: f.versionId, generationRunId: f.runId, requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
    for (const ageMs of [3600_001, 0]) {
      const execution = await prisma.toolExecution.create({ data: { sessionId: session.id, capability: "MCP", mcpBindingId: binding.id,
        requestedCommand: "openmeteo_search_locations", requestPayload: { toolArguments: { name: "Synthetic" } }, status: "SUCCEEDED", finishedAt: new Date(Date.now() - ageMs) } });
      await prisma.artifact.create({ data: { ...scope, sessionId: session.id, toolExecutionId: execution.id, kind: "JSON", bucket: "synthetic", objectKey: randomUUID(), mimeType: "application/json", sizeBytes: 2, sha256: digest("{}") } });
      await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, execution.id, captured!));
      if (ageMs) {
        await expect(guard.registerToolResult(execution.id)).rejects.toThrow();
      } else {
        const reference = await guard.registerToolResult(execution.id);
        const source = { id: "fixture:openmeteo_search_locations:synthetic", title: "Synthetic MCP", channel: "mcp" as const };
        expect(await allocateEpisodeCitationSource({ ...f.input, source, receiptReference: reference! })).toBe("1");
        const receipt = await prisma.toolExecution.findUniqueOrThrow({ where: { id: execution.id }, select: { sourceReceipt: true } });
        expect(JSON.stringify(receipt.sourceReceipt)).not.toContain("toolArguments");
      }
    }
  });
});
