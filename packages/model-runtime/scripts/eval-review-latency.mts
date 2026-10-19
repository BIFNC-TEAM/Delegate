/** Fixed-review timing comparison; no main Agent, application DB or real tools. */
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createPiModelBindingFromEnv} from '../src/pi/provider.ts';
import {resolveModelRuntimeEnv} from '../src/config.ts';
import {measureGoalAssessment} from './review-latency-probe.ts';
import {evaluateGroundingDecision} from './grounding-evaluation.ts';
import type {PiModelBinding,PiAgentRunInput} from '../src/pi/types.ts';
const root=resolve(process.env.EVAL_OUTPUT_DIR??'reports/agent-remediation/20260930-review-latency');
const protocol=JSON.parse(await readFile(resolve(process.env.EVAL_PROTOCOL??`${root}/protocol.json`),'utf8'));
const env=resolveModelRuntimeEnv(process.env);
if(env.timeoutMs!==protocol.requestTimeoutMs||(process.env.DELEGATE_PI_MODEL_MAX_RETRIES!==undefined&&process.env.DELEGATE_PI_MODEL_MAX_RETRIES!=='1'))throw new Error('comparison_baseline_configuration_changed');
await mkdir(root,{recursive:true});
const records:any[]=[];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function runCase(step:{id:string;repeat:number;arm:string}){
 const item=protocol.cases.find((c:any)=>c.id===step.id);if(!item)throw new Error('unknown_fixture');
 const path=resolve(root,`${step.id}--${step.arm}--${step.repeat}.json`);
 try{await access(path);throw new Error('refusing_to_overwrite_prior_result');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const trialEnv={...process.env,DELEGATE_AGICTO_MODEL:protocol.model,...(step.arm==='no_retry'?{DELEGATE_PI_MODEL_MAX_RETRIES:'0'}:{})};
 const configured=createPiModelBindingFromEnv(trialEnv,'agicto');if(!configured.ok)throw new Error(configured.reason);
 if(configured.binding.provider!==protocol.provider||configured.binding.modelId!==protocol.model)throw new Error('model_binding_changed');
 const real=configured.binding;let inputMatches=false;
 const binding:PiModelBinding={...real,streamFn:(model,context,options)=>{
  assert.equal(context.systemPrompt,item.systemPrompt,'system prompt drift');
  assert.equal(context.messages.length,1);assert.equal(context.messages[0]!.content,item.requestContent,'review payload drift');
  inputMatches=true;return real.streamFn(model,context,options);
 }};
 const p=item.payload;
 console.log(JSON.stringify({event:'case_start',...step,maximumRetries:protocol.arms[step.arm]}));
 const measured=await measureGoalAssessment({run:{runId:`latency-${step.id}-${step.arm}-${step.repeat}`,sessionId:`latency-${step.id}-${step.arm}-${step.repeat}`,model:binding,userText:p.goal,currentTime:p.currentTime,timezone:p.timezone,executionProtocol:'goal_v2',representative:p.representative,evidenceRequirements:p.evidenceRequirements,...(p.attachments?{attachments:p.attachments}:{})} as PiAgentRunInput,
  candidate:p.candidate,observations:p.observations,availableTools:p.availableCapabilities,signal:AbortSignal.timeout(protocol.logicalDeadlineMs)},
  {onProgress:event=>console.log(JSON.stringify({...step,...event}))});
 const evaluation=evaluateGroundingDecision({expectedRelease:item.expectedRelease,assessment:measured.assessment,error:measured.errorClass});
 const successfulHeaders=measured.attempts.filter(a=>a.status!==undefined&&a.status<400).at(-1);
 const durations={
  successfulHeaderWaitMs:successfulHeaders?.headersMs!==undefined?successfulHeaders.headersMs-successfulHeaders.startedMs:null,
  headersToFirstContentMs:successfulHeaders?.headersMs!==undefined&&measured.timing.firstContentMs!==undefined?measured.timing.firstContentMs-successfulHeaders.headersMs:null,
  headersToFirstTextMs:successfulHeaders?.headersMs!==undefined&&measured.timing.firstTextMs!==undefined?measured.timing.firstTextMs-successfulHeaders.headersMs:null,
  contentToCompletionMs:measured.timing.firstContentMs!==undefined&&measured.timing.completedMs!==undefined?measured.timing.completedMs-measured.timing.firstContentMs:null,
  textToCompletionMs:measured.timing.firstTextMs!==undefined&&measured.timing.completedMs!==undefined?measured.timing.completedMs-measured.timing.firstTextMs:null,
 };
 const report={...step,inputMatches,semanticInputHash:sha(JSON.stringify({systemPrompt:item.systemPrompt,content:item.requestContent})),configuredRequestTimeoutMs:protocol.requestTimeoutMs,logicalDeadlineMs:protocol.logicalDeadlineMs,maximumRetries:protocol.arms[step.arm],provider:real.provider,model:real.modelId,evaluation,durations,...measured};
 await writeFile(path,JSON.stringify(report,null,2));records.push(report);
 await writeFile(resolve(root,'results.json'),JSON.stringify(records,null,2));
 console.log(JSON.stringify({event:'case_complete',...step,attempts:measured.attempts.length,elapsedMs:measured.elapsedMs,firstContentMs:measured.timing.firstContentMs,firstTextMs:measured.timing.firstTextMs,status:measured.response?.stopReason,evaluation:evaluation.status}));
 if(!inputMatches)throw new Error('evaluation_input_integrity_failed');
}
for(const step of protocol.schedule)await runCase(step);
const supplementary=records.every(r=>r.elapsedMs<30000&&r.attempts.length===1);
await writeFile(resolve(root,'supplement-decision.json'),JSON.stringify({runSupplement:supplementary,reason:supplementary?'No slow call or retry reproduced in the initial eight; apply predeclared additional pair.':'A slow call or multiple attempts was observed; no additional requests needed.'},null,2));
if(supplementary)for(const arm of ['no_retry','default_retry'])await runCase({id:'supplement-slow-clarification',repeat:1,arm});
assert(records.every(r=>r.inputMatches));
