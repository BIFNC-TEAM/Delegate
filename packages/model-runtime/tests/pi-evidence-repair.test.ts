import {createModels,fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai';
import {describe,it,expect,vi} from 'vitest';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import {assessGoalCompletion} from '../src/pi/execution-state';
import type {PiAgentRunInput,PiToolObservation} from '../src/pi/types';
import {fixtureContextAuthority} from './context-authority-fixture';
function binding(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]){
 const f=fauxProvider({tokensPerSecond:100000});f.setResponses(responses);const m=createModels();m.setProvider(f.provider);return{model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};
}
const result=(overrides:Record<string,unknown>={})=>fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:[],missing:[],summary:'',responseKind:'result',claimsSupported:true,...overrides}));
const policy={version:1 as const,answerScope:'open_public' as const,knowledgePolicy:'owner_facts' as const,commitmentPolicy:'information_only' as const};
const base={runId:'repair',sessionId:'repair',executionProtocol:'goal_v2' as const,representative:{name:'测试代表',ownerName:'Owner',role:'公开问答'},userText:'查公开网页标题',evidenceRequirements:{evidence:true}};
const observation:PiToolObservation={callId:'observed-call',toolName:'browse_in_sandbox',status:'completed',text:'Title: Actual title',sources:[{id:'artifact-source',title:'Source',channel:'web'}],artifacts:[],observation:{state:'available'}};
const call=fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:'https://example.com'}),{stopReason:'toolUse'});

describe('repair reviewer evidence references without rewriting a supported answer',()=>{
 it.each([{ids:[]},{ids:['artifact-source']},{ids:['nonexistent']}])('keeps candidate and observations identical for one bounded repair: $ids',async ({ids})=>{
  let callId='';let original:any;let repaired:any;const browse=vi.fn(async()=>({status:'completed',text:'Actual title',sources:[{id:'artifact-source',title:'Source',channel:'web' as const}]}));
  const r=await new DelegatePiAgentRuntime().run({...base,maxSteps:4,model:binding([call,
   ctx=>{callId=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('Actual title');},
   ctx=>{original=JSON.parse(String(ctx.messages[0]?.content));return result({evidenceIds:ids});},
   ctx=>{repaired=JSON.parse(String(ctx.messages[0]?.content));return result({evidenceIds:[callId]});}
  ]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('completed');expect(r.text).toBe('Actual title');expect(browse).toHaveBeenCalledOnce();expect(r.toolCalls).toBe(1);expect(r.modelCalls).toBe(4);
  expect(repaired.candidate).toBe(original.candidate);expect(repaired.observations).toEqual(original.observations);
  expect(repaired.evidenceReferenceRepair.eligibleCallIds).toEqual([callId]);
  expect(r.spans.filter(s=>s.operation==='goal_assessment').map(s=>s.purpose)).toEqual(['result_verification','evidence_reference_repair']);
  expect(r.spans.filter(s=>s.operation==='generate')).toHaveLength(2);
 });
 it('also repairs a missing knowledge citation without granting owner facts automatic support',async()=>{
  const o={...observation,toolName:'retrieve_authorized_knowledge',sources:[{id:'policy-source',title:'Policy',channel:'knowledge' as const}]};
  const r=await assessGoalCompletion({run:{...base,representative:{...base.representative,agentBehavior:policy},model:binding([result({requiresEvidence:false,policyCheck:{topic:'owner_fact',withinAnswerScope:true,knowledgeBasis:'authorized',commitment:'none'}})])},candidate:'Supported policy',observations:[o],signal:new AbortController().signal});
  expect(r.releaseCandidate).toBe(false);expect(r.repairEvidenceReferences).toBe(true);expect(r.evidenceIds).toEqual([]);
 });
 it.each([
  {status:'failed',observation:{state:'unavailable' as const}},
  {status:'pending_approval'},
  {status:'completed',observation:{state:'blocked' as const}},
  {status:'completed',observation:{state:'unknown' as const}},
 ])('cannot repair using failed, pending, blocked or unknown evidence: %j',async patch=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([result()])},candidate:'Actual title',observations:[{...observation,...patch}],signal:new AbortController().signal});
  expect(r.releaseCandidate).toBe(false);expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it.each([
  {claimsSupported:false}, {verdict:'continue'}, {missing:['actual requested value unavailable']},
 ])('does not treat semantic rejection or missing task data as a reference-only error: %j',async patch=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([result(patch)])},candidate:'Actual title',observations:[observation],signal:new AbortController().signal});
  expect(r.releaseCandidate).toBe(false);expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it('does not repair away an owner-scope or requested-method failure',async()=>{
  for(const run of [
   {...base,evidenceRequirements:{sandbox:true,browser:true},model:binding([result()])},
   {...base,representative:{...base.representative,agentBehavior:policy},model:binding([result({policyCheck:{topic:'owner_fact',withinAnswerScope:false,knowledgeBasis:'authorized',commitment:'new'}})])}
  ]){
   const r=await assessGoalCompletion({run,candidate:'Actual value',observations:[{...observation,toolName:'mcp__fixture__read'}],signal:new AbortController().signal});expect(r.repairEvidenceReferences).not.toBe(true);expect(r.releaseCandidate).toBe(false);
  }
 });
 it('stops after one unsuccessful repair without regenerating prose or redoing the tool',async()=>{
  const browse=vi.fn(async()=>({status:'completed',text:'Actual title'}));const r=await new DelegatePiAgentRuntime().run({...base,maxSteps:10,model:binding([call,fauxAssistantMessage('Actual title'),result(),result(),fauxAssistantMessage('MUST_NOT_REWRITE')]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('partial');expect(r.text).not.toContain('MUST_NOT_REWRITE');expect(browse).toHaveBeenCalledOnce();expect(r.modelCalls).toBe(4);
 });
 it('does not use a repair response to waive claimsSupported or accept a fabricated reference',async()=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([result({evidenceIds:['fabricated'],repairEvidenceReferences:false,releaseCandidate:true})])},candidate:'Actual title',observations:[observation],signal:new AbortController().signal});expect(r.releaseCandidate).toBe(false);expect(r.evidenceIds).toEqual([]);
 });
 it('keeps the existing total model-call budget when a reference repair would exceed it',async()=>{
  const browse=vi.fn(async()=>({status:'completed',text:'Actual title'}));
  const r=await new DelegatePiAgentRuntime().run({...base,maxSteps:3,model:binding([call,fauxAssistantMessage('Actual title'),result()]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('partial');expect(r.modelCalls).toBe(3);expect(browse).toHaveBeenCalledOnce();
  expect(r.spans.some(s=>s.purpose==='evidence_reference_repair')).toBe(false);
 });
 it('repairs the approved observation reference without executing the approved read again',async()=>{
  const authority={...fixtureContextAuthority('repair'),hasResultSource:(ref:string,tool:string)=>ref==='receipt'&&tool==='browse_in_sandbox'};
  const browse=vi.fn(async()=>({status:'pending_approval',text:'Pending',details:{approvalId:'a1'}}));
  const initial={...base,contextAuthorization:authority,maxSteps:6,model:binding([call]),capabilities:{sandbox:{execute:vi.fn(),browse}}};
  const first=await new DelegatePiAgentRuntime().run(initial);expect(first.checkpoint).toBeDefined();
  const id=first.checkpoint!.pending.callId;browse.mockClear();
  const r=await new DelegatePiAgentRuntime().run({...initial,checkpoint:first.checkpoint!,approvedToolResult:{approvalId:'a1',toolName:'browse_in_sandbox',status:'completed',text:'Actual title',contextSourceRef:'receipt'},model:binding([fauxAssistantMessage('Actual title'),result(),result({evidenceIds:[id]})])});
  expect(r.status).toBe('completed');expect(r.text).toBe('Actual title');expect(r.modelCalls).toBe(3);expect(r.toolCalls).toBe(0);expect(browse).not.toHaveBeenCalled();
 });
 it('does not attempt a reference repair when the requested file is not actually present',async()=>{
  const r=await assessGoalCompletion({run:{...base,evidenceRequirements:{artifact:true,outputFiles:[{format:'csv',fileName:'report.csv'}]},model:binding([result()])},candidate:'report.csv is ready',observations:[observation],signal:new AbortController().signal});
  expect(r.repairEvidenceReferences).not.toBe(true);expect(r.releaseCandidate).toBe(false);
 });
});
