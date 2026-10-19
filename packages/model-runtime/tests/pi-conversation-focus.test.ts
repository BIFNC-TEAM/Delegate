import {describe,it,expect,vi} from 'vitest';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import {assessGoalCompletion} from '../src/pi/execution-state';
import {fixtureContextAuthority} from './context-authority-fixture';
const check={inputRelation:'continuation',resolvedRequest:{kind:'public_lookup',targetSpecified:true,targetSourceIndex:0,target:'110011',outcome:'基金今天的行情如何'},ambiguityEvidenceIds:[],anchorIndex:1,taskAlignment:'on_task',revivesUnrequestedTasks:false,clarificationNeeded:false,missingInputs:[],blockingPersonalInputs:[],alreadyProvided:false,repeatsAuthorization:false};
const assessment=(extra:any={})=>({verdict:'complete',responseKind:'result',requiresEvidence:true,evidenceIds:['page'],missing:[],summary:'',claimsSupported:true,conversationCheck:check,...extra});
function binding(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]){const p=fauxProvider({tokensPerSecond:100000});p.setResponses(responses);const m=createModels();m.setProvider(p.provider);return{model:p.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:p.getModel().id};}
const base={runId:'focus',sessionId:'focus',executionProtocol:'goal_v2' as const,conversationContextMode:'focused_v1' as const,contextAuthorization:fixtureContextAuthority('focus'),representative:{name:'代表',role:'地理教学'},history:[{role:'user' as const,text:'基金今天的行情如何',messageId:'fund',taskAnchor:true}],userText:'代码110011'};
describe('semantic follow-up context and necessary clarification',()=>{
 it('keeps the current correction last without deleting earlier independent constraints',async()=>{
  const model=binding([ctx=>{
   const payload=JSON.parse(String(ctx.messages[0]?.content));
   expect(Object.keys(payload).at(-1)).toBe('currentInput');
   expect(payload.currentInput.text).toBe('换成上海');
   expect(payload.priorUserContext.map((m:any)=>m.text)).toContain('明天上午');
   return fauxAssistantMessage('正在查询。');
  }]);
  await new DelegatePiAgentRuntime().run({...base,userText:'换成上海',maxSteps:1,
   history:[{role:'user',text:'查北京的天气',taskAnchor:true},{role:'user',text:'明天上午'}],model});
 });
 it('retains a rejection and task anchor when diagnostic prose exceeds the display cap',async()=>{
  const c={...check};
  const r=await assessGoalCompletion({run:{...base,model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'continue',claimsSupported:false,missing:['Remove the unsupported publication explanation. '+ 'x'.repeat(700)],summary:'x'.repeat(2100),conversationCheck:c})))])},candidate:'它会在今晚公布。',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);expect(r.verdict).toBe('continue');
  expect(r.conversationCheck?.anchorIndex).toBe(1);expect(r.missing[0]).toHaveLength(500);expect(r.summary).toHaveLength(2000);
 });

 it.each(['110011','代码110011','基金代码是110011','就查110011这只','帮我看看这只，110011','换成000001','易方达优质精选混合','the one numbered 110011'])('provides the same focused task context for natural input: %s',async userText=>{
  const browse=vi.fn(async()=>({status:'completed',text:'Observed result',sources:[],artifacts:[]}));let id='';
  const model=binding([ctx=>{expect(ctx.messages).toHaveLength(1);const text=JSON.stringify(ctx.messages);expect(text).toContain(userText);expect(text).toContain('基金今天的行情如何');return fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:'https://example.com'}),{stopReason:'toolUse'});},ctx=>{id=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('已取得对应查询结果。');},()=>fauxAssistantMessage(JSON.stringify(assessment({evidenceIds:[id],conversationCheck:{...check,resolvedRequest:{...check.resolvedRequest,target:userText}}})))]);
  const r=await new DelegatePiAgentRuntime().run({...base,userText,model,capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('completed');expect(r.conversationFocusIndex).toBe(1);expect(browse).toHaveBeenCalledOnce();expect(r.modelCalls).toBe(3);
 });
 it.each([
  {revivesUnrequestedTasks:true}, {taskAlignment:'off_task'}, {clarificationNeeded:false}, {alreadyProvided:true}, {repeatsAuthorization:true}, {missingInputs:[]},
 ])('rejects a bad clarification even if the overall reviewer approves: %j',async patch=>{
  const c={...check,clarificationNeeded:true,missingInputs:['目标'],...patch};
  const r=await assessGoalCompletion({run:{...base,model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck:c})) )])},candidate:'先查天气还是基金？',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);expect(r.failureCodes?.length).toBeGreaterThan(0);
 });
 it('allows genuine missing input and an explicit new topic without reviving the old task',async()=>{
  const r=await assessGoalCompletion({run:{...base,userText:'查一下机票',model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck:{...check,inputRelation:'new_request',resolvedRequest:{kind:'public_lookup',targetSpecified:false,targetSourceIndex:0,target:'',outcome:'查一下机票'},anchorIndex:0,clarificationNeeded:true,missingInputs:['出发地','目的地','出行日期']}})))])},candidate:'请提供出发地、目的地及出行日期。',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(true);expect(r.verdict).toBe('waiting_user');expect(r.conversationCheck?.anchorIndex).toBe(0);
 });
 it('rejects missing or out-of-range task alignment metadata',async()=>{
  for(const conversationCheck of [undefined,{...check,resolvedRequest:{...check.resolvedRequest,outcome:''},anchorIndex:30}]){
   const r=await assessGoalCompletion({run:{...base,history:base.history.map(m=>({...m,taskAnchor:false})),model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck})))])},candidate:'要我查吗？',observations:[],signal:AbortSignal.timeout(1000)});
   expect(r.releaseCandidate).toBe(false);expect(r.failureCodes).toContain('conversation_check_missing');
  }
 });
 it('does not ask for optional lookup dimensions when the target and outcome are already quoted',async()=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck:{...check,clarificationNeeded:true,missingInputs:['想查询哪些维度']}})))])},candidate:'要查净值还是介绍？',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);expect(r.failureCodes).toContain('public_lookup_ready');
 });
 it('grounds the task anchor in the quoted original request instead of a parameter fragment',async()=>{
  const r=await assessGoalCompletion({run:{...base,model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck:{...check,inputRelation:'continuation',anchorIndex:0}})))])},candidate:'需要确认吗？',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.conversationCheck?.anchorIndex).toBe(1);expect(r.conversationCheck?.inputRelation).toBe('continuation');
 });
 it('retains the original outcome when a continuation quotes only a lookup verb and the new target',async()=>{
  const r=await assessGoalCompletion({run:{...base,userText:'就查110011这只',model:binding([fauxAssistantMessage(JSON.stringify(assessment({evidenceIds:[],conversationCheck:{...check,anchorIndex:0,resolvedRequest:{kind:'public_lookup',targetSpecified:true,targetSourceIndex:0,target:'110011',outcome:'就查110011这只'}}})))])},candidate:'还需要确认吗？',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.conversationCheck?.anchorIndex).toBe(1);
 });
 it('allows a genuinely missing private travel date even when a route is supplied',async()=>{
  const c={...check,inputRelation:'new_request',resolvedRequest:{kind:'public_lookup',target:'北京到上海',targetSpecified:true,targetSourceIndex:0,outcome:'查询机票'},clarificationNeeded:true,missingInputs:['出发日期'],blockingPersonalInputs:['出发日期']};
  const r=await assessGoalCompletion({run:{...base,userText:'查北京到上海的机票',model:binding([fauxAssistantMessage(JSON.stringify(assessment({verdict:'waiting_user',responseKind:'clarification',evidenceIds:[],conversationCheck:c})))])},candidate:'计划哪天出发？',observations:[],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(true);expect(r.verdict).toBe('waiting_user');
 });
});
