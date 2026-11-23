import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import { citationAuthorityInTransaction } from "./agent-context-authorization";
import { prisma } from "./prisma";
import { fenceGenerationWorkLease } from "./conversation-platform";

type Tx = Prisma.TransactionClient;
export type PersistedCitationRangeInput = { start: number; end: number; sourceIds: string[] };
type Source = { id: string; title: string; channel: "knowledge" | "web" | "mcp"; url?: string };
type AllocationInput = { runId: string; outboxId: string; leaseAttempt: number; source: Source; receiptReference?: string };
const canonical = (value: unknown): unknown => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const citationFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const citationBodyHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function citationRangeManifest(text: string, ranges: PersistedCitationRangeInput[]) {
  return { bodyHash: citationBodyHash(text), count: ranges.length, rangeHash: citationFingerprint(ranges.map(range => ({
    start: range.start, end: range.end, sourceIds: [...range.sourceIds].sort((a, b) => Number(a) - Number(b)),
  }))) };
}
const reject = (): never => { throw new AgentContextAuthorizationError(); };
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const acquisitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), useRunId: z.string(), itemId: z.string() }).strict(),
  z.object({ kind: z.literal("remote"), executionId: z.string(), revision: sha, toolName: z.string() }).strict(),
]);
const bindingSchema = z.object({ sourceId: z.string(), identityScopeHash: sha, acquisition: acquisitionSchema }).strict();
const bindingsSchema = z.record(z.string().regex(/^[1-9]\d*$/u), bindingSchema);
export type CitationAcquisition = z.infer<typeof acquisitionSchema>;
export function parseCitationAcquisition(value: unknown): CitationAcquisition | null {
  const parsed = acquisitionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const bindingKey = "citationSourceBindings";
function bindings(snapshot: Record<string, unknown>) { return bindingsSchema.parse(snapshot[bindingKey] ?? {}); }
type Authority = Awaited<ReturnType<typeof citationAuthorityInTransaction>>;
function identityHash(authority: Authority) {
  const s = authority.scope;
  if (!s.episodeId || s.episodeId !== s.messageEpisodeId || s.sourceChannel !== "web") return reject();
  return citationFingerprint([s.representativeId, s.representativeVersionId, s.conversationId, s.contactId, s.audienceIdentityId, s.episodeId]);
}

function publicMetadata(source: Source, observedAt?: string) {
  if (!source.title.trim() || source.title.length > 2000) return reject();
  const data: Record<string, string> = { title: source.title.slice(0, 200) };
  if (source.channel !== "knowledge" && source.url) {
    let url: URL;
    try { url = new URL(source.url); } catch { return reject(); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return reject();
    data.url = url.href;
    data.domain = url.hostname;
  }
  if (observedAt) data.observedAt = observedAt;
  return data;
}

async function resolveVersion(tx: Tx, authority: Authority, source: Source, receiptReference?: string) {
  if (source.channel === "knowledge") {
    const grant = authority.memory.find(memory => memory.itemIds.includes(source.id));
    if (!grant) return reject();
    const item = await tx.memoryUseItem.findFirst({ where: { id: source.id, useRunId: grant.useRunId, representativeId: authority.scope.representativeId },
      select: { sourceKind: true, contentHash: true, memoryVersionId: true, publicKnowledgeProjection: {
        select: { publishedVersionId: true, resourceKey: true, knowledgeAssetId: true, contentHash: true, sourceKind: true } } } });
    if (!item || !sha.safeParse(item.contentHash).success) return reject();
    const projection = item.publicKnowledgeProjection;
    if (projection) {
      if (projection.publishedVersionId !== authority.scope.representativeVersionId || projection.contentHash !== item.contentHash) return reject();
      return { sourceKind: "public_knowledge", coordinate: { resourceKey: projection.resourceKey, assetId: projection.knowledgeAssetId, sourceKind: projection.sourceKind },
        versionKey: projection.publishedVersionId, contentHash: item.contentHash, metadata: publicMetadata(source),
        acquisition: { kind: "memory" as const, useRunId: grant.useRunId, itemId: source.id } };
    }
    if (!item.memoryVersionId) return reject();
    return { sourceKind: "governed_memory", coordinate: { sourceKind: item.sourceKind, memoryVersionId: item.memoryVersionId },
      versionKey: item.memoryVersionId, contentHash: item.contentHash, metadata: publicMetadata(source),
      acquisition: { kind: "memory" as const, useRunId: grant.useRunId, itemId: source.id } };
  }
  const grant = authority.remote.find(remote => `${remote.executionId}:${remote.revision}` === receiptReference);
  if (!grant) return reject();
  const execution = await tx.toolExecution.findFirst({ where: { id: grant.executionId, session: { generationRunId: authority.scope.runId } },
    select: { finishedAt: true, sourceReceipt: true, artifacts: { select: { id: true } } } });
  if (!execution?.finishedAt || !execution.sourceReceipt) return reject();
  if (source.channel === "web" && !execution.artifacts.some(artifact => artifact.id === source.id)) return reject();
  const observedAt = z.object({ observedAt: z.string().datetime() }).parse(execution.sourceReceipt).observedAt;
  // Current model authorization has already enforced the receipt's freshness.
  // Keep the exact receipt revision, never equate observations by URL alone.
  return { sourceKind: source.channel, coordinate: { executionId: grant.executionId, sourceId: source.id, toolName: grant.toolName },
    versionKey: grant.executionId, contentHash: grant.revision, metadata: publicMetadata(source, observedAt),
    acquisition: { kind: "remote" as const, ...grant } };
}

/** The caller is a trusted host adapter, never a public/model endpoint. */
export async function allocateEpisodeCitationSource(input: AllocationInput) {
  return prisma.$transaction(tx => allocateEpisodeCitationSourceInTransaction(tx, input));
}

export async function allocateEpisodeCitationSourceInTransaction(tx: Tx, input: AllocationInput) {
  await fenceGenerationWorkLease(tx, input);
  // Same-run registrations serialize before touching the episode allocation lock.
  await tx.$queryRaw`SELECT "id" FROM "GenerationRun" WHERE "id" = ${input.runId} FOR UPDATE`;
  const authority = await citationAuthorityInTransaction(tx, input.runId);
  const scopeHash = identityHash(authority);
  const episodeId = authority.scope.episodeId!;
  const version = await resolveVersion(tx, authority, input.source, input.receiptReference);
  const sourceKey = citationFingerprint([authority.scope.representativeId, version.sourceKind, version.coordinate, version.versionKey, version.contentHash]);
  await tx.$queryRaw`SELECT "id" FROM "ConversationEpisode" WHERE "id" = ${episodeId} FOR UPDATE`;
  let row = await tx.episodeCitationSource.findUnique({ where: { episodeId_sourceKey: { episodeId, sourceKey } } });
  if (row && row.identityScopeHash !== scopeHash) return reject();
  if (!row) {
    const maximum = await tx.episodeCitationSource.aggregate({ where: { episodeId }, _max: { ordinal: true } });
    row = await tx.episodeCitationSource.create({ data: { episodeId, representativeId: authority.scope.representativeId, identityScopeHash: scopeHash,
      ordinal: (maximum._max.ordinal ?? 0) + 1, sourceKey, sourceKind: version.sourceKind, coordinate: version.coordinate,
      versionKey: version.versionKey, contentHash: version.contentHash, metadata: version.metadata } });
  }
  const current = bindings(authority.snapshot);
  current[String(row.ordinal)] = { sourceId: row.id, identityScopeHash: scopeHash, acquisition: version.acquisition };
  await tx.generationRun.update({ where: { id: input.runId }, data: {
    contextSnapshot: { ...authority.snapshot, [bindingKey]: current } as Prisma.InputJsonObject,
  } });
  return String(row.ordinal);
}

export function assertCitationRangeBounds(text: string, ranges: PersistedCitationRangeInput[]) {
  let previousEnd = 0;
  if (text.includes("\r") || ranges.length > 1024) return reject();
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previousEnd || range.end <= range.start
      || range.end > text.length || !range.sourceIds.length || new Set(range.sourceIds).size !== range.sourceIds.length
      || range.sourceIds.some(id => !/^[1-9]\d*$/u.test(id))) return reject();
    for (const offset of [range.start, range.end]) if (offset > 0 && offset < text.length
      && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!)) return reject();
    previousEnd = range.end;
  }
}

/** Called before completing the run, in the same transaction as Message.create.
 * Never infer dependencies from source titles or old message-level citations.
 */
export async function persistCitationRangesInTransaction(tx: Tx, input: { runId: string; messageId: string; text: string; ranges: PersistedCitationRangeInput[] }) {
  assertCitationRangeBounds(input.text, input.ranges);
  const authority = await citationAuthorityInTransaction(tx, input.runId);
  const scopeHash = identityHash(authority);
  const message = await tx.message.findFirst({ where: { id: input.messageId, conversationId: authority.scope.conversationId,
    episodeId: authority.scope.episodeId, senderType: "REPRESENTATIVE", redactedAt: null }, select: { text: true, content: true } });
  if (!message || message.text !== input.text) return reject();
  const current = bindings(authority.snapshot);
  const bodyHash = citationBodyHash(input.text);
  for (const [index, range] of input.ranges.entries()) {
    const sources: Array<{ sourceId: string; acquisition: CitationAcquisition }> = [];
    for (const number of range.sourceIds) {
      const binding = current[number];
      if (!binding || binding.identityScopeHash !== scopeHash) return reject();
      const acquisition = binding.acquisition;
      if (acquisition.kind === "memory") {
        if (!authority.memory.some(memory => memory.useRunId === acquisition.useRunId && memory.itemIds.includes(acquisition.itemId))) return reject();
      } else if (!authority.remote.some(remote => remote.executionId === acquisition.executionId && remote.revision === acquisition.revision && remote.toolName === acquisition.toolName)) return reject();
      const source = await tx.episodeCitationSource.findFirst({ where: { id: binding.sourceId, episodeId: authority.scope.episodeId!, ordinal: Number(number), identityScopeHash: scopeHash } });
      if (!source) return reject();
      sources.push(binding);
    }
    const stored = await tx.messageCitationRange.create({ data: { messageId: input.messageId, episodeId: authority.scope.episodeId!, ordinal: index + 1,
      start: range.start, end: range.end, bodyHash } });
    await tx.messageCitationRangeSource.createMany({ data: sources.map(source => ({
      rangeId: stored.id, episodeId: authority.scope.episodeId!, episodeSourceId: source.sourceId, acquisition: source.acquisition,
    })) });
  }
  const content = message.content && typeof message.content === "object" && !Array.isArray(message.content) ? message.content : {};
  return tx.message.update({ where: { id: input.messageId }, data: { content: { ...content,
    citationProtocol: "reference-v1", citationManifest: citationRangeManifest(input.text, input.ranges),
  } } });
}

/** Returns null for known but corrupt annotations; [] is a trusted empty set.
 * Authorization and any legacy dependencies remain a separate reader concern.
 */
export async function readCitationRangesInTransaction(tx: Tx, messageId: string, text: string) {
  const message = await tx.message.findUnique({ where: { id: messageId }, select: { text: true, content: true } });
  if (!message || message.text !== text) return null;
  const rows = await tx.messageCitationRange.findMany({ where: { messageId }, orderBy: { ordinal: "asc" }, include: { sources: { include: { source: true } } } });
  const ranges = rows.map(row => ({ start: row.start, end: row.end, sourceIds: row.sources.map(item => String(item.source.ordinal)) }));
  try {
    assertCitationRangeBounds(text, ranges);
    const content = message.content && typeof message.content === "object" && !Array.isArray(message.content) ? message.content : {};
    if (content.citationProtocol === "reference-v1") {
      if (citationFingerprint(content.citationManifest) !== citationFingerprint(citationRangeManifest(text, ranges))) return null;
    } else if (rows.length) return null;
    if (rows.some((row, index) => row.ordinal !== index + 1 || row.bodyHash !== citationBodyHash(text) || !row.sources.length
      || row.sources.some(item => item.episodeId !== row.episodeId || !acquisitionSchema.safeParse(item.acquisition).success))) return null;
  } catch { return null; }
  return rows;
}
