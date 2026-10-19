import type { PiToolObservation } from './types';

export type SourceAttribution = { subject: string; attribute: string; unitId: string; present: boolean };
export type SourceUnit = { id: string; callId: string; kind: string; text: string };
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const labelingClaim = /标注|标记|标签|标为|\blabel(?:s|led|ed)?\b|\bmarked\b|\btagged\b/iu;

/** Only complete units from successful browser reads, not adjacent flat lines. */
export function sourceAttributionUnits(observations: PiToolObservation[]): SourceUnit[] {
  return observations.flatMap(o => {
    if (o.toolName !== 'browse_in_sandbox' || !['completed','succeeded','success'].includes(o.status)
      || o.observation?.state !== 'available') return [];
    let text: string;
    try { text = JSON.parse(o.text).textSnippet; } catch { return []; }
    if (typeof text !== 'string') return [];
    const units: SourceUnit[] = [];
    for (const line of text.split('\n')) {
      const match = /^\[(heading|link text)\] (".*")$/u.exec(line);
      if (!match) continue;
      try {
        const value: unknown = JSON.parse(match[2]!);
        if (typeof value !== 'string' || !value.trim()) continue;
        units.push({ id: `${o.callId}:unit_${units.length + 1}`, callId: o.callId, kind: match[1]!, text: value });
      } catch { /* Incomplete units are not evidence. */ }
    }
    return units;
  });
}

function contains(text: string, term: string) {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const termText = normalize(term);
  const left = /^[a-z0-9]/iu.test(termText) ? '(?<![a-z0-9])' : '';
  const right = /[a-z0-9]$/iu.test(termText) ? '(?![a-z0-9])' : '';
  return escaped.length > 0 && new RegExp(`${left}${escaped}${right}`, 'iu').test(normalize(text));
}

/** Enforce the reviewer's object/label witness; never manufacture an association. */
export function checkSourceAttributions(candidate: string, units: SourceUnit[], attributions?: SourceAttribution[]) {
  if (!units.length) return [];
  if (labelingClaim.test(candidate) && !attributions?.length) return ['The answer attributes a page label to an object but has no object/label source-unit witness.'];
  return (attributions ?? []).flatMap(a => {
    const unit = units.find(u => u.id === a.unitId);
    if (!contains(candidate, a.subject) || !contains(candidate, a.attribute)) return ['An attribution witness must quote the object and label actually mentioned in the answer.'];
    if (!unit || !contains(unit.text, a.subject) || contains(unit.text, a.attribute) !== a.present) {
      return [`The selected heading/link does not support ${JSON.stringify(a.subject)} ${a.present ? 'having' : 'lacking'} label ${JSON.stringify(a.attribute)}. Keep each label with its own object; do not borrow it from another unit.`];
    }
    return [];
  });
}

/** Bounded degradation after source-fidelity rejection: quote source units,
 * never rehabilitate the rejected assertion or infer a replacement label. */
export function sourceAttributionExcerpt(input: {
  candidate: string; observations: PiToolObservation[]; evidenceIds: string[];
  failureCodes: string[]; attributions?: SourceAttribution[]; language?: string;
}) {
  if ((!input.failureCodes.some(code => ['source_attribution_fidelity','source_date_fidelity'].includes(code)))
    || input.failureCodes.some(code => !['source_attribution_fidelity','source_date_fidelity','unsupported_candidate'].includes(code))
    || input.observations.some(o => !['browse_in_sandbox','retrieve_authorized_knowledge'].includes(o.toolName))) return;
  const units = sourceAttributionUnits(input.observations.filter(o => input.evidenceIds.includes(o.callId)));
  const selected: SourceUnit[] = [];
  for (const a of input.attributions ?? []) {
    const unit = units.find(u => u.id === a.unitId);
    if (!unit || !contains(input.candidate, a.subject) || !contains(unit.text, a.subject)
      || unit.text.length > 240 || selected.some(u => normalize(u.text) === normalize(unit.text))) continue;
    selected.push(unit);
    if (selected.length === 6) break;
  }
  // A rejected/missing unit witness is never repaired into an approved claim.
  // If the page itself was validly selected, a limited heading quotation is
  // still deliverable as a reading receipt, with no object/attribute inference.
  const headingsOnly = selected.length === 0;
  if (headingsOnly) selected.push(...units.filter(u => u.kind === 'heading' && u.text.length <= 240).slice(0, 6));
  if (!selected.length) return;
  const zh = input.language === 'zh';
  const quote = selected.map(u => `- ${JSON.stringify(u.text)}`).join('\n');
  return {
    text: (zh ? headingsOnly ? '本次未能核实完整结论。以下是所读取网页的标题原文（有限摘录）：\n\n' : '本次未能核实完整结论。以下仅引用所读取网页中的相关原文：\n\n' : 'The full conclusion could not be verified. These are quotations from the page read, not a verified conclusion:\n\n')
      + quote + (zh ? '\n\n以上是页面原文摘录，不据此补充未核实的归类或比较结论。' : '\n\nThese quotations do not establish additional classifications or comparisons.'),
    evidenceIds: [...new Set(selected.map(u => u.callId))],
  };
}

export const sourceAttributionInstructions = 'BROWSER EVIDENCE REVIEW: Review every server-supplied candidateClauses id in the context of the full answer. Return clauseChecks [{id,verdict,evidence:[{callId,quote}],reason}], one per id. verdict is supported only when evidence supports the ENTIRE clause, unsupported when any assertion or inference lacks support, or nonfactual for text making no factual claim. For supported clauses, quote the actual evidence verbatim and identify its observation callId; for unsupported clauses give a brief reason. A quote existing in a page is not itself proof of the inference. Overall claimsSupported cannot replace clause coverage. For object/label claims also return sourceAttributions [{subject,attribute,unitId,present}] using the separate sourceUnits: keep each label with its own object, split group assignments, and treat present=false only as absence within that unit. These label witnesses are supporting details, not a complete review of the answer.';
