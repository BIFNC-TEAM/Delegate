import {describe,it,expect} from 'vitest';
import {createModels,fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {assessGoalCompletion} from '../src/pi/execution-state';
import {checkSourceDates,dateAssertions,type DateMeaning} from '../src/pi/source-dates';
import type {PiToolObservation} from '../src/pi/types';
const quote='净值日期\t单位净值\n2026-10-12\t4.0145';
const page:PiToolObservation={callId:'page',toolName:'browse_in_sandbox',status:'completed',text:JSON.stringify({textSnippet:quote,finalUrl:'https://example.invalid'}),sources:[{id:'source',title:'Source',channel:'web',url:'https://example.invalid'}],artifacts:[],observation:{state:'available',observedAt:'2026-10-13T08:58:36.132Z'}};
function check(candidate:string,options:{basis?:DateMeaning['basis'];callId?:string|null;body?:string;observations?:PiToolObservation[];supported?:boolean}={}){
 const body=options.body??quote;
 const observations=options.observations??[{...page,text:JSON.stringify({textSnippet:body})}];
 return checkSourceDates({candidate,observations,userText:'读取数据与日期',currentTime:'2026-10-13T09:00:00Z',timezone:'Asia/Shanghai',
  dateMeanings:dateAssertions(candidate).map(a=>({id:a.id,basis:options.basis??'page_field',...(options.callId===null?{}:{callId:options.callId??'page'}),sourceQuote:body,supported:options.supported??true}))});
}
describe('date assertion isolation and evidence semantics',()=>{
 it('keeps the complete original clause and does not attach the next field to an observation',()=>{
  const rows=dateAssertions('2026年10月13日16:58（北京时间）观测。页面显示净值日期2026-10-12，单位净值4.0145。');
  expect(rows.map(r=>r.text)).toEqual(['2026年10月13日16:58（北京时间）观测','页面显示净值日期2026-10-12，单位净值4.0145']);
  expect(rows.map(r=>r.id)).toEqual(['claim_2026-10-13_1','claim_2026-10-12_2']);
 });
 it('separates a snapshot gap from the positive date that follows it',()=>{
  expect(dateAssertions('本次片段未显示2026-10-13的数据；页面日期2026-10-12。').map(r=>r.text))
   .toEqual(['本次片段未显示2026-10-13的数据','页面日期2026-10-12']);
 });
 it.each(['观测时间：2026年10月13日16:58（北京时间）。','2026年10月13日16:58（北京时间）观测。'])('accepts the receipt date with either label position: %s',candidate=>{
  expect(check(candidate,{basis:'fetch_timestamp'}).failures).toEqual([]);
 });
 it('binds an omitted optional snapshot reference only when exactly one browser source was selected',()=>{
  const candidate='本次抓取片段未显示2026-10-13的数据。';
  expect(check(candidate,{basis:'missing_in_snapshot',callId:null}).failures).toEqual([]);
  expect(check(candidate,{basis:'missing_in_snapshot',callId:'forged'}).failures.length).toBeGreaterThan(0);
  expect(check(candidate,{basis:'missing_in_snapshot',callId:null,observations:[page,{...page,callId:'other'}]}).failures.length).toBeGreaterThan(0);
  expect(check(candidate,{basis:'missing_in_snapshot',callId:null,observations:[{...page,toolName:'retrieve_authorized_knowledge'}]}).failures.length).toBeGreaterThan(0);
 });
 it.each(['发布日期为2026-10-12。','更新时间为2026年10月12日收盘后。','2026-10-12收盘后更新。'])('rejects an invented event meaning even when the date and model approval match: %s',candidate=>{
  const result=check(candidate);expect(result.failures.some(f=>f.includes('does not state'))).toBe(true);
 });
 it.each(['净值日期2026-10-12。','最新公布的单位净值为4.0145，数据日期为2026-10-12。','截至2026年10月12日（最新已公布净值日）的数值为4.0145。'])('does not confuse a published value with its publication time: %s',candidate=>{
  expect(check(candidate).failures).toEqual([]);
 });
 it('accepts a publication date the source actually states, including reordered wording',()=>{
  expect(check('2026年10月12日发布。',{body:'公布日期：2026-10-12'}).failures).toEqual([]);
 });
 it('does not borrow a publication label from an adjacent table column',()=>{
  const body='净值日期\t发布日期\n2026-10-12\t2026-10-13';
  expect(check('发布日期为2026-10-12。',{body}).failures.some(f=>f.includes('does not state'))).toBe(true);
  expect(check('发布日期为2026-10-13。',{body}).failures).toEqual([]);
 });
 it('does not turn an update date into an intraday closing assertion',()=>{
  expect(check('2026-10-12收盘后更新。',{body:'更新时间：2026-10-12'}).failures.some(f=>f.includes('does not state'))).toBe(true);
 });
 it('does not borrow an event label elsewhere on the page when the selected quote is only a value date',()=>{
  const candidate='发布日期为2026-10-12。';
  const other={...page,text:JSON.stringify({textSnippet:quote+'\n\n另一项目的公布日期：2026-10-12'})};
  const result=checkSourceDates({candidate,observations:[other],userText:'读取数据',dateMeanings:[{id:dateAssertions(candidate)[0]!.id,basis:'page_field',callId:'page',sourceQuote:quote,supported:true}]});
  expect(result.failures.some(f=>f.includes('cited field does not support'))).toBe(true);
 });
 it('keeps calendar checks independent of model approval',()=>{
  expect(check('净值日期2026-10-12（星期日）。').failures.some(f=>f.includes('Monday'))).toBe(true);
 });
 it('enforces source meaning at the real completion gate without changing the model decision to claim a semantic pass',async()=>{
  const candidate='发布日期为2026-10-12。';const p=fauxProvider({tokensPerSecond:100000});
  p.setResponses([context=>{
   const request=JSON.parse(String(context.messages[0]?.content));
   expect(request.dateAssertions).toEqual([{id:'claim_2026-10-12_1',date:'2026-10-12',text:'发布日期为2026-10-12'}]);
   return fauxAssistantMessage(JSON.stringify({verdict:'complete',requiresEvidence:true,evidenceIds:['page'],missing:[],summary:'',responseKind:'result',claimsSupported:true,
    dateMeanings:[{id:request.dateAssertions[0].id,basis:'page_field',callId:'page',sourceQuote:quote,supported:true}],
    conversationCheck:{inputRelation:'new_request',resolvedRequest:{kind:'public_lookup',target:'value',targetSpecified:true,targetSourceIndex:0,outcome:'read value'},ambiguityEvidenceIds:[],anchorIndex:0,taskAlignment:'on_task',revivesUnrequestedTasks:false,clarificationNeeded:false,missingInputs:[],blockingPersonalInputs:[],alreadyProvided:false,repeatsAuthorization:false}}));
  }]);const m=createModels();m.setProvider(p.provider);
  const result=await assessGoalCompletion({run:{runId:'meaning',sessionId:'meaning',conversationContextMode:'focused_v1',userText:'读取数据',representative:{name:'rep',role:'general'},model:{model:p.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:p.getModel().id}},candidate,observations:[page],signal:AbortSignal.timeout(1000)});
  expect(result.releaseCandidate).toBe(false);expect(result.failureCodes).toContain('source_date_fidelity');
 });
});
