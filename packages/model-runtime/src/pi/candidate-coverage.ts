import { createHash } from 'node:crypto';
import type { PiToolObservation } from './types';

export type CandidateClause = { id: string; text: string };
export type ClauseCheck = {
  id: string;
  verdict: 'supported' | 'unsupported' | 'nonfactual';
  evidence?: Array<{ callId: string; quote: string }> | undefined;
  reason?: string | undefined;
};

/** Syntactic coverage, not claim extraction: keep every nonempty clause.
 * The full candidate remains available to interpret references/conditions.
 */
export function candidateClauses(candidate: string): CandidateClause[] {
  const revision = createHash('sha256').update(candidate).digest('hex').slice(0, 8);
  return candidate.split(/(?<=[。！？；;，])|\r?\n+|(?<=[.!?])\s+/u)
    .map(text => text.trim()).filter(Boolean)
    .map((text, index) => ({ id: `${revision}:${index + 1}`, text }));
}

const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
function visibleEvidence(o: PiToolObservation) {
  let page: unknown;
  try { page = JSON.parse(o.text); } catch { return normalize(o.text); }
  if (!page || typeof page !== 'object') return '';
  const p = page as Record<string, unknown>;
  // Raw HTML, serialized keys and unrelated receipt fields are not page facts.
  return [p.textSnippet, p.title, p.finalUrl, o.observation?.observedAt]
    .filter((v): v is string => typeof v === 'string').map(normalize).join('\n');
}

/** Ensures complete review coverage and authentic citations. Semantic
 * entailment still belongs to the reviewer: a real quote can be misinterpreted.
 */
export function checkCandidateCoverage(clauses: CandidateClause[], checks: ClauseCheck[] | undefined, observations: PiToolObservation[]) {
  const failures: string[] = [];
  const eligible = new Map(observations.filter(o => ['completed', 'succeeded', 'success', 'found'].includes(o.status)
    && (!o.observation || o.observation.state === 'available')).map(o => [o.callId, visibleEvidence(o)]));
  const byId = new Map<string, ClauseCheck>();
  const ids = new Set(clauses.map(c => c.id));
  for (const c of checks ?? []) {
    if (!ids.has(c.id) || byId.has(c.id)) failures.push(`Invalid or duplicate candidate clause review: ${c.id}.`);
    byId.set(c.id, c);
  }
  for (const clause of clauses) {
    const c = byId.get(clause.id);
    if (!c) { failures.push(`Unreviewed clause ${clause.id}: ${clause.text}`); continue; }
    if (c.verdict === 'unsupported') {
      failures.push(`Unsupported clause ${clause.id}: ${clause.text}${c.reason ? ` — ${c.reason}` : ''}`);
    } else if (c.verdict === 'supported') {
      if (!c.evidence?.length) failures.push(`Missing evidence for clause ${clause.id}: ${clause.text}`);
      for (const e of c.evidence ?? []) {
        const quote = normalize(e.quote);
        if (!quote || !eligible.get(e.callId)?.includes(quote)) failures.push(`Unverified citation for clause ${clause.id}: ${clause.text}`);
      }
    }
  }
  return failures;
}
