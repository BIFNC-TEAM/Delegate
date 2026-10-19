import {createModels, fauxAssistantMessage, fauxProvider, fauxToolCall} from '@earendil-works/pi-ai';
import {describe, expect, it, vi} from 'vitest';
import {DelegatePiAgentRuntime} from '../src/pi/runtime';
import type {PiModelBinding} from '../src/pi/types';
import {fixtureContextAuthority} from './context-authority-fixture';
function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]): PiModelBinding {
  const f=fauxProvider({tokensPerSecond:100000}); f.setResponses(responses);
  const m=createModels();m.setProvider(f.provider);
  return {model:f.getModel(),streamFn:m.streamSimple.bind(m),provider:'faux',modelId:f.getModel().id};
}
const base={runId:'run',sessionId:'old-session',executionProtocol:'goal_v2' as const,reviewMode:'bounded_v1' as const,
  contextAuthorization:fixtureContextAuthority('run'),representative:{name:'教学数字代表',role:'地理教学'},maxSteps:12};
const call=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const assessment=(supported:boolean)=>fauxAssistantMessage(JSON.stringify({verdict:supported?'partial':'continue',responseKind:'result',requiresEvidence:false,
  evidenceIds:[],missing:supported?[]:['Unsupported condition'],summary:'',claimsSupported:supported}));
const reviews=(r:any)=>r.spans.filter((s:any)=>s.operation==='goal_assessment');
describe('bounded review delivery',()=>{
  it.each(['你好','你是谁来着','亚洲地势有什么特点'])('delivers ordinary prose without review: %s',async userText=>{
    const text='我是教学数字代表，可以解释地理知识。';
    const r=await new DelegatePiAgentRuntime().run({...base,userText,model:binding([fauxAssistantMessage(userText==='你好'?JSON.stringify({answer:text,taskType:'greeting',needsVerification:false,sourceId:''}):text)])});
    expect(r.text).toBe(text);expect(r.modelCalls).toBe(1);expect(reviews(r)).toHaveLength(0);expect(r.status).toBe('completed');
  });
  it('preserves existing greeting context isolation in an old conversation',async()=>{
    let prompt='',toolNames:string[]=[];
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'你好',history:[{role:'user',text:'苹果最新款手机是哪个型号',taskAnchor:true}],model:binding([
      context=>{prompt=JSON.stringify(context.messages);toolNames=(context.tools??[]).map(t=>t.name);return fauxAssistantMessage(JSON.stringify({taskType:'greeting',needsVerification:false,sourceId:'',answer:'你好！'}));}
    ])});
    expect(prompt).not.toContain('苹果');expect(toolNames).toEqual([]);expect(r.text).toBe('你好！');expect(r.modelCalls).toBe(1);
  });
  it('keeps a bounded partial answer and source after one browser read without review or excerpts',async()=>{
    const text='页面列出两款新品，未说明它们的发布时间先后。';
    const browse=vi.fn(async()=>({status:'completed',text:JSON.stringify({textSnippet:'[heading] "新品 甲"\n\n[heading] "新品 乙"'}),
      observation:{state:'available' as const},sources:[{id:'page',title:'产品页',channel:'web' as const,url:'https://example.com'}]}));
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'浏览网页查看新品',model:binding([
      call('browse_in_sandbox',{url:'https://example.com'}),fauxAssistantMessage(text)]),capabilities:{sandbox:{execute:vi.fn(),browse}}});
    expect(r.text).toBe(text);expect(r.modelCalls).toBe(2);expect(browse).toHaveBeenCalledOnce();expect(r.sources.map(s=>s.id)).toEqual(['page']);
    expect(reviews(r)).toHaveLength(0);expect(r.spans.some(s=>s.operation==='source_excerpt_fallback')).toBe(false);
  });
  it('delivers ordinary retrieved knowledge without requiring an independent review',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'亚洲地势有什么特点',knowledgePrefetch:'ordinary_questions_v1',model:binding([fauxAssistantMessage('亚洲地势中部高、四周低。')]),
      capabilities:{knowledge:{retrieve:async()=>({status:'found',text:'亚洲地势中部高、四周低。',sources:[{id:'geo',title:'地理',channel:'knowledge'}]})}}});
    expect(r.modelCalls).toBe(1);expect(r.sources.map(s=>s.id)).toEqual(['geo']);expect(reviews(r)).toHaveLength(0);
  });
  it.each([false,true])('host-required review is exactly once and never rewrites: supported=%s',async supported=>{
    const text='当前资料仅支持部分条件。';
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'解释已有材料',semanticReviewRequired:true,
      model:binding([fauxAssistantMessage(text),assessment(supported),fauxAssistantMessage('MUST NOT REWRITE')])});
    expect(r.modelCalls).toBe(2);expect(reviews(r)).toHaveLength(1);expect(r.text).not.toContain('MUST NOT REWRITE');
    expect(r.text===text).toBe(supported);expect(r.spans.some(s=>s.operation==='source_excerpt_fallback')).toBe(false);
  });
  it('does not retry malformed critical review and distinguishes its error from semantic rejection',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'解释授权条件',semanticReviewRequired:true,
      model:binding([fauxAssistantMessage('DRAFT'),fauxAssistantMessage('invalid json'),assessment(true)])});
    expect(r.modelCalls).toBe(2);expect(reviews(r)).toHaveLength(1);expect(r.text).toContain('核验未完成');expect(r.text).not.toContain('DRAFT');
  });
  it('keeps the host evidence obligation even if a permissive reviewer approves an unsupported result',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'查询当前公开信息',evidenceRequirements:{evidence:true},
      model:binding([fauxAssistantMessage('UNSOURCED RESULT'),assessment(true),fauxAssistantMessage('RETRY')])});
    expect(r.modelCalls).toBe(2);expect(reviews(r)).toHaveLength(1);expect(r.text).not.toContain('UNSOURCED');expect(r.text).not.toContain('RETRY');
  });
  it('can deliver a necessary clarification without requiring nonexistent result evidence',async()=>{
    const text='请提供要查询的对象。';
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'查询当前公开信息',evidenceRequirements:{evidence:true},
      model:binding([fauxAssistantMessage(text),fauxAssistantMessage(JSON.stringify({verdict:'waiting_user',responseKind:'clarification',requiresEvidence:true,
        evidenceIds:[],missing:['object'],summary:'',claimsSupported:true}))])});
    expect(r.modelCalls).toBe(2);expect(r.text).toBe(text);expect(r.status).toBe('waiting_user');
  });
  it('does not recover truncated prose with an extra generation',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'解释地形',model:binding([fauxAssistantMessage('INCOMPLETE',{stopReason:'length'}),fauxAssistantMessage('RETRY')])});
    expect(r.modelCalls).toBe(1);expect(r.text).not.toContain('INCOMPLETE');expect(r.text).not.toContain('RETRY');expect(r.status).not.toBe('completed');
  });
  it('keeps requested execution and approval barriers without model review',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'在沙盒中计算1+2',model:binding([fauxAssistantMessage('已用沙盒算出3')])});
    expect(r.text).not.toContain('已用沙盒');expect(r.modelCalls).toBe(1);expect(r.status).not.toBe('completed');
    const p=await new DelegatePiAgentRuntime().run({...base,userText:'在沙盒中计算1+2',model:binding([call('execute_in_sandbox',{language:'python',code:'print(3)'})]),
      capabilities:{sandbox:{execute:async()=>({status:'pending_approval',text:'pending',details:{approvalId:'approval'}})}}});
    expect(p.status).toBe('waiting_approval');expect(reviews(p)).toHaveLength(0);
  });
  it('cannot publish after authorization is revoked',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'你好',contextAuthorization:{...fixtureContextAuthority('run'),check:async boundary=>{if(boundary==='release')throw Error('revoked');}},
      model:binding([fauxAssistantMessage('DO NOT RELEASE')])});
    expect(r.text).not.toContain('DO NOT RELEASE');expect(r.status).not.toBe('completed');
  });
  it('does not show failed public lookups as successful results',async()=>{
    const r=await new DelegatePiAgentRuntime().run({...base,userText:'查询网页信息',model:binding([call('browse_in_sandbox',{url:'https://example.com'}),fauxAssistantMessage('网页已经成功核实全部信息。')]),
      capabilities:{sandbox:{execute:vi.fn(),browse:async()=>({status:'completed',text:'empty',observation:{state:'empty',reason:'empty_page'}})}}});
    expect(r.text).not.toContain('成功核实');expect(r.status).toBe('partial');expect(r.sources).toHaveLength(0);expect(r.modelCalls).toBe(2);
  });
});
