/** Public presentation only. Never changes routing, evidence selection or review. */
export const publicAgentStages = [
  'processing', 'knowledge', 'knowledge_ready', 'knowledge_checked', 'search',
  'browser', 'mcp', 'compute', 'skills', 'generating', 'verifying', 'revising',
] as const;
export type PublicAgentStage = typeof publicAgentStages[number];
export type PublicAgentProgress = { sequence: number; stage: PublicAgentStage; startedAt: string; updatedAt: string };
export type PublicAnswerSource = {
  kind: 'web' | 'mcp'; title: string; url?: string; domain?: string;
  access?: 'page' | 'search'; observedAt?: string;
};

export function readPublicAgentProgress(value: unknown): PublicAgentProgress | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1
    || !publicAgentStages.includes(v.stage as PublicAgentStage)
    || typeof v.startedAt !== 'string' || !Number.isFinite(Date.parse(v.startedAt))
    || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt))) return;
  return { sequence: Number(v.sequence), stage: v.stage as PublicAgentStage, startedAt: v.startedAt, updatedAt: v.updatedAt };
}

function publicUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/iu.test(url.hostname)
      || /\.(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)
      || [...url.searchParams.keys()].some(key => /token|secret|password|signature|api.?key/iu.test(key))) return;
    url.hash = '';
    return url;
  } catch { return; }
}

/** Input MUST be the runtime's final selected evidence, never all tool attempts.
 * Knowledge titles are taken separately from the existing authorized citations. */
export function projectPublicAnswerSources(sources: ReadonlyArray<{
  channel: string; title: string; provider?: string; url?: string; observedAt?: string;
}>): PublicAnswerSource[] {
  const result: PublicAnswerSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const url = source.channel === 'web' ? publicUrl(source.url) : undefined;
    const provider = source.channel === 'mcp' && /^[\p{L}\p{N} ._-]{1,80}$/u.test(source.provider ?? '') ? source.provider : undefined;
    if (!url && !provider) continue;
    const key = url?.href ?? `mcp:${provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind: url ? 'web' : 'mcp',
      // Domain is unambiguous even when an untrusted page title is misleading.
      title: url ? url.hostname : provider!,
      ...(url ? { url: url.href, domain: url.hostname, access: source.provider === 'Tencent sandbox browser' ? 'page' as const : 'search' as const } : {}),
      ...(typeof source.observedAt === 'string' && Number.isFinite(Date.parse(source.observedAt)) ? { observedAt: new Date(source.observedAt).toISOString() } : {}),
    });
    if (result.length === 12) break;
  }
  return result;
}

export function readPublicAnswerSources(content: unknown): PublicAnswerSource[] {
  if (!content || typeof content !== 'object') return [];
  const sources = (content as Record<string, unknown>).publicSources;
  if (!Array.isArray(sources)) return [];
  // Revalidate persisted projection; never forward arbitrary content fields.
  return projectPublicAnswerSources(sources.flatMap(s => s && typeof s === 'object'
    && (s.kind === 'web' || s.kind === 'mcp') && typeof s.title === 'string'
    ? [{ channel: s.kind, title: s.title, provider: s.kind === 'mcp' ? s.title : s.access === 'page' ? 'Tencent sandbox browser' : undefined, url: s.url, observedAt: s.observedAt }] : []));
}
