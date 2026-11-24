import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { createAgentContextAuthorization } from "../src/agent-context-authorization";
import { completeInlineGenerationRun } from "../src/conversation-platform";
import { allocateEpisodeCitationSource } from "../src/citation-persistence";
import { getPublicCitationSources, projectPublicCitationRanges } from "../src/public-citation-sources";
import { buildWebConversationThreadId } from "../src/web-audience";
import { prepared, fixture, addKnowledge, webObservation } from "./citation-postgres-fixture";

const enabled = process.env.DELEGATE_CITATION_POSTGRES_E2E === "1";
if (enabled) { const url = new URL(process.env.DATABASE_URL ?? ""); if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/delegate_citation_test") throw new Error("isolated_citation_database_required"); }
const suite = enabled ? describe : describe.skip;
const visitor = "synthetic-citation-visitor";
suite("public range sources under real PostgreSQL authorization", () => {
  afterEach(() => { vi.restoreAllMocks(); }); afterAll(async () => { await prisma.$disconnect(); });
  it("returns only each range's sources, revokes a whole multi-source card, and isolates visitors", async () => {
    const f = await prepared(true); await bindVisitor(f.conversationId);
    await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const second = await addKnowledge(f); await f.guard.registerKnowledge(second.runId, [second.itemId]);
    await allocateEpisodeCitationSource({ ...f.input, source: { id: second.itemId, title: "Second title", channel: "knowledge" } });
    const completed = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "甲乙丙", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      citationRanges: [{ start: 0, end: 1, sourceIds: ["1"] }, { start: 1, end: 2, sourceIds: ["2"] }, { start: 2, end: 3, sourceIds: ["1", "2"] }],
      memoryUse: { runId: f.knowledge.runId, outcome: "completed", injectedItemIds: [f.source.id, second.itemId], citedItemIds: [f.source.id, second.itemId] } });
    const ranges = await prisma.messageCitationRange.findMany({ where: { messageId: completed.message.id }, orderBy: { ordinal: "asc" } });
    const input = { representativeSlug: f.slug, audienceIdentityId: f.audienceId, audienceId: visitor, messageId: completed.message.id, rangeId: ranges[0]!.id };
    expect(await getPublicCitationSources(input)).toEqual({ status: "available", sources: [{ title: "Synthetic" }] });
    expect(await getPublicCitationSources({ ...input, rangeId: ranges[1]!.id })).toEqual({ status: "available", sources: [{ title: "Second title" }] });
    const metadata = await getPublicCitationSources({ ...input, rangeId: ranges[2]!.id }); expect(metadata.sources).toHaveLength(2);
    expect(JSON.stringify(metadata)).not.toMatch(/viking:|resourceKey|memoryUse|episode|contentHash|coordinate/);
    await expect(getPublicCitationSources({ ...input, audienceIdentityId: "other-identity" })).rejects.toThrow("citation_not_found");
    await expect(getPublicCitationSources({ ...input, audienceId: "other-visitor" })).rejects.toThrow("citation_not_found");
    await expect(getPublicCitationSources({ ...input, messageId: f.messageId })).rejects.toThrow("citation_not_found");
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    expect(await getPublicCitationSources(input)).toEqual({ status: "unavailable", sources: [] });
    expect(await getPublicCitationSources({ ...input, rangeId: ranges[2]!.id })).toEqual({ status: "unavailable", sources: [] });
    expect((await getPublicCitationSources({ ...input, rangeId: ranges[1]!.id })).sources).toEqual([{ title: "Second title" }]);
  });
  it("keeps metadata reads separate from model freshness and includes validated external metadata only", async () => {
    const f = await fixture(); await bindVisitor(f.conversationId); const guard = await createAgentContextAuthorization(f.input);
    const web = await webObservation(f, guard); await allocateEpisodeCitationSource({ ...f.input, source: web.source, receiptReference: web.reference });
    const completed = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "Web fact", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      citationRanges: [{ start: 0, end: 8, sourceIds: ["1"] }] });
    const range = await prisma.messageCitationRange.findFirstOrThrow({ where: { messageId: completed.message.id } });
    const source = await prisma.episodeCitationSource.findFirstOrThrow({ where: { episodeId: f.episodeId } });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse((source.metadata as { observedAt: string }).observedAt) + 7200_000);
    expect(await getPublicCitationSources({ representativeSlug: f.slug, audienceIdentityId: f.audienceId, audienceId: visitor, messageId: completed.message.id, rangeId: range.id }))
      .toEqual({ status: "available", sources: [{ title: "Web fixture", domain: "example.invalid", url: "https://example.invalid/same-url" }] });
  });
  it("preserves historical public title access across episodes but still honors live withdrawal", async () => {
    const f = await prepared(true); await bindVisitor(f.conversationId); await allocateEpisodeCitationSource({ ...f.input, source: f.source });
    const completed = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "Old fact", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false,
      citationRanges: [{ start: 0, end: 8, sourceIds: ["1"] }], memoryUse: { runId: f.knowledge.runId, outcome: "completed", injectedItemIds: [f.source.id], citedItemIds: [f.source.id] } });
    const range = await prisma.messageCitationRange.findFirstOrThrow({ where: { messageId: completed.message.id } });
    const episode = await prisma.conversationEpisode.create({ data: { conversationId: f.conversationId, representativeVersionId: f.versionId, sequence: 2 } });
    await prisma.conversation.update({ where: { id: f.conversationId }, data: { activeEpisodeId: episode.id } });
    const input = { representativeSlug: f.slug, audienceIdentityId: f.audienceId, audienceId: visitor, messageId: completed.message.id, rangeId: range.id };
    expect((await getPublicCitationSources(input)).status).toBe("available");
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    expect((await getPublicCitationSources(input)).status).toBe("unavailable");
  });
  it("does not publish corrupt ranges or guess the scope of old message-level citations", async () => {
    expect(projectPublicCitationRanges({ text: "old", content: null })).toBeUndefined();
    expect(projectPublicCitationRanges({ text: "new", content: { citationProtocol: "reference-v1", citationManifest: {} }, citationRanges: [] })).toEqual([]);
  });
});
function bindVisitor(conversationId: string) { return prisma.conversation.update({ where: { id: conversationId }, data: { channelThreadId: buildWebConversationThreadId(visitor) } }); }
