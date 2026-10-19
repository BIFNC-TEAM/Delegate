import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';

function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const f = fauxProvider({ tokensPerSecond: 100000 }); f.setResponses(responses);
  const models = createModels(); models.setProvider(f.provider);
  return { model: f.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: f.getModel().id };
}
const base = { runId: 'completion', sessionId: 'completion', executionProtocol: 'goal_v2' as const,
  userText: '请用浏览器读取 https://example.com 并给出标题和来源链接',
  representative: { name: '测试代表', role: '公开问答' } };
const answer = '标题为 Example。[来源](https://example.com)';
const cut = '标题为 Example。[来源](https://example.';
const call = () => fauxAssistantMessage(fauxToolCall('browse_in_sandbox', { url: 'https://example.com' }), { stopReason: 'toolUse' });
const review = (id: string, stopReason: 'stop' | 'length' = 'stop') => fauxAssistantMessage(JSON.stringify({
  verdict: 'complete', requiresEvidence: true, evidenceIds: [id], missing: [], summary: '', responseKind: 'result', claimsSupported: true,
}), { stopReason });
const capabilities = () => ({ sandbox: { execute: vi.fn(), browse: vi.fn(async () => ({ status: 'completed', text: 'Title: Example', sources: [{ id: 'page', title: 'Example', channel: 'web' as const, url: 'https://example.com' }] })) } });

describe('response completion before release (real Pi SDK, simulated provider)', () => {
  it('rewrites a length-truncated draft using existing evidence, then reviews the complete replacement', async () => {
    const caps = capabilities(); let id = ''; let correction = ''; let reviewCandidate = ''; let reviewed = 0;
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 5, capabilities: caps, model: binding([
      call(), ctx => { id = (ctx.messages.at(-1) as any).toolCallId; return fauxAssistantMessage(cut, { stopReason: 'length' }); },
      ctx => {
        // A truncated draft must not be offered to a permissive semantic reviewer.
        if (ctx.systemPrompt?.startsWith('You verify')) { reviewed++; return review(id); }
        correction = JSON.stringify(ctx.messages); return fauxAssistantMessage(answer);
      },
      ctx => { reviewed++; reviewCandidate = JSON.parse(String(ctx.messages[0]?.content)).candidate; return review(id); },
    ]) });
    expect(result.text).toBe(answer); expect(result.status).toBe('completed');
    expect(reviewed).toBe(1); expect(reviewCandidate).toBe(answer); expect(correction).toContain('truncated');
    expect(correction).toContain('Title: Example'); expect(correction).not.toContain(cut);
    expect(caps.sandbox.browse).toHaveBeenCalledOnce(); expect(result.toolCalls).toBe(1); expect(result.modelCalls).toBe(4);
    expect(result.spans.some(s => s.operation === 'generate' && s.status === 'error' && s.error === 'model_output_truncated')).toBe(true);
  });

  it.each([2, 3])('withholds an unfinished draft at a total budget of %i', async maxSteps => {
    const caps = capabilities(); let id = '';
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps, capabilities: caps, model: binding([
      call(), ctx => { id = (ctx.messages.at(-1) as any).toolCallId; return fauxAssistantMessage(cut, { stopReason: 'length' }); },
      ctx => ctx.systemPrompt?.startsWith('You verify') ? review(id) : fauxAssistantMessage(cut, { stopReason: 'length' }),
    ]) });
    expect(result.text).not.toContain(cut); expect(result.status).not.toBe('completed');
    expect(result.modelCalls).toBeLessThanOrEqual(maxSteps); expect(caps.sandbox.browse).toHaveBeenCalledOnce();
  });

  it('does not accept a length-truncated review even when its JSON parses as approval', async () => {
    let id = ''; const caps = capabilities();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, capabilities: caps, model: binding([
      call(), ctx => { id = (ctx.messages.at(-1) as any).toolCallId; return fauxAssistantMessage(answer); },
      () => review(id, 'length'),
    ]) });
    expect(result.text).not.toBe(answer); expect(result.status).not.toBe('completed');
    expect(result.spans.some(s => s.operation === 'goal_assessment' && s.status === 'error')).toBe(true);
    expect(caps.sandbox.browse).toHaveBeenCalledOnce();
  });

  it('bounds repeated truncation by the existing correction limit without repeating tools', async () => {
    const caps = capabilities();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 10, capabilities: caps, model: binding([
      call(), ...Array.from({ length: 3 }, () => fauxAssistantMessage(cut, { stopReason: 'length' })),
    ]) });
    expect(result.text).not.toContain(cut); expect(result.status).toBe('partial');
    expect(result.modelCalls).toBe(4); expect(caps.sandbox.browse).toHaveBeenCalledOnce();
    expect(result.spans.filter(s => s.operation === 'goal_assessment')).toHaveLength(0);
  });

  it('does not add calls for a normally completed response', async () => {
    let id = ''; const caps = capabilities();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, capabilities: caps, model: binding([
      call(), ctx => { id = (ctx.messages.at(-1) as any).toolCallId; return fauxAssistantMessage(answer); }, () => review(id),
    ]) });
    expect(result.text).toBe(answer); expect(result.status).toBe('completed'); expect(result.modelCalls).toBe(3);
  });
});
