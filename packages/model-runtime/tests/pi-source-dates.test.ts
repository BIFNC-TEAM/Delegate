import {describe,it,expect,vi} from 'vitest';
import {checkSourceDates} from '../src/pi/source-dates';
import {assessGoalCompletion} from '../src/pi/execution-state';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import {createModels,fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai';
import {fixtureContextAuthority} from './context-authority-fixture';
import type {PiToolObservation} from '../src/pi/types';
const page:PiToolObservation={callId:'page',toolName:'browse_in_sandbox',status:'completed',text:JSON.stringify({textSnippet:'单位净值 (2026-10-12)\n4.0145',links:[{href:'https://example.com/2026-10-11'}],finalUrl:'https://example.com',observedAt:'2026-10-12T17:00:00Z'}),sources:[{id:'page',channel:'web',title:'公开页面',url:'https://example.com',observedAt:'2026-10-12T17:00:00Z'}],observation:{state:'available',observedAt:'2026-10-12T17:00:00Z'},artifacts:[]};
const check=(candidate:string,observations=[page])=>checkSourceDates({candidate,observations,userText:'读取网页的数值和日期',timezone:'Asia/Shanghai',currentTime:'2026-10-13T02:00:00Z'});
const pass=(ids=['page'],extra={})=>fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:ids,missing:[],summary:'',responseKind:'result',claimsSupported:true,sourceDatesSupported:true,...extra}));
function binding(responses:Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]){const f=fauxProvider({tokensPerSecond:100000});f.setResponses(responses);const m=createModels();m.setProvider(f.provider);return{model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};}
describe('source date fidelity',()=>{
 it('does not feed unverified tool-turn commentary into the answer after reading the source',async()=>{
  let id='';const browse=vi.fn(async()=>({status:page.status,text:page.text,sources:page.sources,observation:page.observation!}));
  const model=binding([
   fauxAssistantMessage([{type:'text',text:'UNVERIFIED_OLD_ENTITY_AND_CALENDAR'},fauxToolCall('browse_in_sandbox',{url:'https://example.com'})],{stopReason:'toolUse'}),
   ctx=>{const payload=JSON.stringify(ctx.messages);expect(payload).not.toContain('UNVERIFIED_OLD_ENTITY_AND_CALENDAR');expect(payload).toContain('browse_in_sandbox');expect(payload).toContain('4.0145');id=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('页面标注：2026-10-12，4.0145。');},
   ()=>pass([id])]);
  const r=await new DelegatePiAgentRuntime().run({runId:'dates',sessionId:'dates',executionProtocol:'goal_v2',contextAuthorization:fixtureContextAuthority('dates'),userText:'读取网页数值及日期',representative:{name:'rep',role:'general'},model,capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(r.status).toBe('completed');expect(browse).toHaveBeenCalledOnce();expect(r.messages.some(m=>JSON.stringify(m).includes('UNVERIFIED_OLD_ENTITY_AND_CALENDAR'))).toBe(true);
 });

 it.each(['页面标注日期为2026-10-12，数值4.0145。','数据日期：2026年10月12日（星期一）。','2026-10-12 (Monday).','数据日期2026-10-12；页面观察时间2026-10-13 01:00（北京时间）。','数据日期2026-10-12，不是2026-10-11。'])('accepts faithful dates: %s',text=>expect(check(text).failures).toEqual([]));
 it.each(['2026年10月12日（即昨日，星期日）','2026-10-12 (Sunday)','页面标为2026-10-12，实际是2026-10-11。','发布时间有T+1延迟，因此数据日期是2026-10-11。','数据日期为2026-02-30。','北京时间数据日期：2026-10-13。'])('blocks an incorrect or unsupported date even without a semantic rejection: %s',text=>expect(check(text).failures.length).toBeGreaterThan(0));
 it('does not borrow calendar weekdays from a neighboring date',()=>{
  expect(check('2026-10-12 与2026-10-13（星期二）。',[{...page,text:'活动日期：2026-10-12 至2026-10-13'}]).failures).toEqual([]);
 });
 it('handles spaced dates and negated weekdays without approving a contradictory positive weekday',()=>{
  expect(check('2026 年 10 月 12 日不是星期日，而是星期一。').failures).toEqual([]);
  expect(check('2026 年 10 月 12 日不是星期一，而是星期日。').failures.length).toBeGreaterThan(0);
 });
 it('does not borrow an unsupported replacement date from an unselected page',async()=>{
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'读取日期',representative:{name:'rep',role:'general'},model:binding([pass()])},candidate:'数据日期2026-10-11。',observations:[page,{...page,callId:'unrelated',text:'另一个对象的数据日期2026-10-11'}],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);expect(r.failureCodes).toContain('source_date_fidelity');
 });
 it('allows converting an explicit timestamp across a calendar day, not a date-only field',()=>{
  expect(check('当地发生时间为2026-10-13T01:00:00+08:00。',[{...page,text:'事件发生于2026-10-12T17:00:00Z。'}]).failures).toEqual([]);
  expect(check('当地数据日期为2026-10-13。').failures.length).toBeGreaterThan(0);
  expect(check('当地发生时间为2026-10-13T02:00:00+08:00。',[{...page,text:'事件发生于2026-10-12T17:00:00Z。'}]).failures.length).toBeGreaterThan(0);
  expect(check('当地发生时间为2026-10-11T18:00:00-07:00。',[{...page,text:'事件发生于2026-10-12T01:00:00Z。'}]).failures).toEqual([]);
  expect(check('数据日期2026-10-12T00:00:00Z。').failures.length).toBeGreaterThan(0);
 });
 it('allows an explicitly evidenced calculation without treating it as a source date rewrite',()=>{
  expect(check('计算出的截止日期为2026-10-19。',[page,{...page,callId:'calc',toolName:'execute_in_sandbox',text:'用户要求加7日；计算结果2026-10-19'}]).failures).toEqual([]);
 });
 it('does not use dates from failed reads as positive evidence',()=>{
  expect(check('实际数据日期2026-10-11。',[page,{...page,status:'failed',text:'2026-10-11'}]).failures.length).toBeGreaterThan(0);
 });
 it('does not invent a year when the source only gives a month and day',()=>{
  expect(check('数据日期为2026-10-12。',[{...page,text:'页面仅标注日期10-12，数值4.0145'}]).failures.length).toBeGreaterThan(0);
  expect(check('页面标注日期为10-12，未注明年份。',[{...page,text:'页面仅标注日期10-12，数值4.0145'}]).failures).toEqual([]);
 });
 it('blocks invented calendar explanations even when the numeric date is unchanged',()=>{
  expect(check('数据日期2026-10-12（即今日前一个交易日，因净值通常在交易日收盘后更新）。').failures.length).toBeGreaterThan(0);
  expect(check('数据日期2026-10-12。注：数据通常在当晚20:00后公布。').failures.length).toBeGreaterThan(0);
  expect(check('Data date: 2026-10-12 (the previous trading day because of a publication delay).').failures.length).toBeGreaterThan(0);
 });
 it('allows an actual source explanation and does not require calendar commentary',()=>{
  const text='数据日期2026-10-12。该报告通常于工作日公布';
  expect(check(text,[{...page,text}]).failures).toEqual([]);
  expect(check('数据日期2026-10-12。不能因为T+1就把日期前移。').failures).toEqual([]);
 });
 it('overrides a permissive reviewer on the actual regression',async()=>{
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'读取网页净值和日期',representative:{name:'rep',role:'general'},model:binding([pass()])},candidate:'2026年10月12日是星期日，实际为2026年10月11日的净值。',observations:[page],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);expect(r.failureCodes).toContain('source_date_fidelity');expect(r.repairEvidenceReferences).not.toBe(true);
 });
 it('honors a semantic date-fidelity rejection even when dates themselves occur in the page',async()=>{
  const r=await assessGoalCompletion({run:{runId:'r',sessionId:'s',userText:'读取网页净值和日期',representative:{name:'rep',role:'general'},model:binding([pass(['page'],{sourceDatesSupported:false})])},candidate:'页面日期2026-10-12，属于网站统一展示惯例。',observations:[page],signal:AbortSignal.timeout(1000)});
  expect(r.releaseCandidate).toBe(false);
 });
 it('corrects the draft using the original page without another browser request',async()=>{
  let id='';const browse=vi.fn(async()=>({status:page.status,text:page.text,sources:page.sources,observation:page.observation!}));
  const good='页面最新单位净值4.0145，标注日期2026-10-12。';
  const result=await new DelegatePiAgentRuntime().run({runId:'dates',sessionId:'dates',executionProtocol:'goal_v2',contextAuthorization:fixtureContextAuthority('dates'),userText:'用沙盒浏览器读取净值及日期',representative:{name:'rep',role:'general'},model:binding([
   fauxAssistantMessage(fauxToolCall('browse_in_sandbox',{url:'https://example.com'}),{stopReason:'toolUse'}),
   ctx=>{id=(ctx.messages.at(-1) as any).toolCallId;return fauxAssistantMessage('页面标2026-10-12（星期日），但实际是2026-10-11。');},()=>pass([id]),
   ctx=>{expect(JSON.stringify(ctx.messages)).toContain('Monday');return fauxAssistantMessage(good);},()=>pass([id])]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
  expect(result.status).toBe('completed');expect(result.text).toBe(good);expect(browse).toHaveBeenCalledOnce();expect(result.modelCalls).toBe(5);
 });
});
