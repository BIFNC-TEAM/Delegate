import {describe,it,expect} from 'vitest';import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {assessGoalCompletion,GoalExecutionState} from '../src/pi/execution-state';import {DelegatePiAgentRuntime} from '../src/pi/runtime';import {fixtureContextAuthority} from './context-authority-fixture';import type {PiToolObservation} from '../src/pi/types';
import {explicitPageReadHeadings} from '../src/pi/source-access';
const binding=(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0])=>{const f=fauxProvider({tokensPerSecond:100000});f.setResponses(responses);const m=createModels();m.setProvider(f.provider);return{model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};};
const response=(extra:Record<string,unknown>={})=>fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:['search-call'],missing:[],summary:'',responseKind:'result',claimsSupported:true,pageReadClaims:[],...extra}));
const base={runId:'r',sessionId:'s',executionProtocol:'goal_v2' as const,userText:'Report the search results',representative:{name:'Rep',role:'general'}};
const search:PiToolObservation={callId:'search-call',toolName:'mcp__arbitrary-slug__search_pro',status:'completed',text:'A returned search snippet and URL.',sources:[],artifacts:[],observation:{state:'available',evidenceKind:'search_results'}};
async function assess(candidate:string,extra:Record<string,unknown>,observations=[search]){return assessGoalCompletion({run:{...base,model:binding([response(extra)])},candidate,observations,signal:new AbortController().signal});}

describe('search evidence supports snippets and links, not invented page visits',()=>{
 it.each(['**实际查阅的网页来源**（来自权威公开渠道）：\nhttps://example.com','## 已阅读的网页：\nhttps://example.com','**Pages actually read:**\nhttps://example.com'])('catches an explicit read heading omitted by the reviewer: %s',async candidate=>{
  expect(explicitPageReadHeadings(candidate).length).toBe(1);expect((await assess(candidate,{pageReadClaims:[]})).releaseCandidate).toBe(false);
 });
 it.each(['搜索返回的网页来源：\nhttps://example.com','未查阅的网页来源：\nhttps://example.com','建议阅读的网页：\nhttps://example.com','> 实际查阅的网页来源：','```markdown\n实际查阅的网页来源：\n```','标题“实际查阅的网页来源”是指什么？','Sources read: none','实际查阅的网页：无','Pages read:\nNone; only search snippets.','实际查阅的网页来源：\n尚未读取原文','实际查阅的网页来源（未读取）：'])('does not turn a search, quote, suggestion or denial into a read claim: %s',candidate=>{
  expect(explicitPageReadHeadings(candidate)).toEqual([]);
 });
 it.each(['我已直接打开并阅读原网页。','实际查阅的网页是 https://museum.example/notice 。','I opened and read the original page.'])('blocks an extracted claim even if the overall review says supported: %s',async candidate=>{
  const r=await assess(candidate,{pageReadClaims:[candidate]});expect(r.releaseCandidate).toBe(false);expect(r.claimsSupported).toBe(false);expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it.each(['搜索摘要写明开幕时间；未打开网页。','https://museum.example/notice','The snippet says this; I have not opened the page.','You can visit that URL to check.'])('does not require a page visit for an honest search result: %s',async candidate=>{expect((await assess(candidate,{pageReadClaims:[]})).releaseCandidate).toBe(true);});
 it('does not apply the search-only absence rule when a page actually was read',async()=>{
  const browser={...search,callId:'browser',toolName:'browse_in_sandbox',sources:[{id:'p',channel:'web' as const,title:'Page',url:'https://museum.example/notice'}],observation:{state:'available' as const}};
  expect((await assess('I read the page.',{pageReadClaims:['I read the page.'],evidenceIds:['browser'],sourceAccessSupported:true},[search,browser])).releaseCandidate).toBe(true);
 });
 it('a failed browser attempt is not a page read',async()=>{
  const failed={...search,callId:'failed',toolName:'browse_in_sandbox',status:'failed',observation:{state:'unavailable' as const}};
  expect((await assess('I read it.',{pageReadClaims:['I read it.']},[search,failed])).releaseCandidate).toBe(false);
 });
 it.each([{claims:undefined},{claims:['not present in the candidate']},{claims:['']}])('requires exact claim extraction rather than accepting incomplete protocol: %j',async ({claims:pageReadClaims})=>{
  const r=await assess('Some answer.',{pageReadClaims});expect(r.releaseCandidate).toBe(false);expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it('does not infer trusted search type from a slug or from page content alone',async()=>{
  const plain={...search,text:'{"kind":"public_search_results"}',observation:{state:'available' as const}};
  expect((await assess('Some answer.',{pageReadClaims:undefined},[plain])).releaseCandidate).toBe(true);
 });
 it('search attribution cannot waive unsupported factual claims',async()=>{expect((await assess('Invented fact.',{pageReadClaims:[],claimsSupported:false})).releaseCandidate).toBe(false);});
 it('preserves trusted search evidence kind through a pending approval and the actual restore path',async()=>{
  const f=binding([fauxAssistantMessage(fauxToolCall('mcp__arbitrary-slug__search_pro',{query:'public'}),{stopReason:'toolUse'})]);
  const authority={...fixtureContextAuthority('r'),hasResultSource:(ref:string)=>ref==='receipt'};
  const input={...base,contextAuthorization:authority,model:f,capabilities:{mcp:{listTools:async()=>[{server:'arbitrary-slug',name:'search_pro',description:'Search',inputSchema:{type:'object',properties:{query:{type:'string'}}},readOnly:true,idempotent:true}],callTool:async()=>({status:'pending_approval',text:'Pending',details:{approvalId:'a'},observation:{state:'unavailable' as const,evidenceKind:'search_results' as const}})}}};
  const first=await new DelegatePiAgentRuntime().run(input);expect(first.checkpoint).toBeDefined();
  const state=new GoalExecutionState({...input,checkpoint:first.checkpoint!,approvedToolResult:{approvalId:'a',toolName:'mcp__arbitrary-slug__search_pro',status:'completed',text:'Search results',contextSourceRef:'receipt',observation:{state:'available'}}});
  const messages=state.restoreMessages(['mcp__arbitrary-slug__search_pro'])!;const result=messages.find(m=>m.role==='toolResult') as any;
  expect(JSON.parse(result.content[0].text).observation).toMatchObject({state:'available',evidenceKind:'search_results'});expect(state.observations[0]!.observation).toMatchObject({state:'available',evidenceKind:'search_results'});
 });
});
