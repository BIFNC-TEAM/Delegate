import { citationHistoryScopeInTransaction, revalidateCitationHistoryAcquisitionInTransaction } from "./agent-context-authorization";
import { assertCitationRangeBounds, citationBodyHash, citationFingerprint, citationRangeManifest, parseCitationAcquisition, readCitationRangesInTransaction } from "./citation-persistence";
import { prisma } from "./prisma";
import { buildWebConversationThreadId } from "./web-audience";

export type PublicCitationRange = { id: string; start: number; end: number };
export type PublicRangeSource = { title: string; domain?: string; url?: string };
export type PublicCitationSources = { status: "available" | "unavailable"; sources: PublicRangeSource[] };
export const publicCitationRangeProjection = {
  orderBy: { ordinal: "asc" as const }, select: { id: true, start: true, end: true, ordinal: true, bodyHash: true,
    sources: { select: { source: { select: { ordinal: true } } } } },
};
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function projectPublicCitationRanges(message: { text: string | null; content: unknown; citationRanges?: Array<{ id: string; start: number; end: number; ordinal: number; bodyHash: string; sources: Array<{ source: { ordinal: number } }> }> }): PublicCitationRange[] | undefined {
  const content = record(message.content);
  if (content.citationProtocol !== "reference-v1") return undefined;
  const rows = message.citationRanges ?? [];
  const ranges = rows.map(row => ({ start: row.start, end: row.end, sourceIds: row.sources.map(item => String(item.source.ordinal)) }));
  try {
    assertCitationRangeBounds(message.text ?? "", ranges);
    if (rows.some((row, index) => row.ordinal !== index + 1 || row.bodyHash !== citationBodyHash(message.text ?? ""))
      || citationFingerprint(content.citationManifest) !== citationFingerprint(citationRangeManifest(message.text ?? "", ranges))) return [];
    return rows.map(({ id, start, end }) => ({ id, start, end }));
  } catch { return []; }
}

export class PublicCitationSourceError extends Error {
  constructor(readonly status: 400 | 404) { super(status === 404 ? "citation_not_found" : "invalid_citation_request"); }
}
const unavailable = (): PublicCitationSources => ({ status: "unavailable", sources: [] });

/** Read-only range lookup under the requesting visitor's current identity.
 * Never trust client-supplied source lists, titles, coordinates or old metadata.
 */
export async function getPublicCitationSources(input: { representativeSlug: string; audienceIdentityId: string; audienceId: string; messageId: string; rangeId: string }): Promise<PublicCitationSources> {
  for (const value of Object.values(input)) if (typeof value !== "string" || !value.trim() || value.length > 191) throw new PublicCitationSourceError(400);
  return prisma.$transaction(async tx => {
    const message = await tx.message.findFirst({ where: { id: input.messageId, senderType: "REPRESENTATIVE", redactedAt: null,
      OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }],
      conversation: { representative: { slug: input.representativeSlug }, audienceIdentityId: input.audienceIdentityId, sourceChannel: "web", channelThreadId: buildWebConversationThreadId(input.audienceId) } },
      select: { id: true, text: true, episodeId: true, outputForGenerationRuns: { where: { status: "COMPLETED" }, take: 1, orderBy: { completedAt: "desc" }, select: { id: true } } } });
    if (!message) throw new PublicCitationSourceError(404);
    const origin = message.outputForGenerationRuns[0];
    if (!origin || !message.text) return unavailable();
    const rangeExists = await tx.messageCitationRange.findFirst({ where: { id: input.rangeId, messageId: message.id }, select: { id: true } });
    if (!rangeExists) throw new PublicCitationSourceError(404);
    const ranges = await readCitationRangesInTransaction(tx, message.id, message.text);
    const range = ranges?.find(item => item.id === input.rangeId);
    if (!range) return unavailable();
    try {
      const scope = await citationHistoryScopeInTransaction(tx, origin.id, true);
      const scopeHash = citationFingerprint([scope.representativeId, scope.representativeVersionId, scope.conversationId, scope.contactId, scope.audienceIdentityId, scope.episodeId]);
      const sources: PublicRangeSource[] = [];
      for (const item of [...range.sources].sort((a, b) => a.source.ordinal - b.source.ordinal)) {
        const source = item.source;
        if (source.episodeId !== message.episodeId || source.identityScopeHash !== scopeHash || source.representativeId !== scope.representativeId) return unavailable();
        const acquisition = parseCitationAcquisition(item.acquisition);
        if (!acquisition) return unavailable();
        if (source.sourceKind === "public_knowledge") {
          // Public historical metadata is tied to the old published resource,
          // with live asset/binding checks; it does not grant model reuse.
          const coordinate = record(source.coordinate);
          if (source.versionKey !== scope.representativeVersionId || typeof coordinate.resourceKey !== "string") return unavailable();
          const resource = await tx.representativeVersionResource.findUnique({ where: { publishedVersionId_resourceKey: { publishedVersionId: source.versionKey, resourceKey: coordinate.resourceKey } },
            select: { representativeId: true, contentHash: true, knowledgeAssetId: true, publishedVersion: { select: { status: true } } } });
          if (!resource || resource.representativeId !== scope.representativeId || resource.contentHash !== source.contentHash || resource.publishedVersion.status !== "PUBLISHED") return unavailable();
          if (resource.knowledgeAssetId) {
            const asset = await tx.knowledgeAsset.findFirst({ where: { id: resource.knowledgeAssetId, ownerId: scope.ownerId, archivedAt: null, status: { not: "ARCHIVED" },
              representativeLinks: { some: { representativeId: scope.representativeId, enabled: true, reviewStatus: "APPROVED" } } }, select: { id: true } });
            if (!asset) return unavailable();
          }
        } else if (["governed_memory", "web", "mcp"].includes(source.sourceKind)) {
          await revalidateCitationHistoryAcquisitionInTransaction(tx, scope, origin.id, acquisition, { delivery: true });
        } else return unavailable();
        const metadata = record(source.metadata);
        if (typeof metadata.title !== "string" || !metadata.title.trim()) return unavailable();
        const visible: PublicRangeSource = { title: metadata.title.slice(0, 200) };
        if (source.sourceKind !== "public_knowledge" && typeof metadata.url === "string") {
          const url = new URL(metadata.url);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) { visible.url = url.href; visible.domain = url.hostname; }
        }
        sources.push(visible);
      }
      return { status: "available", sources };
    } catch { return unavailable(); }
  });
}
