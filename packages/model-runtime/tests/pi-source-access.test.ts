import {describe,it,expect} from 'vitest';
import {buildObservationAccess} from '../src/pi/source-access';
import {assessGoalCompletion,GoalExecutionState} from '../src/pi/execution-state';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import type {PiToolObservation} from '../src/pi/types';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import {fixtureContextAuthority} from './context-authority-fixture';
const source={id:'newsletter',title:'Local newsletter quoting Museum',channel:'web' as const,url:'https://newsletter.example/exhibition'};
const o:PiToolObservation={callId:'call',toolName:'browse_in_sandbox',status:'completed',text:'Article cites https://museum.example/notice',sources:[source],artifacts:[],observation:{state:'available'}};
const binding=(text:string)=>{const f=fauxProvider({tokensPerSecond:100000});f.setResponses([fauxAssistantMessage(text)]);const m=createModels();m.setProvider(f.provider);return{model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};};

describe('source access is distinct from sources mentioned inside text',()=>{
 it('uses observed browser source URLs, never links mentioned in page text',()=>{
  expect(buildObservationAccess(o)).toMatchObject({callId:'call',method:'browser_page',available:true,directlyReadPages:[{title:source.title,url:source.url}]});
  expect(JSON.stringify(buildObservationAccess(o))).not.toContain('https://museum.example');
 });
 it.each(['mcp__public-search__search_pro','search_current_web','retrieve_authorized_knowledge','custom_read'])('does not equate %s with browser visits',toolName=>{
  expect(buildObservationAccess({...o,toolName}).directlyReadPages).toEqual([]);
 });
 it.each([{status:'failed'},{status:'pending_approval'},{observation:{state:'blocked' as const}},{observation:{state:'unknown' as const}},{observation:{state:'empty' as const}}])('does not list an unsuccessful read: %j',patch=>{
  expect(buildObservationAccess({...o,...patch})).toMatchObject({available:false,directlyReadPages:[]});
 });
 it('does not promote invalid URLs or non-web source records',()=>{
  const sources=[{...source,url:'file:///secret'},{...source,url:'https://u:p@example.com'},{...source,url:'not a URL'},{...source,channel:'mcp' as const},source,source];
  expect(buildObservationAccess({...o,sources}).directlyReadPages).toEqual([{title:source.title,url:source.url}]);
 });
 it('rejects a contradictory overall pass when the reviewer rejects source access',async()=>{
  const model=binding(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:['call'],missing:[],summary:'',responseKind:'result',claimsSupported:true,sourceAccessSupported:false}));
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'Explain the actual source',model,representative:{name:'Rep',role:'general'}},candidate:'I verified the museum notice.',observations:[o],signal:new AbortController().signal});
  expect(r.releaseCandidate).toBe(false);expect(r.claimsSupported).toBe(false);expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it('a source-access pass cannot override other unsupported claims',async()=>{
  const model=binding(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:['call'],missing:[],summary:'',responseKind:'result',claimsSupported:false,sourceAccessSupported:true}));
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'Explain',model,representative:{name:'Rep',role:'general'}},candidate:'unsupported',observations:[o],signal:new AbortController().signal});expect(r.releaseCandidate).toBe(false);
 });
 it('adds the same access record to generation tool output without trusting a payload-supplied record',async()=>{
  const state=new GoalExecutionState({runId:'r',sessionId:'s',userText:'Read',model:binding(''),representative:{name:'Rep',role:'general'}});
  const value={status:'completed',result:o.text,sources:o.sources,sourceAccess:{directlyReadPages:[{url:'https://museum.example'}]}};
  const [tool]=state.wrapTools([{name:'browse_in_sandbox',label:'Browse',description:'Read',parameters:{type:'object',properties:{}} as any,execute:async()=>({details:{},content:[{type:'text',text:JSON.stringify(value)}]})}]);
  const result=await tool!.execute('call',{},new AbortController().signal);const payload=JSON.parse((result.content[0] as any).text);
  expect(payload.result).toBe(o.text);expect(payload.sourceAccess).toEqual(buildObservationAccess(state.observations[0]!));expect(payload.sourceAccess.directlyReadPages).toEqual([{title:source.title,url:source.url}]);
 });
 it.each([false,true])('keeps the search-only review contract unchanged, including failed-browser fallback=%s',async failedBrowser=>{
  let prompt='';let payload:any;const f=fauxProvider({tokensPerSecond:100000});f.setResponses([ctx=>{prompt=ctx.systemPrompt??'';payload=JSON.parse(String(ctx.messages[0]?.content));return fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:['call'],missing:[],summary:'',responseKind:'result',claimsSupported:true}));}]);const m=createModels();m.setProvider(f.provider);
  const model={model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'Only list the returned URL',model,representative:{name:'Rep',role:'general'}},candidate:'https://museum.example/notice',observations:[{...o,toolName:'mcp__public-search__search_pro'},...(failedBrowser?[{...o,callId:'failed-browser',status:'failed',observation:{state:'unavailable' as const}}]:[])],signal:new AbortController().signal});
  expect(r.releaseCandidate).toBe(true);expect(payload.observationAccess).toBeUndefined();expect(prompt).not.toContain('Before the overall verdict, return sourceAccessSupported');
 });
 it('rebuilds browser access metadata from the approved receipt without repeating the read',async()=>{
  const f=fauxProvider({tokensPerSecond:100000});f.setResponses([fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:source.url}),{stopReason:'toolUse'})]);const m=createModels();m.setProvider(f.provider);
  const model={model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};
  let reads=0;const authority={...fixtureContextAuthority('r'),hasResultSource:(ref:string)=>ref==='receipt'};
  const base={runId:'r',sessionId:'s',executionProtocol:'goal_v2' as const,contextAuthorization:authority,userText:'Read the newsletter',model,representative:{name:'Rep',role:'general'},capabilities:{sandbox:{execute:async()=>{throw new Error('Not used');},browse:async()=>{reads++;return{status:'pending_approval',text:'pending',details:{approvalId:'a'}};}}}};
  const first=await new DelegatePiAgentRuntime().run(base);expect(first.checkpoint).toBeDefined();const restored=new GoalExecutionState({...base,checkpoint:first.checkpoint!,approvedToolResult:{approvalId:'a',toolName:'browse_in_sandbox',status:'completed',text:o.text,sources:[source],contextSourceRef:'receipt'}});
  const messages=restored.restoreMessages(['browse_in_sandbox'])!;const result=messages.find((msg:any)=>msg.role==='toolResult') as any;
  expect(JSON.parse(result.content[0].text).sourceAccess).toMatchObject({available:true,directlyReadPages:[{title:source.title,url:source.url}]});expect(reads).toBe(1);
 });
});
