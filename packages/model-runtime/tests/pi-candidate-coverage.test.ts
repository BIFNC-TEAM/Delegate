import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { candidateClauses, checkCandidateCoverage, type ClauseCheck } from '../src/pi/candidate-coverage';
import { assessGoalCompletion } from '../src/pi/execution-state';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';
import type { PiToolObservation } from '../src/pi/types';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/partial-review-recorded.json', import.meta.url), 'utf8')) as {
  candidate: string; observations: PiToolObservation[]; rawReview: string; currentTime: string; goal: string;
};
const positive = JSON.parse(readFileSync(new URL('./fixtures/label-scope-recorded.json', import.meta.url), 'utf8')).cases[0] as {
  candidate: string; observations: PiToolObservation[]; rawReview: string;
};
const clauses = candidateClauses(recorded.candidate);
const page = recorded.observations[0]!;
const citations = ['iPhone Duo 新款', 'iPhone 18 Pro 新款', 'iPhone Air'].map(quote => ({ callId: page.callId, quote }));
const review = JSON.parse(recorded.rawReview);

describe('complete candidate coverage (offline protocol validation, not a live model evaluation)', () => {
  it('retains year, novelty and inference clauses, with no product-specific segmentation', () => {
    for (const fragment of ['2026年新发布', '首款可折叠', '符合“最新发布”的定义']) expect(clauses.some(c => c.text.includes(fragment))).toBe(true);
    expect(candidateClauses('方案甲为2028年新推出，首次提供该功能；排序靠前，所以排名第一。')).toHaveLength(4);
    expect(clauses.some(c => c.text.includes('15,999'))).toBe(true);
    expect(candidateClauses(recorded.candidate + '更正。')[0]!.id).not.toBe(clauses[0]!.id);
  });

  it('rejects the exact saved reviewer reply that checked only two labels', async () => {
    const f = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(f.provider);
    let actualInput: any; let checks: any;
    f.setResponses([context => { actualInput = JSON.parse(String(context.messages[0]?.content)); return fauxAssistantMessage(recorded.rawReview); }]);
    const r = await assessGoalCompletion({ run: { runId: 'coverage', sessionId: 'saved', userText: recorded.goal, currentTime: recorded.currentTime, representative: { name: '代表', role: '公开问答' }, model: { model: f.getModel(), modelId: f.getModel().id, provider: 'saved', streamFn: models.streamSimple.bind(models) } }, candidate: recorded.candidate, observations: recorded.observations, signal: AbortSignal.timeout(2000), onDiagnostics: d => { checks = d; } });
    expect(actualInput.candidate).toBe(recorded.candidate); expect(actualInput.candidateClauses).toEqual(clauses);
    expect(checks.modelAssessment.claimsSupported).toBe(true); // preserve the real false positive
    expect(checks.checks.sourceAttribution.failures).toEqual([]); // the two witnesses really are valid
    expect(r.releaseCandidate).toBe(false); expect(r.failureCodes).toContain('candidate_coverage');
    for (const fragment of ['2026年新发布', '首款可折叠', '符合“最新发布”的定义']) expect(r.missing.some(v => v.includes(fragment))).toBe(true);
  });

  it.each(['2026年新发布', '首款可折叠', '符合“最新发布”的定义'])('rejects a missing or explicitly unsupported clause: %s', fragment => {
    // Synthetic reviewer protocol controls, not new model judgements.
    const all: ClauseCheck[] = clauses.map(c => ({ id: c.id, verdict: 'supported', evidence: citations }));
    const target = clauses.find(c => c.text.includes(fragment))!;
    expect(checkCandidateCoverage(clauses, all.filter(c => c.id !== target.id), [page]).join(' ')).toContain(target.text);
    expect(checkCandidateCoverage(clauses, all.map(c => c.id === target.id ? { id: c.id, verdict: 'unsupported', reason: 'No source support for this assertion.' } : c), [page]).join(' ')).toContain(target.text);
  });

  it('rejects stale/duplicate IDs and forged or unselected evidence', () => {
    const one = candidateClauses('页面列出 iPhone Air。');
    const valid: ClauseCheck = { id: one[0]!.id, verdict: 'supported', evidence: [{ callId: page.callId, quote: 'iPhone Air' }] };
    expect(checkCandidateCoverage(one, [valid], [page])).toEqual([]);
    expect(checkCandidateCoverage(one, [valid, valid], [page]).length).toBeGreaterThan(0);
    expect(checkCandidateCoverage(one, [{ ...valid, id: 'old:1' }], [page]).length).toBeGreaterThan(0);
    expect(checkCandidateCoverage(one, [valid], [])).toHaveLength(1);
    expect(checkCandidateCoverage(one, [{ ...valid, evidence: [{ callId: page.callId, quote: 'fabricated quotation' }] }], [page])).toHaveLength(1);
  });

  it('does not ban years, firsts or ordering when the source actually states them', () => {
    const candidate = '方案甲于2028年发布，是本系列首款。发布顺序为甲、乙。';
    const body = '方案甲于2028年发布，是本系列首款。发布顺序为甲、乙。';
    const evidence: PiToolObservation = { callId: 'neutral', toolName: 'browse_in_sandbox', status: 'completed',
      text: JSON.stringify({textSnippet: body}), observation: {state:'available'}, sources: [], artifacts: [] };
    const units = candidateClauses(candidate);
    expect(checkCandidateCoverage(units, units.map(c => ({id:c.id,verdict:'supported',evidence:[{callId:'neutral',quote:body}]})), [evidence])).toEqual([]);
    const withOffer = candidateClauses(candidate + '\n需要的话可以继续查看。');
    expect(checkCandidateCoverage(withOffer, withOffer.map((c,i) => i === withOffer.length - 1
      ? {id:c.id,verdict:'nonfactual'} : {id:c.id,verdict:'supported',evidence:[{callId:'neutral',quote:body}]}), [evidence])).toEqual([]);
  });

  it('preserves a supported saved natural answer, using a human-authored complete review control', async () => {
    const o = positive.observations[0]!; const body = JSON.parse(o.text); delete body.contentSnippet;
    const f = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(f.provider);
    const annotated = { ...JSON.parse(positive.rawReview), clauseChecks: candidateClauses(positive.candidate).map(c => ({ id: c.id, verdict: 'supported', evidence: ['iPhone Duo 新款', 'iPhone 18 Pro 新款', 'iPhone Air'].map(quote => ({ callId: o.callId, quote })) })) };
    f.setResponses([fauxAssistantMessage(fauxToolCall('browse_in_sandbox', { url: body.finalUrl }, { id: o.callId }), { stopReason: 'toolUse' }), fauxAssistantMessage(positive.candidate), fauxAssistantMessage(JSON.stringify(annotated))]);
    const browse = vi.fn(async () => ({ status: 'completed', text: JSON.stringify(body), observation: { state: 'available' as const } }));
    const r = await new DelegatePiAgentRuntime().run({ runId: 'positive-coverage', sessionId: 'saved', userText: recorded.goal, executionProtocol: 'goal_v2', maxSteps: 3, representative: { name: '代表', role: '公开问答' }, model: { model: f.getModel(), modelId: f.getModel().id, provider: 'synthetic-review-control', streamFn: models.streamSimple.bind(models) }, capabilities: { sandbox: { execute: vi.fn(), browse } } });
    expect(r.text).toBe(positive.candidate); expect(r.status).toBe('completed'); expect(r.modelCalls).toBe(3); expect(browse).toHaveBeenCalledOnce();
    expect(r.spans.some(s => s.operation === 'source_excerpt_fallback')).toBe(false);
  });

  it('documents the remaining limit: exhaustive false semantic approvals are not a deterministic proof', () => {
    // This deliberately wrong synthetic reviewer covers every clause using
    // real but insufficient quotes. Coverage alone must not be sold as an
    // entailment engine. A live evaluator must detect this semantic failure.
    const dishonest: ClauseCheck[] = clauses.map(c => ({ id: c.id, verdict: 'supported', evidence: citations }));
    expect(checkCandidateCoverage(clauses, dishonest, [page])).toEqual([]);
    expect(review.claimsSupported).toBe(true);
  });
});
