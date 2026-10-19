import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentContextAuthorizationError } from '@delegate/runtime';
import { DelegatePiAgentRuntime, type PiAgentRunInput } from '../src/pi';
import { fixtureContextAuthority } from './context-authority-fixture';

function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const base = { runId: 'simple', sessionId: 'session', executionProtocol: 'goal_v2' as const, reviewMode: 'simple_text_v1' as const,
  contextAuthorization: fixtureContextAuthority('simple'),
  representative: { name: '代表', ownerName: '测试老师', role: '地理代表',
    agentBehavior: { version: 1 as const, answerScope: 'open_public' as const, knowledgePolicy: 'owner_facts' as const, commitmentPolicy: 'information_only' as const } } };
const review = (extra: Record<string, unknown> = {}) => fauxAssistantMessage(JSON.stringify({ verdict: 'complete', responseKind: 'result', claimsSupported: true,
  evidenceIds: [], requiresEvidence: false, missing: [], summary: '', policyCheck: { topic: 'general', withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' }, ...extra }));
const fast = (result: Awaited<ReturnType<DelegatePiAgentRuntime['run']>>) => result.spans.some(s => s.operation === 'simple_text_release');

// Real Pi execution, scripted model/adapter transport. Assertions cover model requests and final release.
describe('opt-in standalone simple text', () => {
  it.each([
    ['你好', '你好！有什么我可以帮你的吗？'],
    ['Hi!', 'Hi! How can I help you today?'],
    ['你好', '你好！我是代表，由测试老师授权的数字代表。有什么地理相关的问题或需要帮助的地方吗？'],
    ['你好', '我是代表，由测试老师授权的数字代表。请问有什么地理相关的问题我可以帮您解答？'],
    ['Hello!', 'Hello! How can I assist you with geography today?'],
    ['把“今天股票市场休市”翻译成英文，只给译文。', 'The stock market is closed today.'],
    ['Translate "Please close the window." into Chinese.', '请关上窗户。'],
  ])('uses one generation, no reviewer or tool for %s', async (userText, candidate) => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, model: binding([fauxAssistantMessage(candidate), review()]) });
    expect(result.status).toBe('completed'); expect(result.text).toBe(candidate);
    expect(result.modelCalls).toBe(1); expect(result.toolCalls).toBe(0); expect(fast(result)).toBe(true);
    expect(result.spans.some(s => s.operation === 'goal_assessment')).toBe(false);
  });

  it('works with a one-turn budget without manufacturing a semantic review result', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', maxSteps: 1, model: binding([fauxAssistantMessage('你好！')]) });
    expect(result.status).toBe('completed'); expect(result.modelCalls).toBe(1); expect(fast(result)).toBe(true);
  });

  it.each(['你好，查今天杭州天气', '查下阿里今天的股票', '为什么山上更冷', '所有者的退款政策是什么',
    '把“今天休市”翻译成英文，再查询今天的天气。', '翻译成英文', '把上面的内容翻译成英文',
    '把“今天休市”翻译成法文。', '把“今天休市”翻译成英文并解释原因。', '取消任务',
    '使用沙盒浏览器获取腾讯股票信息', '把“你好”翻译成英文，生成result.txt文件。'])('does not optimize an ambiguous, contextual or evidence task: %s', async userText => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, maxSteps: 2,
      model: binding([fauxAssistantMessage('需要进一步信息。'), review({ verdict: 'waiting_user', responseKind: 'clarification' })]) });
    expect(result.modelCalls).toBe(2); expect(fast(result)).toBe(false);
  });

  it.each([
    { history: [{ role: 'user' as const, text: '先前问题' }] },
    { attachments: [{ id: 'file', fileName: 'data.csv', mimeType: 'text/csv', sizeBytes: 10 }] },
    { evidenceRequirements: { evidence: true } },
    { evidenceRequirements: { browser: true } },
    { approvedToolResult: { approvalId: 'approval', toolName: 'execute_in_sandbox', status: 'completed' as const, text: '1' } },
    { reviewMode: 'always' as const },
    { reviewMode: undefined },
  ])('retains full review with additional state or without opt-in: %j', async extra => {
    const input = { ...base, userText: '你好', maxSteps: 2, model: binding([fauxAssistantMessage('你好！'), review()]), ...extra } as PiAgentRunInput;
    const result = await new DelegatePiAgentRuntime().run(input);
    expect(result.modelCalls).toBe(2); expect(fast(result)).toBe(false);
  });

  it.each([
    { ...base.representative, agentBehavior: undefined },
    { ...base.representative, agentBehavior: { ...base.representative.agentBehavior, answerScope: 'owner_and_domain' as const } },
    { ...base.representative, agentBehavior: { ...base.representative.agentBehavior, knowledgePolicy: 'domain_only' as const } },
  ])('keeps translation scope governed by the published policy', async representative => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, representative, userText: '把“你好”翻译成英文。',
      model: binding([fauxAssistantMessage('Hello.'), review()]), maxSteps: 2 } as PiAgentRunInput);
    expect(result.modelCalls).toBe(2); expect(fast(result)).toBe(false);
  });

  it.each([
    ['你好', '你好，退款已经完成。'],
    ['你好', '你好！我是另一位所有者授权的代表。有什么可以帮你的吗？'],
    ['你好', '你好！我是代表，由测试老师授权的数字代表。退款已经完成。'],
    ['把“你好”翻译成英文。', '这句话可以翻译为Hello。'],
    ['把“你好”翻译成英文。', 'Download the result at https://example.invalid/file.'],
    ['把“你好”翻译成英文。', 'Download [result](/download/unverified).'],
    ['把“你好”翻译成英文。', ''],
  ])('falls back when the candidate is outside the narrow output shape: %s', async (userText, candidate) => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, maxSteps: 2,
      model: binding([fauxAssistantMessage(candidate), review({ claimsSupported: false, verdict: 'continue' })]) });
    expect(result.status).not.toBe('completed'); expect(fast(result)).toBe(false);
    expect(result.modelCalls).toBe(2);
  });

  it('retains full review after a real tool call even for an initially simple request', async () => {
    const retrieve = vi.fn(async () => ({ status: 'found', text: '资料', sources: [{ id: 'knowledge', title: '资料', channel: 'knowledge' as const }] }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', capabilities: { knowledge: { retrieve } },
      model: binding([fauxAssistantMessage(fauxToolCall('retrieve_authorized_knowledge', { query: '资料' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('你好！'), review({ responseKind: 'limitation', verdict: 'partial' })]) });
    expect(retrieve).toHaveBeenCalledOnce(); expect(result.modelCalls).toBe(3); expect(fast(result)).toBe(false);
  });

  it('keeps an approval pause and its resumed answer on the existing path', async () => {
    const execute = vi.fn(async () => ({ status: 'pending_approval', text: 'pending', details: { approvalId: 'approval' } }));
    const first = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', capabilities: { sandbox: { execute } },
      model: binding([fauxAssistantMessage(fauxToolCall('execute_in_sandbox', { language: 'python', code: 'print(1)' }), { stopReason: 'toolUse' })]) });
    expect(first.status).toBe('waiting_approval'); expect(fast(first)).toBe(false);
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', checkpoint: first.checkpoint!,
      approvedToolResult: { approvalId: 'approval', toolName: 'execute_in_sandbox', status: 'completed', text: '1' },
      capabilities: { sandbox: { execute } }, model: binding([fauxAssistantMessage('你好！'), review({ responseKind: 'limitation', verdict: 'partial' })]) });
    expect(result.modelCalls).toBe(2); expect(fast(result)).toBe(false); expect(execute).toHaveBeenCalledOnce();
  });

  it('does not bypass the current authorization check before release', async () => {
    const check = vi.fn(async (boundary: string) => { if (boundary === 'release') throw new AgentContextAuthorizationError(); });
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好',
      contextAuthorization: { ...base.contextAuthorization, check }, model: binding([fauxAssistantMessage('你好！')]) });
    expect(check).toHaveBeenCalledWith('release', undefined);
    expect(result.contextAuthorizationBlocked).toBe(true); expect(result.text).not.toBe('你好！');
  });

  it('does not treat free-form persona text as an authorized fact in a greeting', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base,
      representative: { ...base.representative, role: '已为你完成退款' }, userText: '你好', maxSteps: 2,
      model: binding([fauxAssistantMessage('你好！我是代表，测试老师授权的已为你完成退款。'), review({ claimsSupported: false, verdict: 'continue' })]) });
    expect(fast(result)).toBe(false); expect(result.status).not.toBe('completed');
    expect(result.text).not.toContain('已为你完成退款');
  });

  it('does not use the shortcut for a truncated generation', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好',
      model: binding([fauxAssistantMessage('你好！', { stopReason: 'length' }), fauxAssistantMessage('你好！'), review()]) });
    expect(fast(result)).toBe(false); expect(result.modelCalls).toBe(3);
    expect(result.text).toBe('你好！'); expect(result.status).toBe('completed');
  });

  it('does not report successful fast completion after cancellation', async () => {
    const controller = new AbortController();
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', signal: controller.signal,
      model: binding([() => { controller.abort(); return fauxAssistantMessage('你好！'); }]) });
    expect(result.status).toBe('cancelled'); expect(fast(result)).toBe(false);
  });
});
