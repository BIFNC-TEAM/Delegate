// Live model evaluation with synthetic tool observations. Prices/times below are fixtures, not market or travel data.
import { writeFile } from 'node:fs/promises';
import { createPiModelBindingFromEnv, DelegatePiAgentRuntime } from '../src/pi/index.ts';
const binding = createPiModelBindingFromEnv();
if (!binding.ok) throw new Error(binding.reason);
const fixtures = [
 {name:'event',question:'请读取 https://example.com/event 上的星河大会日程，告诉我今天几点开始。',page:'星河大会 今日 09:00 开幕，主会场A。',expected:'09:00'},
 {name:'stock',question:'查下阿里今天的股票如何。',page:'阿里巴巴 9988.HK 今日收盘价 120.00 HKD，较前日上涨2.0%，截至今日16:00香港交易所收盘。',expected:'120'},
 {name:'travel',question:'查明天城际快线的首班车时间。',page:'城际快线 明日 首班06:30，末班22:00。',expected:'06:30'},
 {name:'software',question:'请用沙盒浏览器查 https://example.com/orion 中 Orion Editor 的最新版本号。',page:'Orion Editor 最新稳定版 4.2.1，发布于今日。',expected:'4.2.1'},
 {name:'blocked',question:'请读取 https://www.damai.cn ，告诉我首页现在列出的第一个演出。',page:'Too Many Requests',blocked:true,expected:null},
];
const reports=[];
for (const f of fixtures.filter(f => !process.env.EVAL_CASE || f.name === process.env.EVAL_CASE)) {
 const calls:string[]=[];
 const result=await new DelegatePiAgentRuntime().run({runId:`eval-${f.name}`,sessionId:`eval-${f.name}`,executionProtocol:'goal_v2',userText:f.question,representative:{name:'地理AI',ownerName:'测试',role:'地理教学助手',capabilities:['浏览器','MCP']},model:binding.binding,maxSteps:8,timeoutMs:120000,capabilities:{
 sandbox:{execute:async()=>({status:'unavailable',text:'Code fixture unavailable'}),browse:async({url})=>{calls.push('browser:'+url);return {status:'completed',text:f.page,observation:{state:f.blocked?'blocked':'available',httpStatus:f.blocked?429:200},sources:[{id:'page',title:f.name,channel:'web',url}]};}},
 mcp:{listTools:async()=>[{server:'weather',name:'current',description:'Read current local weather only.',inputSchema:{type:'object',properties:{city:{type:'string'}}},readOnly:true,idempotent:true}],callTool:async()=>{calls.push('weather');return {status:'completed',text:'杭州气温31度，晴',sources:[{id:'weather',title:'Weather',channel:'mcp'}]};}}
 }});
 const pass=f.expected ? result.status==='completed' && result.text.includes(f.expected) && !calls.includes('weather') : result.status!=='completed' && calls.some(c=>c.startsWith('browser:'));
 const report={name:f.name,pass,status:result.status,calls,text:result.text,modelCalls:result.modelCalls,durationMs:result.totalDurationMs}; reports.push(report);console.log(JSON.stringify(report));
}
await writeFile(new URL('../../../reports/agent-execution-loop/model-eval.json', import.meta.url),JSON.stringify(reports,null,2));
if(reports.some(r=>!r.pass))process.exitCode=1;
