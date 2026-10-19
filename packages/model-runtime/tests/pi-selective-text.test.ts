import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentContextAuthorizationError } from '@delegate/runtime';
import { DelegatePiAgentRuntime, deriveEvidenceRequirements } from '../src/pi/runtime';
import { selectSelectiveTextTask, selectiveTextSourceId } from '../src/pi/selective-text';
import { fixtureContextAuthority } from './context-authority-fixture';

function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const base = {
  runId: 'selective', sessionId: 'selective', executionProtocol: 'goal_v2' as const,
  reviewMode: 'selective_text_v2' as const, knowledgePrefetch: 'ordinary_questions_v1' as const,
  contextAuthorization: fixtureContextAuthority('selective'),
  representative: { name: '代表', ownerName: '测试老师', role: '地理代表',
    agentBehavior: { version: 1 as const, answerScope: 'open_public' as const, knowledgePolicy: 'domain_first' as const, commitmentPolicy: 'information_only' as const } },
};
function envelope(userText: string, answer: string, extra: Record<string, unknown> = {}) {
  const input = { ...base, userText, model: binding([]) };
  const task = selectSelectiveTextTask(input, deriveEvidenceRequirements(input))!;
  return JSON.stringify({ taskType: task.kind, needsVerification: false, sourceId: selectiveTextSourceId(task), answer, ...extra });
}
const failedReview = () => fauxAssistantMessage(JSON.stringify({ verdict: 'continue', requiresEvidence: false, evidenceIds: [], missing: ['unsupported candidate'], summary: '', responseKind: 'result', claimsSupported: false,
  policyCheck: { topic: 'general', withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' } }));
const fast = (r: Awaited<ReturnType<DelegatePiAgentRuntime['run']>>) => r.spans.some(s => s.operation === 'simple_text_release');

describe('selective review for independent low-impact text', () => {
  it.each([
    ['你好', '你好，我在。有什么想聊的吗？'],
    ['你好', '我是代表，由测试老师授权的数字代表。请问有什么地理相关的问题，我可以帮您解答？'],
    ['哈喽呀！', '哈喽！今天想聊点什么？'],
    ['谢谢', '不客气，很高兴能帮到你。'],
    ['把“你好，欢迎来到这里”翻译成英文，只给译文。', 'Hello, welcome here.'],
    ['翻译成英文：很高兴见到你。', 'It is nice to meet you.'],
    ['Translate "Good morning." into French.', 'Bonjour.'],
    ['把“这句话写得有点绕，可以更清楚。”润色得更自然。', '这句话可以写得更清楚。'],
    ['改写：今天的风吹过树梢，树叶轻轻摇晃。', '风掠过树梢，叶子轻轻摇曳。'],
  ])('releases natural wording in one call without exposing metadata: %s', async (userText, answer) => {
    const retrieve = vi.fn(); const listTools = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText,
      capabilities: { knowledge: { retrieve }, mcp: { listTools, callTool: vi.fn() } },
      history: [{ role: 'user', text: 'UNNEEDED_HISTORY_CANARY' }, { role: 'assistant', text: 'Prior answer' }],
      model: binding([context => {
        expect(context.tools ?? []).toHaveLength(0); expect(JSON.stringify(context.messages)).not.toContain('UNNEEDED_HISTORY_CANARY');
        return fauxAssistantMessage(envelope(userText, answer));
      }]),
    });
    expect(result.status).toBe('completed'); expect(result.text).toBe(answer); expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(0); expect(fast(result)).toBe(true); expect(retrieve).not.toHaveBeenCalled(); expect(listTools).not.toHaveBeenCalled();
    expect(result.spans.some(s => s.operation === 'goal_assessment')).toBe(false);
  });

  it.each([
    '你好，查今天的天气', '亚洲地势有什么特点', '你们的退款政策是什么',
    '把“你好”翻译成英文，再查询今天的天气。', '按照上面的要求润色“你好”。',
    '把“退款金额是100元。”翻译成英文。', '把“我们保证全额退款。”改写得更自然。',
    '把“你好”翻译成英文并生成result.txt文件。', '把“你好”翻译一下。', '取消订单',
  ])('cannot use model self-classification to skip required review: %s', userText => {
    const input = { ...base, userText, model: binding([]) };
    expect(selectSelectiveTextTask(input, deriveEvidenceRequirements(input))).toBeUndefined();
  });

  it.each([
    ['你好', '退款已经完成。', {}],
    ['你好', '你好，我是另一位所有者授权的代表。', {}],
    ['你好', '你好！根据知识库资料，你的权益已生效。', {}],
    ['你好', '已生成文件：https://example.invalid/result.txt', {}],
    ['你好', '你好！', { needsVerification: true }],
    ['你好', '你好！', { taskType: 'other' }],
    ['把“你好”翻译成英文。', 'Hello.', { sourceId: 'wrong-source' }],
    ['把“你好”翻译成英文。', '你好。', {}],
  ])('falls back on content risks or inconsistent metadata instead of trusting a simple label', async (userText, answer, extra) => {
    let reviewedCandidate = '';
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, maxSteps: 2,
      model: binding([fauxAssistantMessage(envelope(userText, answer, extra)), context => {
        reviewedCandidate = JSON.parse(String(context.messages[0]?.content)).candidate;
        return failedReview();
      }]),
    });
    expect(result.modelCalls).toBe(2); expect(fast(result)).toBe(false); expect(result.status).not.toBe('completed');
    expect(reviewedCandidate).toBe(answer); expect(result.text).not.toContain('sourceId');
  });

  it('does not take the shortcut for truncated generation', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', maxSteps: 1,
      model: binding([fauxAssistantMessage(envelope('你好', '你好！'), { stopReason: 'length' })]) });
    expect(fast(result)).toBe(false); expect(result.status).not.toBe('completed');
  });

  it('retains authorization revalidation at release', async () => {
    const check = vi.fn(async (boundary: string) => { if (boundary === 'release') throw new AgentContextAuthorizationError(); });
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '你好', contextAuthorization: { ...base.contextAuthorization, check },
      model: binding([fauxAssistantMessage(envelope('你好', '你好！'))]) });
    expect(result.contextAuthorizationBlocked).toBe(true); expect(result.text).not.toBe('你好！');
  });

  it('keeps explicit evidence, attachments and scoped transformations on the full path', () => {
    for (const extra of [{ evidenceRequirements: { evidence: true } }, { attachments: [{ id: 'f', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 2 }] },
      { representative: { ...base.representative, agentBehavior: { ...base.representative.agentBehavior, answerScope: 'owner_and_domain' as const } } }]) {
      const input = { ...base, userText: '把“你好”翻译成英文。', model: binding([]), ...extra };
      expect(selectSelectiveTextTask(input, deriveEvidenceRequirements(input))).toBeUndefined();
    }
  });
});
