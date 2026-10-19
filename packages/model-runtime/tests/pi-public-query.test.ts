import {createModels,fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai';
import {describe,it,expect,vi} from 'vitest';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import type {PiSandboxAdapter,PiToolObservation} from '../src/pi/types';
import {renderPublicLookupFailure} from '../src/pi/execution-state';
import {fixtureContextAuthority} from './context-authority-fixture';

type Browse=NonNullable<PiSandboxAdapter['browse']>;
function binding(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]){
 const faux=fauxProvider({tokensPerSecond:100000});faux.setResponses(responses);const models=createModels();models.setProvider(faux.provider);
 return{model:faux.getModel(),streamFn:models.streamSimple.bind(models),provider:'faux',modelId:faux.getModel().id};
}
const call=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const review=(verdict:string,kind:string,supported:boolean,ids:string[]=[])=>fauxAssistantMessage(JSON.stringify({verdict,responseKind:kind,claimsSupported:supported,requiresEvidence:true,evidenceIds:ids,missing:[],summary:''}));
const base={runId:'public-test',sessionId:'public-test',contextAuthorization:fixtureContextAuthority('public-test'),executionProtocol:'goal_v2' as const,representative:{name:'测试代表',role:'通用问答',ownerName:'合成所有者'},userText:'使用沙盒浏览器查公开信息',maxSteps:3};

describe('public queries through the existing managed browser',()=>{
 it('replaces an unverified fallback with the actual rate-limit outcome',async()=>{
  const result=await new DelegatePiAgentRuntime().run({...base,model:binding([call('browse_in_sandbox',{url:'https://example.com'}),fauxAssistantMessage('已取得价格123。'),review('continue','result',false)]),capabilities:{sandbox:{execute:vi.fn(),browse:async()=>({status:'completed',text:'Too Many Requests',observation:{state:'blocked',httpStatus:429}})}}});
  expect(result.status).toBe('partial');expect(result.text).toContain('限流');expect(result.text).not.toContain('123');expect(result.text).not.toContain('任务尚未取得充分');expect(result.sources).toEqual([]);
 });
 it('does not publish absent-library claims from a permissive limitation review after failed public reads',async()=>{
  const retrieve=vi.fn(async()=>({status:'unavailable',text:'授权知识检索当前不可用。'}));
  const result=await new DelegatePiAgentRuntime().run({...base,maxSteps:4,model:binding([call('browse_in_sandbox',{url:'https://example.com'}),call('retrieve_authorized_knowledge',{query:'public quote'}),fauxAssistantMessage('知识库没有股票数据，没有合规接口。'),review('partial','limitation',true)]),capabilities:{knowledge:{retrieve},sandbox:{execute:vi.fn(),browse:async()=>({status:'failed',text:'Failed'})}}});
  expect(retrieve).toHaveBeenCalledOnce();expect(result.status).toBe('partial');expect(result.text).toContain('访问失败');expect(result.text).not.toMatch(/没有股票数据|没有合规接口/);
 });
 it('preserves a reviewed partial result when one page really succeeded',async()=>{
  let id='';const browse=vi.fn<Browse>().mockResolvedValueOnce({status:'completed',text:'Verified public title',observation:{state:'available'}}).mockResolvedValueOnce({status:'failed',text:'Failed'});
  const result=await new DelegatePiAgentRuntime().run({...base,maxSteps:5,model:binding([call('browse_in_sandbox',{url:'https://example.com/one'}),context=>{id=(context.messages.at(-1) as any).toolCallId;return call('browse_in_sandbox',{url:'https://example.com/two'});},fauxAssistantMessage('查到了标题，另一页未取得。'),()=>review('partial','result',true,[id])]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(result.text).toBe('查到了标题，另一页未取得。');expect(result.status).toBe('partial');
 });
});

describe('public failure summaries preserve other task outcomes',()=>{
 const page:PiToolObservation={callId:'page',toolName:'browse_in_sandbox',status:'failed',text:'private diagnostics are not output',sources:[],artifacts:[]};
 it.each(['available','unknown'] as const)('does not summarize %s content as an all-failed lookup',state=>{
  expect(renderPublicLookupFailure([{...page,observation:{state}}],'查询')).toBeUndefined();
 });
 it.each(['execute_in_sandbox','request_human_handoff','mcp__business__submit'])('does not replace another operation: %s',toolName=>{
  expect(renderPublicLookupFailure([page,{...page,callId:'other',toolName}],'查询')).toBeUndefined();
 });
 it('keeps failed reads separate from retrieved knowledge, approvals and unknown outcomes',()=>{
  for(const status of ['found','not_found','pending_approval','unknown'])expect(renderPublicLookupFailure([page,{...page,toolName:'retrieve_authorized_knowledge',status}],'查询')).toBeUndefined();
  expect(renderPublicLookupFailure([{...page,status:'pending_approval',observation:{state:'blocked'}}],'查询')).toBeUndefined();
 });
 it('reports empty pages in English without private page contents or diagnostics',()=>{
  const text=renderPublicLookupFailure([{...page,status:'completed',observation:{state:'empty'}}],'Read a public page');
  expect(text).toContain('no readable content');expect(text).not.toContain('private diagnostics');
 });
});
