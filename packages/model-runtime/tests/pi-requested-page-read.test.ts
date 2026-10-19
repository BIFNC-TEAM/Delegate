import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {describe,it,expect,vi} from 'vitest';
import {deriveEvidenceRequirements,DelegatePiAgentRuntime} from '../src/pi/runtime';
import {GoalExecutionState,parseExecutionCheckpoint,mergeEvidenceRequirements} from '../src/pi/execution-state';
const base={runId:'read-contract',sessionId:'read-contract',executionProtocol:'goal_v2' as const,representative:{name:'测试代表',role:'公开问答'},userText:'查询1992年奥运会，并给出实际查阅的网页来源。'};
function binding(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]){const f=fauxProvider({tokensPerSecond:100000});f.setResponses(responses);const m=createModels();m.setProvider(f.provider);return{model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};}
const review=(id:string)=>fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:false,evidenceIds:[id],missing:[],summary:'',responseKind:'result',claimsSupported:true,pageReadClaims:[],sourceAccessSupported:true}));
const tool=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});

describe('explicit original-page reading request is a host-held evidence obligation',()=>{
 it.each([
  base.userText,'请打开原网页核实价格。','请阅读官网原文再回答。','请实际访问这些网站并给出结果。',
  'Read the original webpage and report the opening date.','Give me the sources you actually read on the web.',
 ])('recognizes an explicit page read: %s',userText=>{
  expect(deriveEvidenceRequirements({...base,userText,model:binding([])}).browser).toBe(true);
 });
 it.each([
  '查开幕时间并说明出处。','只返回搜索结果网址，不需要打开。','本次不用阅读原网页，只概括搜索摘要。',
  '请翻译“我已阅读官网原文”。','解释什么是实际查阅的网页来源。','如何打开原网页？',
  'Summarize the search snippets without opening the original webpage.',
  'Do not read the original webpage; return the search URL only.',
 ])('does not force browsing for a search, negation or text task: %s',userText=>{
  expect(deriveEvidenceRequirements({...base,userText,model:binding([])}).browser).not.toBe(true);
 });
 it('withholds a search-only answer despite a permissive reviewer, then uses actual page evidence',async()=>{
  let searchId='',pageId='';const search=vi.fn(async()=>({status:'completed',text:'Search snippet: date is July 25.',observation:{state:'available' as const,evidenceKind:'search_results' as const}}));
  const browse=vi.fn(async()=>({status:'completed',text:'Original page: date is July 25.',sources:[{id:'page',title:'Original page',url:'https://example.com/page',channel:'web' as const}],observation:{state:'available' as const}}));
  const result=await new DelegatePiAgentRuntime().run({...base,maxSteps:6,model:binding([
   tool('mcp__public__search',{query:'date'}),ctx=>{searchId=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('SEARCH_ONLY_FALSE_READ_999');},()=>review(searchId),
   tool('browse_in_sandbox',{url:'https://example.com/page'}),ctx=>{pageId=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('实际读取页面记载7月25日。');},()=>review(pageId),
  ]),capabilities:{mcp:{listTools:async()=>[{server:'public',name:'search',description:'Search snippets',inputSchema:{type:'object',properties:{query:{type:'string'}}},readOnly:true,idempotent:true}],callTool:search},sandbox:{execute:vi.fn(),browse}}});
  expect(result.text).toBe('实际读取页面记载7月25日。');expect(result.status).toBe('completed');expect(search).toHaveBeenCalledOnce();expect(browse).toHaveBeenCalledOnce();expect(result.modelCalls).toBe(6);
 });
 it('does not release a search-only claim when there is no budget for a read',async()=>{
  let id='';const result=await new DelegatePiAgentRuntime().run({...base,maxSteps:3,model:binding([
   tool('mcp__public__search',{}),ctx=>{id=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('SEARCH_ONLY_FALSE_READ_999');},()=>review(id),
  ]),capabilities:{mcp:{listTools:async()=>[{server:'public',name:'search',description:'Search snippets',inputSchema:{type:'object',properties:{}},readOnly:true,idempotent:true}],callTool:async()=>({status:'completed',text:'Search evidence',observation:{state:'available',evidenceKind:'search_results'}})}}});
  expect(result.text).not.toContain('SEARCH_ONLY_FALSE_READ_999');expect(result.status).not.toBe('completed');
 });
 it('keeps the required read in the existing approval checkpoint contract',()=>{
  const input={...base,model:binding([])};const requirements=deriveEvidenceRequirements(input);
  const state=new GoalExecutionState({...input,evidenceRequirements:requirements});
  state.pending={approvalId:'approval',callId:'call',toolName:'browse_in_sandbox'};
  const checkpoint=state.checkpoint([])!;
  expect(parseExecutionCheckpoint(checkpoint)?.evidenceRequirements?.browser).toBe(true);
  expect(mergeEvidenceRequirements(checkpoint.evidenceRequirements,{browser:false})).toMatchObject({browser:true,evidence:true});
 });
});
