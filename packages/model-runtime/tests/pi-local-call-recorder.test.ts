import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createLocalCallRecorder } from '../src/pi/local-call-recorder';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';

const dirs: string[] = [];
function directory() { const d = mkdtempSync(join(tmpdir(), 'delegate-calls-')); dirs.push(d); return d; }
function config(d: string) { return { DELEGATE_DIAGNOSTIC_DIR: d, DELEGATE_DIAGNOSTIC_CONVERSATION_ID: 'old-session', DELEGATE_DIAGNOSTIC_UNTIL: new Date(Date.now() + 60_000).toISOString() }; }
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('local model call recording', () => {
  it('is off by default and excludes other conversations and expired capture windows', () => {
    const d = directory(); const input = { runId: 'run', sessionId: 'old-session' };
    expect(createLocalCallRecorder(input, {})).toBeUndefined();
    expect(createLocalCallRecorder({ ...input, sessionId: 'other' }, config(d))).toBeUndefined();
    expect(createLocalCallRecorder(input, { ...config(d), DELEGATE_DIAGNOSTIC_UNTIL: '2000-01-01' })).toBeUndefined();
    expect(readdirSync(d)).toEqual([]);
  });

  it('records the actual observed provider path, checks and raw output without extra calls or public leakage', async () => {
    const d = directory(); Object.entries(config(d)).forEach(([k, v]) => vi.stubEnv(k, v));
    const f = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(f.provider);
    const rawReview = { verdict: 'complete', requiresEvidence: false, evidenceIds: [], missing: [], summary: 'PRIVATE_REVIEW_REASON', responseKind: 'result', claimsSupported: true };
    f.setResponses([fauxAssistantMessage('山地气温通常随海拔升高而下降。'), fauxAssistantMessage(JSON.stringify(rawReview))]);
    const observed = vi.fn(models.streamSimple.bind(models)); const unused = vi.fn(() => { throw new Error('wrong provider path'); });
    const result = await new DelegatePiAgentRuntime().run({ runId: 'recorded-run', sessionId: 'old-session', userText: '解释山地的气温变化', executionProtocol: 'goal_v2', representative: { name: '代表', role: '教学' }, model: { model: f.getModel(), modelId: f.getModel().id, provider: 'faux', streamFn: unused, createObservedStreamFn: () => observed } });
    expect(result.status).toBe('completed'); expect(result.modelCalls).toBe(2); expect(observed).toHaveBeenCalledTimes(2); expect(unused).not.toHaveBeenCalled();
    const files = readdirSync(d); expect(files).toHaveLength(1); const path = join(d, files[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const requests = records.filter(r => r.type === 'model_request'); const responses = records.filter(r => r.type === 'model_response');
    expect(requests.map(r => r.data.phase)).toEqual(['generate', 'review']);
    expect(responses.map(r => r.data.callId)).toEqual([1, 2]);
    expect(requests[0].data.context.systemPrompt).toContain('CURRENT TASK');
    expect(requests[1].data.context.messages[0].content).toContain('山地气温');
    expect(responses[1].data.message.content[0].text).toBe(JSON.stringify(rawReview));
    const check = records.find(r => r.type === 'review_checks');
    expect(check.data.modelAssessment.claimsSupported).toBe(true);
    expect(check.data.checks.sourceDate.deterministicFailures).toEqual([]);
    expect(records.find(r => r.type === 'review_decision').data.assessment.releaseCandidate).toBe(true);
    expect(JSON.stringify(result.spans)).not.toContain('PRIVATE_REVIEW_REASON');
    expect(result.text).not.toContain('PRIVATE_REVIEW_REASON');
  });

  it('keeps a malformed review and the exact schema issue instead of only a generic error code', async () => {
    const d = directory(); Object.entries(config(d)).forEach(([k, v]) => vi.stubEnv(k, v));
    const f = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(f.provider);
    const raw = '{"verdict":"complete"}';
    f.setResponses([fauxAssistantMessage('山地气温通常随海拔升高而下降。'), fauxAssistantMessage(raw)]);
    const result = await new DelegatePiAgentRuntime().run({ runId: 'malformed-review', sessionId: 'old-session', userText: '解释山地的气温变化', executionProtocol: 'goal_v2', representative: { name: '代表', role: '教学' }, model: { model: f.getModel(), modelId: f.getModel().id, provider: 'faux', streamFn: models.streamSimple.bind(models) } });
    expect(result.modelCalls).toBe(2); expect(result.status).not.toBe('completed');
    const records = readFileSync(join(d, readdirSync(d)[0]!), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(r => r.type === 'model_response').at(-1).data.message.content[0].text).toBe(raw);
    expect(records.find(r => r.type === 'review_checks').data.parseFailure.some((issue: { path: string[] }) => issue.path.includes('claimsSupported'))).toBe(true);
    expect(records.some(r => r.type === 'review_error')).toBe(true);
  });
});
