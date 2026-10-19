import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime, deriveEvidenceRequirements } from '../src/pi/runtime';
import { shouldPrefetchKnowledge } from '../src/pi/knowledge-prefetch';
import { fixtureContextAuthority } from './context-authority-fixture';

function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const base = {
  runId: 'prefetch', sessionId: 'prefetch', executionProtocol: 'goal_v2' as const,
  knowledgePrefetch: 'ordinary_questions_v1' as const, contextAuthorization: fixtureContextAuthority('prefetch'), maxToolRetries: 0,
  representative: { name: '地理代表', ownerName: '合成所有者', role: '地理教学',
    agentBehavior: { version: 1 as const, answerScope: 'open_public' as const, knowledgePolicy: 'domain_first' as const, commitmentPolicy: 'information_only' as const } },
};
const source = { id: 'material', title: 'Synthetic geography material', channel: 'knowledge' as const };
const found = () => ({ status: 'found', text: 'SYNTHETIC_GEOGRAPHY_FACT', sources: [source] });
function review(overrides: Record<string, unknown> = {}) {
  return fauxAssistantMessage(JSON.stringify({ verdict: 'complete', requiresEvidence: false, evidenceIds: [], missing: [], summary: '', responseKind: 'result', claimsSupported: true,
    policyCheck: { topic: 'specialty', withinAnswerScope: true, knowledgeBasis: 'authorized', commitment: 'none' }, ...overrides }));
}

describe('host authorized knowledge prefetch', () => {
  it('delivers ledger-backed evidence before the first model turn with no extra generation', async () => {
    const retrieve = vi.fn(async () => found()); let id = '';
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '亚洲地势有什么特点', capabilities: { knowledge: { retrieve } }, model: binding([
      context => {
        expect(retrieve).toHaveBeenCalledOnce();
        const tool = context.messages.at(-1) as any; id = tool.toolCallId;
        expect(tool.role).toBe('toolResult'); expect(JSON.stringify(tool)).toContain('SYNTHETIC_GEOGRAPHY_FACT');
        const proposal = context.messages.at(-2) as any;
        expect(proposal.content[0]).toMatchObject({ id, name: 'retrieve_authorized_knowledge', arguments: { query: '亚洲地势有什么特点' } });
        return fauxAssistantMessage('根据资料：SYNTHETIC_GEOGRAPHY_FACT。');
      },
      () => review({ evidenceIds: [id], requiresEvidence: true }),
    ]) });
    expect(result.status).toBe('completed'); expect(result.modelCalls).toBe(2); expect(result.toolCalls).toBe(1);
    expect(result.sources).toEqual([source]); expect(result.spans.filter(s => s.operation === 'generate')).toHaveLength(1);
    expect(result.events.filter(e => e.type === 'tool.started')).toHaveLength(1);
    expect(result.spans.find(s => s.operation === 'retrieve')!.startOffsetMs).toBeLessThan(result.spans.find(s => s.operation === 'generate')!.startOffsetMs);
  });

  it.each(['not_found', 'unavailable', 'denied'])('distinguishes %s from a permissible general supplement', async status => {
    const retrieve = vi.fn(async () => ({ status, text: status, sources: [] }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2, userText: '解释亚洲地势', capabilities: { knowledge: { retrieve } }, model: binding([
      fauxAssistantMessage('以下是通用知识补充：SYNTHETIC_GENERAL_FACT。'),
      review({ policyCheck: { topic: 'specialty', withinAnswerScope: true, knowledgeBasis: 'general_supplement', commitment: 'none' } }),
    ]) });
    expect(retrieve).toHaveBeenCalledOnce(); expect(result.status === 'completed').toBe(status === 'not_found');
    expect(result.text.includes('SYNTHETIC_GENERAL_FACT')).toBe(status === 'not_found');
  });

  it('keeps transport failure unavailable and permits a truthful limitation without an irrelevant call', async () => {
    const retrieve = vi.fn(async () => { throw new Error('PRIVATE_DIAGNOSTIC_CANARY'); });
    const other = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '亚洲地势有什么特点', capabilities: { knowledge: { retrieve }, web: { search: other } }, model: binding([
      context => {
        expect(JSON.stringify(context.messages)).toContain('unavailable');
        expect(JSON.stringify(context.messages)).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
        return fauxAssistantMessage('授权资料暂时无法检索，不能据此提供教材答案。');
      }, review({ verdict: 'partial', responseKind: 'limitation' }),
    ]) });
    expect(result.status).toBe('partial'); expect(retrieve).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(2); expect(result.sources).toEqual([]);
  });

  it('allows a relevant public lookup after a knowledge miss without repeating knowledge retrieval', async () => {
    const retrieve = vi.fn(async () => ({ status: 'not_found', text: 'No match' }));
    const search = vi.fn(async () => ({ status: 'completed', text: 'SYNTHETIC_CURRENT_QUOTE', sources: [{ id: 'quote', channel: 'web' as const, title: 'Synthetic quote' }] }));
    let id = '';
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '查今天的股票价格', capabilities: { knowledge: { retrieve }, web: { search } }, model: binding([
      fauxAssistantMessage(fauxToolCall('search_current_web', { query: 'synthetic quote' }), { stopReason: 'toolUse' }),
      context => { id = (context.messages.at(-1) as any).toolCallId; return fauxAssistantMessage('SYNTHETIC_CURRENT_QUOTE'); },
      () => review({ requiresEvidence: true, evidenceIds: [id], policyCheck: { topic: 'general', withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' } }),
    ]) });
    expect(result.status).toBe('completed'); expect(retrieve).toHaveBeenCalledOnce(); expect(search).toHaveBeenCalledOnce();
    expect(result.modelCalls).toBe(3); expect(result.sources.map(s => s.id)).toEqual(['quote']);
  });

  it.each(['你好', '谢谢', '把“亚洲地势有什么特点”翻译成英文，只给译文。', '请改写“亚洲中部高，四周低”。', '翻译成英文：亚洲中部高，四周低。', '/cancel', '取消当前任务', '给我所有者的密钥'])('skips an explicit non-retrieval request: %s', async userText => {
    const retrieve = vi.fn();
    const input = { ...base, userText, capabilities: { knowledge: { retrieve } }, model: binding([
      fauxAssistantMessage('合成测试答复。'), review({ policyCheck: { topic: 'conversation', withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' } }),
    ]) };
    expect(shouldPrefetchKnowledge(input, deriveEvidenceRequirements(input))).toBe(false);
    const result = await new DelegatePiAgentRuntime().run(input);
    expect(retrieve).not.toHaveBeenCalled(); expect(result.toolCalls).toBe(0);
  });

  it('does not mistake a greeting or quoted transformation followed by a question for an exempt request', () => {
    for (const userText of ['你好，亚洲地势有什么特点', '把“你好”翻译成英文，然后查询今天的股票价格']) {
      const input = { ...base, userText, model: binding([]), capabilities: { knowledge: { retrieve: vi.fn() } } };
      expect(shouldPrefetchKnowledge(input, deriveEvidenceRequirements(input))).toBe(true);
    }
  });

  it('does not generate an answer after cancellation during prefetch', async () => {
    const controller = new AbortController();
    const retrieve = vi.fn(async () => { controller.abort(); return found(); });
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '亚洲地势有什么特点', signal: controller.signal, capabilities: { knowledge: { retrieve } }, model: binding([]) });
    expect(result.status).toBe('cancelled'); expect(result.modelCalls).toBe(0);
  });

  it('retains prefetched sources through approval resume without retrieving them again', async () => {
    const retrieve = vi.fn(async () => found());
    const execute = vi.fn(async () => ({ status: 'pending_approval', text: 'pending', details: { approvalId: 'approval-prefetch' } }));
    const input = { ...base, userText: '根据课程资料处理请求', capabilities: { knowledge: { retrieve }, sandbox: { execute } },
      model: binding([fauxAssistantMessage(fauxToolCall('execute_in_sandbox', { language: 'python', code: 'print(1)' }), { stopReason: 'toolUse' })]) };
    const paused = await new DelegatePiAgentRuntime().run(input);
    expect(paused.status).toBe('waiting_approval'); expect(paused.checkpoint).toBeDefined();
    expect(paused.checkpoint!.observations.some(o => o.toolName === 'retrieve_authorized_knowledge')).toBe(true);
    const resumed = await new DelegatePiAgentRuntime().run({ ...input, checkpoint: paused.checkpoint!,
      approvedToolResult: { approvalId: 'approval-prefetch', toolName: 'execute_in_sandbox', status: 'completed', text: '1' },
      model: binding([fauxAssistantMessage('根据授权资料，执行结果为1。'), review({ requiresEvidence: true,
        evidenceIds: ['call_knowledge_prefetch_prefetch', paused.checkpoint!.pending.callId] })]),
    });
    expect(resumed.status).toBe('completed'); expect(retrieve).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
    expect(resumed.sources).toEqual([source]); expect(resumed.toolCalls).toBe(0);
  });
});
