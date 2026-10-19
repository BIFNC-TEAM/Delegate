import { describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';
import { assessGoalCompletion, evidenceRequirementsForModel } from '../src/pi/execution-state';
import { fixtureContextAuthority } from './context-authority-fixture';
import type { PiModelBinding } from '../src/pi/types';
function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]): PiModelBinding {
  const p=fauxProvider({tokensPerSecond:100000});p.setResponses(responses);const m=createModels();m.setProvider(p.provider);
  return {model:p.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:p.getModel().id};
}
const policy={version:1 as const,answerScope:'open_public' as const,knowledgePolicy:'domain_first' as const,commitmentPolicy:'information_only' as const};
const base={runId:'review-run',sessionId:'review-run',contextAuthorization:fixtureContextAuthority('review-run'),executionProtocol:'goal_v2' as const,userText:'查今天的行情',representative:{name:'代表',role:'地理教学',agentBehavior:policy}};
const assessment=(extra:Record<string,unknown>={})=>({verdict:'complete',requiresEvidence:false,evidenceIds:[],missing:[],summary:'',responseKind:'result',claimsSupported:true,policyCheck:{topic:'general',withinAnswerScope:true,knowledgeBasis:'other',commitment:'none'},...extra});
const reply=(extra:Record<string,unknown>={})=>fauxAssistantMessage(JSON.stringify(assessment(extra)));

describe('review decisions and bounded correction',()=>{
 it('does not present optional methods as denied permissions to the model',()=>{
  expect(evidenceRequirementsForModel({evidence:true,browser:false,sandbox:false,artifact:false})).toEqual({evidence:true});
  expect(evidenceRequirementsForModel({evidence:true,browser:true})).toEqual({evidence:true,browser:true});
 });
 it.each(['specialty','knowledge_miss','published_scope'])('rejects a false %s scope refusal even if the model approves it',async refusalBasis=>{
  const result=await assessGoalCompletion({run:{...base,model:binding([reply({responseKind:'refusal',refusalBasis,verdict:'partial'})])},candidate:'该问题超出我的专业，不允许查询。',observations:[],signal:AbortSignal.timeout(1000)});
  expect(result.releaseCandidate).toBe(false);expect(result.failureCodes).toContain('false_scope_restriction');
 });
 it('permits necessary clarification without removing eventual evidence requirements',async()=>{
  const question='你想查询整体情况，还是具体对象？';
  const r=await new DelegatePiAgentRuntime().run({...base,model:binding([fauxAssistantMessage(question),reply({responseKind:'clarification',refusalBasis:'none',verdict:'waiting_user',requiresEvidence:true,missing:['查询对象']})])});
  expect(r.status).toBe('waiting_user');expect(r.text).toBe(question);expect(r.modelCalls).toBe(2);expect(r.toolCalls).toBe(0);
 });
 it('does not misapply the open scope check to a real access refusal',async()=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([reply({responseKind:'refusal',refusalBasis:'access',verdict:'partial'})])},candidate:'不能提供他人的密码。',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(true);
 });
 it('stops after an unchanged server evidence failure instead of spending a third draft',async()=>{
  const r=await new DelegatePiAgentRuntime().run({...base,maxSteps:16,model:binding([fauxAssistantMessage('今日结果123'),reply(),fauxAssistantMessage('换一种说法，结果123'),reply(),()=>{throw new Error('third draft must not run');}])});
  expect(r.modelCalls).toBe(4);expect(r.toolCalls).toBe(0);expect(r.text).not.toContain('123');expect(r.spans.some(s=>s.operation==='review_no_progress')).toBe(true);
 });
 it('continues when correction actually acquires evidence',async()=>{
  let callId='';const browse=vi.fn(async()=>({status:'completed',text:'The observed value is 123.'}));
  const r=await new DelegatePiAgentRuntime().run({...base,model:binding([fauxAssistantMessage('结果123'),reply(),fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:'https://example.com'}),{stopReason:'toolUse'}),context=>{callId=(context.messages.filter(m=>m.role==='toolResult').at(-1) as any).toolCallId;return fauxAssistantMessage('网页显示123。');},()=>reply({evidenceIds:[callId],requiresEvidence:true})]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('completed');expect(browse).toHaveBeenCalledOnce();expect(r.text).toContain('123');expect(r.spans.some(s=>s.operation==='review_no_progress')).toBe(false);
 });
 it('preserves an error after a successful browser call without rerunning the browser',async()=>{
  const browse=vi.fn(async()=>({status:'completed',text:'Public page.'}));
  const r=await new DelegatePiAgentRuntime().run({...base,model:binding([fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:'https://example.com'}),{stopReason:'toolUse'}),fauxAssistantMessage('',{stopReason:'error',errorMessage:'Provider finish_reason: content_filter PRIVATE_TEXT'})]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(browse).toHaveBeenCalledOnce();expect(r.error).toBe('model_content_filtered');expect(JSON.stringify(r.spans)).not.toContain('PRIVATE_TEXT');expect(r.spans.find(s=>s.operation==='generate'&&s.status==='error')?.error).toBe('model_content_filtered');
 });
});
