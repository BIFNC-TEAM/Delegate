/** Paired whole-Agent evaluation. The only arm difference is the goal-review binding.
 * Real model calls use existing configured credentials; all tools/data are synthetic. */
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createModels,fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {DelegatePiAgentRuntime,createPiModelBindingFromEnv} from '../src/pi/index.ts';
import type {PiModelBinding} from '../src/pi/types.ts';
import {createReviewerComparisonBinding} from './reviewer-comparison-binding.ts';
const root=resolve(process.env.EVAL_OUTPUT_DIR??'reports/agent-remediation/20260930-review-only');
const protocol=JSON.parse(await readFile(resolve(process.env.EVAL_PROTOCOL??`${root}/protocol.json`),'utf8'));
await mkdir(root,{recursive:true});
const main=createPiModelBindingFromEnv();
const candidate=createPiModelBindingFromEnv({...process.env,DELEGATE_AGICTO_MODEL:'gpt-5.5'},'agicto');
if(!main.ok||!candidate.ok)throw new Error('configured_comparison_models_unavailable');
if(main.binding.modelId!=='qwen-plus'||candidate.binding.modelId!=='gpt-5.5'||main.binding.provider!=='agicto'||candidate.binding.provider!=='agicto')throw new Error('comparison_model_baseline_changed');
const policySeed=JSON.parse(await readFile('reports/agent-remediation/20260930-advice-boundary/agent-after.json','utf8'));
const sourceSeed=JSON.parse(await readFile('reports/agent-remediation/20260929-d19/final-b/public-history.json','utf8'));
const filters=new Set((process.env.EVAL_CASES??'').split(',').filter(Boolean));
const selected=protocol.cases.filter((c:any)=>!filters.size||filters.has(c.id));
if(!selected.length)throw new Error('empty_case_selection');
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
for(const item of selected){
 const seed=item.prefix==='recorded_source'?sourceSeed:policySeed;
 const page=item.webFixture??protocol.webFixture;
 const index=protocol.cases.findIndex((c:any)=>c.id===item.id);
 const arms=index%2?['review_candidate','baseline']:['baseline','review_candidate'];
 for(const arm of arms){
  const output=resolve(root,`${item.id}--${arm}.json`);
  try{await access(output);throw new Error(`refusing_to_overwrite:${item.id}:${arm}`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const calls:any[]=[];const requests:any[]=[];const replayed:any[]=[];
  let mainCalls=0;
  const faux=fauxProvider({tokensPerSecond:100000});
  const good='开课前48小时及以上取消可退70%的报名费；不足48小时不退款。该条款适用于所有已报名学员。若您还想了解具体申请方式，可以向相关人员询问。';
  if(item.prefix)faux.setResponses(seed.requests.slice(0,2).map((r:any,i:number)=>fauxAssistantMessage(i===1&&item.prefix==='synthetic_good'?good:r.response.content,{stopReason:r.response.stopReason})));
  const replayModels=createModels();replayModels.setProvider(faux.provider);
  const capture=(binding:PiModelBinding,phase:'primary'|'review'):PiModelBinding=>{
   const wrap=(stream:PiModelBinding['streamFn']):PiModelBinding['streamFn']=>async(m,context,options)=>{
    if(phase==='primary'&&item.prefix&&mainCalls++<2){
     replayed.push({phase,model:'recorded_or_synthetic_prefix',inputHash:sha(context.messages)});
     return replayModels.streamSimple(faux.getModel(),context,options);
    }
    const started=performance.now();
    const record:any={phase,provider:binding.provider,requestedModel:binding.modelId,selectedModel:m.id,inputHash:sha({systemPrompt:context.systemPrompt,messages:context.messages}),systemPrompt:context.systemPrompt,messages:structuredClone(context.messages),tools:context.tools?.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))};
    requests.push(record);
    const events=await stream(m,context,{...options,onPayload:async(payload,selectedModel)=>{
     const body=payload as Record<string,any>;
     record.wire={model:body.model,messageHash:sha(body.messages),roles:body.messages?.map((v:any)=>v.role),maxTokens:body.max_tokens??body.max_completion_tokens};
     return options?.onPayload?.(payload,selectedModel);
    }});
    void events.result().then(response=>{
     record.elapsedMs=Math.round(performance.now()-started);
     record.response={...response,content:response.content.filter(p=>p.type!=='thinking')};
     console.log(JSON.stringify({event:'model_finished',case:item.id,arm,phase,model:binding.modelId,stopReason:response.stopReason,elapsedMs:record.elapsedMs}));
    }).catch(e=>{record.errorClass=e instanceof Error?e.name:'unknown';});
    return events;
   };
   return {...binding,streamFn:wrap(binding.streamFn),...(binding.createObservedStreamFn?{createObservedStreamFn:(observer,before)=>wrap(binding.createObservedStreamFn!(observer,before))}:{})};
  };
  const model=createReviewerComparisonBinding(capture(main.binding,'primary'),capture(arm==='baseline'?main.binding:candidate.binding,'review'));
  const started=performance.now();
  let result:any,error:string|undefined;
  try{
   result=await new DelegatePiAgentRuntime().run({runId:`review-eval-${item.id}-${arm}`,sessionId:`review-eval-${item.id}-${arm}`,executionProtocol:'goal_v2',reviewMode:protocol.reviewMode,currentTime:protocol.currentTime,timezone:'Asia/Shanghai',maxSteps:protocol.maxSteps,timeoutMs:protocol.timeoutMs,model,userText:item.question,
    representative:{name:'合成课程代表',ownerName:'测试老师',role:'课程说明',agentBehavior:{version:1,answerScope:'open_public',knowledgePolicy:'owner_facts',commitmentPolicy:'information_only'}},
    capabilities:{
     knowledge:{retrieve:async({query})=>{calls.push({tool:'knowledge',query});return{status:'completed',text:protocol.policy,sources:[{id:'synthetic-course-policy',title:'合成课程取消条款',channel:'knowledge'}]};}},
     sandbox:{execute:async()=>{calls.push({tool:'compute'});return{status:'unavailable',text:'This evaluation adapter does not execute code.'};},browse:async({url})=>{
      calls.push({tool:'browser',url});
      if(url!==page.url)return{status:'unavailable',text:'The controlled evaluation exposes only the exact public fixture URL; no other page was read.',observation:{state:'unavailable'}};
      return{status:'completed',text:page.text,observation:{state:'available',httpStatus:200,observedAt:page.observedAt??protocol.currentTime},sources:page.sources??[{id:'synthetic-history',title:'合成公开历史记录',channel:'web',url,observedAt:protocol.currentTime}]};
     }},
    },
   });
  }catch(e){error=e instanceof Error?e.name:'unknown';}
  const routingCorrect=requests.every(r=>r.selectedModel===r.requestedModel&&(!r.wire||r.wire.model===r.requestedModel)&&r.requestedModel===(r.phase==='primary'||arm==='baseline'?'qwen-plus':'gpt-5.5'));
  const resultView=result?{status:result.status,text:result.text,modelCalls:result.modelCalls,toolCalls:result.toolCalls,sources:result.sources,artifacts:result.artifacts,error:result.error}:null;
  await writeFile(output,JSON.stringify({case:item.id,arm,question:item.question,prefix:item.prefix??null,environment:protocol.environment,elapsedMs:Math.round(performance.now()-started),routingCorrect,result:resultView,calls,replayed,requests,error,semanticPass:null,manualReviewRequired:true},null,2));
  console.log(JSON.stringify({event:'case_finished',case:item.id,arm,routingCorrect,status:result?.status,realCalls:requests.length,replayedCalls:replayed.length,tools:calls.length,error}));
 }
}
