import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';
import { fixtureContextAuthority } from './context-authority-fixture';
function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const base = { runId: 'configuration', sessionId: 'configuration', executionProtocol: 'goal_v2' as const,
  reviewMode: 'selective_text_v2' as const, knowledgePrefetch: 'ordinary_questions_v1' as const,
  contextAuthorization: fixtureContextAuthority('configuration'),
  representative: { name: '测试代表', ownerName: '测试所有者', role: '地理教学', instructions: '语气简洁。', capabilities: ['MARKETING_LABEL_IS_NOT_TOOL_AUTHORITY'],
    agentBehavior: { version: 1 as const, answerScope: 'open_public' as const, knowledgePolicy: 'domain_first' as const, commitmentPolicy: 'information_only' as const } } };
const review = (topic = 'conversation') => fauxAssistantMessage(JSON.stringify({ verdict: 'complete', requiresEvidence: false,
  evidenceIds: [], missing: [], summary: '', responseKind: 'result', claimsSupported: true,
  policyCheck: { topic, withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' } }));

describe('configuration is a distinct evidence source for orientation', () => {
  it.each(['你好，你会什么', '请介绍你的功能和使用范围', 'What can you help me with?'])('provides the reviewer concrete configuration and actual catalog: %s', async userText => {
    const retrieve = vi.fn(async () => ({ status: 'not_found', text: 'No knowledge match' }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, capabilities: { knowledge: { retrieve } }, model: binding([
      fauxAssistantMessage('我是测试代表，可以帮你解释地理问题，也能在允许范围内回答其他公开问题、检索授权资料。'),
      context => {
        const input = JSON.parse(String(context.messages[0]?.content));
        expect(input.configurationEvidence.identity).toEqual({ name: '测试代表', ownerName: '测试所有者' });
        expect(input.configurationEvidence.answerPolicy.answerScope).toBe('open_public');
        expect(input.configurationEvidence.offeredTools.map((t: {name: string}) => t.name)).toEqual(['retrieve_authorized_knowledge']);
        expect(input.configurationEvidence).not.toHaveProperty('instructions');
        expect(JSON.stringify(input.configurationEvidence)).not.toContain('MARKETING_LABEL_IS_NOT_TOOL_AUTHORITY');
        expect(Object.keys(input.configurationEvidence.fileDeliveryLimits.formats)).not.toContain('pdf');
        return review();
      },
    ]) });
    expect(result.status).toBe('completed'); expect(result.modelCalls).toBe(2); expect(result.sources).toEqual([]);
    expect(retrieve).toHaveBeenCalledOnce();
  });
  it.each([
    ['查今天的股票价格', 'conversation'],
    ['使用沙盒浏览器查询公开页面', 'conversation'],
    ['你们的退款政策是什么', 'owner_fact'],
    ['亚洲地势有什么特点', 'specialty'],
  ])('does not use configuration as proof of a substantive result: %s', async (userText, topic) => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, maxSteps: 2,
      model: binding([fauxAssistantMessage('UNSUPPORTED_RESULT_999'), review(topic)]) });
    expect(result.status).not.toBe('completed'); expect(result.text).not.toContain('UNSUPPORTED_RESULT_999');
  });
});
