import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime, deriveEvidenceRequirements } from '../src/pi/runtime';
import { currentRequestContext, containsReference, resolveReplyLanguage, reviewConversationContext } from '../src/pi/conversation-context';
import { assessGoalCompletion } from '../src/pi/execution-state';
import { fixtureContextAuthority } from './context-authority-fixture';
function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const history = [
  { role: 'user' as const, text: '今天基金的行情如何' },
  { role: 'assistant' as const, text: '请告诉我您关注的基金名称或代码。' },
];
const base = { runId: 'followup', sessionId: 'followup', executionProtocol: 'goal_v2' as const,
  knowledgePrefetch: 'ordinary_questions_v1' as const, responseLanguage: 'zh', history,
  contextAuthorization: fixtureContextAuthority('followup'), userText: '000001',
  representative: { name: '测试代表', ownerName: '合成所有者', role: '地理教学',
    agentBehavior: { version: 1 as const, answerScope: 'open_public' as const, knowledgePolicy: 'domain_first' as const, commitmentPolicy: 'information_only' as const } } };
function review(ids: string[] = [], extra: Record<string, unknown> = {}) { return fauxAssistantMessage(JSON.stringify({ verdict: 'complete', responseKind: 'result', requiresEvidence: true, evidenceIds: ids, missing: [], summary: '', claimsSupported: true,
  policyCheck: { topic: 'general', withinAnswerScope: true, knowledgeBasis: 'other', commitment: 'none' }, ...extra })); }

describe('authorized follow-up context shared by generation and review', () => {
  it('anchors a code to the nearest request rather than older geography/material questions', async () => {
    const prior = ['你有可下载的公开资料吗', '亚洲地势有什么特点', '基金今天的行情如何'].map(text => ({ role: 'user' as const, text }));
    const retrieve = vi.fn(async (_input: {query:string}) => ({status:'not_found',text:'No matching materials.'}));
    await new DelegatePiAgentRuntime().run({...base,userText:'110011',history:prior,capabilities:{knowledge:{retrieve}},
      model:binding([fauxAssistantMessage('暂未取得结果。'),review([],{verdict:'partial',responseKind:'limitation'})])});
    expect(retrieve.mock.calls[0]?.[0].query).toBe('基金今天的行情如何\n用户补充的标识或参数：110011');
    expect(currentRequestContext({...base,userText:'请介绍你们的项目',history:prior})).toBe('请介绍你们的项目');
  });
  it('does not approve a code-to-repository mapping using unrelated but authorized knowledge', async () => {
    const r=await assessGoalCompletion({run:{...base,userText:'110011',model:binding([review(['kb'],{requiresEvidence:false,policyCheck:{topic:'owner_fact',withinAnswerScope:true,knowledgeBasis:'authorized',commitment:'none'}})])},
      observations:[{callId:'kb',toolName:'retrieve_authorized_knowledge',status:'found',text:'资料目录：GitHub BIFNC-TEAM/Delegate。',sources:[{id:'kb-source',title:'资料目录',channel:'knowledge'}],artifacts:[]}],
      candidate:'110011 对应 BIFNC-TEAM/Delegate。',signal:AbortSignal.timeout(1000)});
    expect(r.releaseCandidate).toBe(false);expect(r.failureCodes).toContain('unsupported_reference_mapping');
  });
  it('matches exact identifiers in text without accepting a longer code',()=>{
    expect(containsReference('基金110011的资料','110011')).toBe(true);
    expect(containsReference('代码31100110','110011')).toBe(false);
  });
  it('keeps the current task after several successive identifier replies',()=>{
    const history=['基金今天的行情如何','000001','110011','000051'].map(text=>({role:'user' as const,text}));
    expect(deriveEvidenceRequirements({...base,history,userText:'110011',model:binding([])}).evidence).toBe(true);
    expect(currentRequestContext({...base,history,userText:'110011'})).toContain('基金今天的行情如何');
  });
  it('retains production user-only history even when the reply does not match a follow-up phrase', async () => {
    const prior = [{ role: 'user' as const, text: '我想了解今天某基金的行情' }];
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '华夏成长', history: prior, model: binding([
      context => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain(prior[0]!.text); expect(messages).toContain('context only');
        return fauxAssistantMessage('我会按前面的基金查询理解这个名称。');
      }, context => {
        expect(JSON.parse(String(context.messages[0]?.content)).conversationContext.messages).toEqual(prior);
        return review([], { verdict: 'partial', responseKind: 'limitation', requiresEvidence: false });
      },
    ]) });
    expect(result.modelCalls).toBe(2); expect(result.status).toBe('partial');
  });
  it('keeps the fund subject, language and current evidence requirement for a supplied code', async () => {
    let id = ''; const browse = vi.fn(async () => ({ status: 'completed', text: 'SYNTHETIC_FUND_VALUE', sources: [{ id: 'quote', title: 'Synthetic current fund quote', channel: 'web' as const, url: 'https://example.invalid/quote' }] }));
    const input = { ...base, capabilities: { knowledge: { retrieve: async () => ({ status: 'not_found', text: 'No authorized knowledge match.' }) }, sandbox: { execute: vi.fn(), browse } }, model: binding([
      context => {
        expect(JSON.stringify(context.messages)).toContain('今天基金的行情如何');
        expect(context.systemPrompt).toContain('Conversation reply language: Chinese');
        return fauxAssistantMessage(fauxToolCall('browse_in_sandbox', { url: 'https://example.invalid/quote' }), { stopReason: 'toolUse' });
      },
      context => { id = (context.messages.at(-1) as any).toolCallId; return fauxAssistantMessage('按前文的基金查询，取得合成结果：SYNTHETIC_FUND_VALUE。'); },
      context => {
        const payload = JSON.parse(String(context.messages[0]?.content));
        expect(payload.goal).toContain('今天基金的行情如何'); expect(payload.goal).toContain('000001'); expect(payload.conversationContext.messages).toEqual(history);
        expect(payload.preferredReplyLanguage).toBe('zh'); expect(payload.evidenceRequirements.evidence).toBe(true);
        return review([id]);
      },
    ]) };
    expect(deriveEvidenceRequirements(input).evidence).toBe(true);
    const result = await new DelegatePiAgentRuntime().run(input);
    expect(result.status).toBe('completed'); expect(browse).toHaveBeenCalledOnce(); expect(result.modelCalls).toBe(3);
  });
  it('does not let an identifier erase the prior live-data requirement', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2,
      model: binding([fauxAssistantMessage('UNVERIFIED_CURRENT_VALUE'), review([], { requiresEvidence: false })]) });
    expect(result.status).not.toBe('completed'); expect(result.text).not.toContain('UNVERIFIED_CURRENT_VALUE');
    expect(result.text).toContain('任务尚未取得');
  });
  it.each(['000001', 'ZX-17', 'BABA', 'person@example.invalid'])('inherits conversation language for a language-neutral reference: %s', userText => {
    expect(resolveReplyLanguage({ userText, history })).toBe('zh');
    expect(resolveReplyLanguage({ userText, history: [{ role: 'user', text: 'Please look up the latest quote.' }] })).toBe('en');
  });
  it('honors a new complete request instead of carrying an old task into every turn', () => {
    const input = { ...base, userText: '换个话题，解释什么是三角形', model: binding([]) };
    expect(deriveEvidenceRequirements(input).evidence).toBe(false);
    expect(resolveReplyLanguage({ userText: 'Please explain triangles.', history })).toBe('en');
    expect(resolveReplyLanguage({ userText: '000001', responseLanguage: 'zh' })).toBe('zh');
  });
  it('bounds review context without silently truncating individual turns', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `turn-${i}` }));
    expect(reviewConversationContext(turns)).toEqual({ messages: turns.slice(-8), truncated: true });
    expect(reviewConversationContext([{ role: 'user', text: 'x'.repeat(16001) }])).toEqual({ messages: [], truncated: true });
  });
  it('uses the established language for approval notices after an identifier reply', async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, model: binding([
      fauxAssistantMessage(fauxToolCall('browse_in_sandbox', { url: 'https://example.invalid/quote' }), { stopReason: 'toolUse' }),
    ]), capabilities: { sandbox: { execute: vi.fn(), browse: async () => ({ status: 'pending_approval', text: 'pending', details: { approvalId: 'approval' } }) } } });
    expect(result.status).toBe('waiting_approval'); expect(result.text).toContain('任务正在等待审批');
  });
});
