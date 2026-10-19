import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';
import type { PiToolObservation } from '../src/pi/types';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/label-scope-recorded.json', import.meta.url), 'utf8')) as {
  cases: Array<{ id: string; candidate: string; rawReview: string; expectedRelease: boolean; observations: PiToolObservation[] }>;
};
afterEach(() => vi.unstubAllEnvs());
describe('saved label evidence and unmodified model replies (no external service)', () => {
  it.each(fixture.cases)('$id', async sample => {
    const directory = mkdtempSync(join(tmpdir(), 'delegate-recorded-'));
    try {
      vi.stubEnv('DELEGATE_DIAGNOSTIC_DIR', directory);
      vi.stubEnv('DELEGATE_DIAGNOSTIC_CONVERSATION_ID', 'recorded-session');
      vi.stubEnv('DELEGATE_DIAGNOSTIC_UNTIL', new Date(Date.now() + 60_000).toISOString());
      const saved = sample.observations[0]!;
      // The live worker excludes raw HTML before returning a browser result.
      // Older direct assessor fixtures also stored that HTML; reproduce the
      // worker projection so the runtime does not truncate its JSON at 24k.
      const page = JSON.parse(saved.text); delete page.contentSnippet;
      const o = { ...saved, text: JSON.stringify(page) };
      const provider = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(provider.provider);
      provider.setResponses([
        fauxAssistantMessage(fauxToolCall('browse_in_sandbox', { url: JSON.parse(o.text).finalUrl }, { id: o.callId }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(sample.candidate), fauxAssistantMessage(sample.rawReview),
      ]);
      const browse = vi.fn(async () => ({ status: o.status, text: o.text, artifacts: o.artifacts, sources: o.sources, ...(o.observation ? { observation: o.observation } : {}) }));
      const r = await new DelegatePiAgentRuntime().run({ runId: sample.id, sessionId: 'recorded-session', userText: '苹果最新款手机是哪个型号', executionProtocol: 'goal_v2', conversationContextMode: 'focused_v1', responseLanguage: 'zh', currentTime: '2026-10-14T03:56:55.378Z', timezone: 'Asia/Shanghai', maxSteps: 3, representative: { name: '代表', role: '公开问答' }, model: { model: provider.getModel(), modelId: provider.getModel().id, provider: 'saved-qwen-response', streamFn: models.streamSimple.bind(models) }, capabilities: { sandbox: { execute: vi.fn(), browse } } });
      expect(r.modelCalls).toBe(3); expect(browse).toHaveBeenCalledOnce(); expect(r.error).toBeUndefined();
      // Neither legacy response supplies complete clause coverage. Even a
      // correct old candidate must not bypass the new review contract.
      expect(r.text).not.toBe(sample.candidate); expect(r.status).toBe('partial');
      expect(r.spans.some(s => s.operation === 'review_failure' && s.purpose?.includes('candidate_coverage'))).toBe(true);
      const records = readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.filter(r => r.type === 'model_request')).toHaveLength(3);
      expect(records.filter(r => r.type === 'model_response').at(-1).data.message.content[0].text).toBe(sample.rawReview);
      const check = records.find(r => r.type === 'review_checks').data;
      // Preserve the model's false positive; the host must still reject it.
      expect(check.modelAssessment.claimsSupported).toBe(true);
      expect(check.checks.sourceAttribution.failures.length > 0).toBe(!sample.expectedRelease);
      if (!sample.expectedRelease) expect(check.checks.sourceAttribution.failures.join(' ')).toContain('does not support');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
