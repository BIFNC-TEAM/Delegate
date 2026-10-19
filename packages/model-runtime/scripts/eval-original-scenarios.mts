/** Real configured model, actual Pi loop, synthetic adapters. No DB, cloud sandbox or business effects. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPiModelBindingFromEnv, DelegatePiAgentRuntime } from '../src/pi/index.ts';
import type { PiModelBinding, PiCapabilityResult } from '../src/pi/types.ts';

const currentTime = '2026-09-29T07:00:00.000Z';
type Call = { tool: string; input: unknown };
type Scenario = { id: string; question: string; kind: 'direct' | 'knowledge' | 'browser' | 'weather' | 'compute' | 'ask' | 'blocked' | 'empty'; page?: string; expected?: string[] };
const scenarios: Scenario[] = [
  { id: 'greeting', kind: 'direct', question: '你好' },
  { id: 'translation', kind: 'direct', question: '把“今天股票市场休市”翻译成英文，只给译文。', expected: ['closed'] },
  { id: 'geography', kind: 'direct', question: '为什么山上更冷，明明离太阳更近？', expected: ['气压'] },
  { id: 'owner-policy', kind: 'knowledge', question: '测试老师的课程取消后如何退费？', expected: ['24', '48', '全额'] },
  { id: 'explicit-browser', kind: 'browser', question: '使用沙盒浏览器获取最新的腾讯的股票信息', page: '腾讯控股 0700.HK；港股；价格546.50 HKD，涨幅1.20%；行情时间2026-09-29 14:45香港时间；盘中，延迟15分钟。', expected: ['546.50', '0700', '14:45'] },
  { id: 'public-stock', kind: 'browser', question: '查下阿里今天的股票如何，港股即可。', page: '阿里巴巴 9988.HK；港股；价格120.00 HKD，涨幅2.00%；行情时间2026-09-29 14:45香港时间；盘中，延迟15分钟。', expected: ['120', '9988', '14:45'] },
  { id: 'public-history', kind: 'browser', question: '请查询公开网页，告诉我1992年巴塞罗那奥运会开幕日期，并给出处。', page: '巴塞罗那1992年夏季奥运会于1992年7月25日开幕，8月9日闭幕。', expected: ['1992', '7月25'] },
  { id: 'weather-relevant', kind: 'weather', question: '杭州现在天气怎么样？', expected: ['31'] },
  { id: 'sandbox-calc', kind: 'compute', question: '在沙盒中计算1+2+1009等于多少', expected: ['1012'] },
  { id: 'browser-ask', kind: 'ask', question: '用沙盒浏览器读取 https://example.com/event 并告诉我活动时间。' },
  { id: 'browser-429', kind: 'blocked', question: '用沙盒浏览器查 https://example.com/event 首页第一个活动的开始时间。' },
  { id: 'browser-empty', kind: 'empty', question: '用沙盒浏览器查 https://example.com/event 首页第一个活动的开始时间。' },
  ...(process.env.EVAL_REAL_BROWSER === '1' ? [{ id: 'aio-public-page', kind: 'browser' as const,
    question: '用沙盒浏览器打开 https://example.com/，告诉我页面主标题，只给标题。', expected: ['Example Domain'] }] : []),
];
const filters = new Set((process.env.EVAL_CASE ?? '').split(',').filter(Boolean));
const selected = scenarios.filter(s => !filters.size || filters.has(s.id));
if (!selected.length) throw new Error('No matching EVAL_CASE');
const output = resolve(process.env.EVAL_OUTPUT_DIR ?? `reports/agent-remediation/20260929-d19/live-${Date.now()}`);
await mkdir(output, { recursive: true });
const binding = createPiModelBindingFromEnv();
if (!binding.ok) {
  await writeFile(resolve(output, 'blocked.json'), JSON.stringify({ status: 'blocked', reason: binding.reason }));
  throw new Error(binding.reason);
}
await writeFile(resolve(output, 'protocol.json'), JSON.stringify({
  startedAt: new Date().toISOString(), model: binding.binding.modelId, provider: binding.binding.provider, currentTime,
  environment: selected.some(s => s.id === 'aio-public-page')
    ? 'actual Pi + real model; aio-public-page uses a disposable Tencent AIO browser; other adapters synthetic; no app DB or business messages'
    : 'actual installed Pi + real model; synthetic public page/knowledge/MCP/sandbox receipts; no app DB or real tool effects',
  expectations: 'No unrelated tool effects. Direct answers need no tools; owner policy uses authorized KB; public queries use browser, not weather/owner KB; explicit browser uses browser; ASK stops; 429/empty cannot be completed. Synthetic results do not prove real URL discovery or AIO availability.',
  quality: 'Deterministic route/content assertions plus manual answer review; no independent blind review or population accuracy claim.',
  scenarios: selected,
}, null, 2));
const reports: unknown[] = [];
let failed = false;
for (const scenario of selected) {
  const calls: Call[] = [];
  const requests: unknown[] = [];
  const capture = (stream: PiModelBinding['streamFn']): PiModelBinding['streamFn'] => async (model, context, options) => {
    const captured: Record<string, unknown> = structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages,
      tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    requests.push(captured);
    const events = await stream(model, context, options);
    void events.result().then(message => { captured.response = message; }).catch(() => { captured.responseError = 'model_stream_failed'; });
    return events;
  };
  const real = binding.binding;
  const model: PiModelBinding = { ...real, streamFn: capture(real.streamFn),
    ...(real.createObservedStreamFn ? { createObservedStreamFn: (observer, before) => capture(real.createObservedStreamFn!(observer, before)) } : {}) };
  const record = (tool: string, input: unknown) => calls.push({ tool, input });
  const publicResult = (text: string, url: string): PiCapabilityResult => ({ status: 'completed', text,
    observation: { state: 'available', httpStatus: 200, observedAt: currentTime },
    sources: [{ id: `fixture-${scenario.id}`, title: '公开页面测试夹具', channel: 'web', url, observedAt: currentTime }] });
  const start = performance.now();
  const result = await new DelegatePiAgentRuntime().run({
    runId: `d19-${scenario.id}`, sessionId: `d19-${scenario.id}`, executionProtocol: 'goal_v2', currentTime,
    representative: { name: '地理AI', ownerName: '测试老师', role: '初中地理数字代表',
      agentBehavior: { version: 1, answerScope: 'open_public', knowledgePolicy: 'owner_facts', commitmentPolicy: 'information_only' } },
    model, userText: scenario.question, maxSteps: 8, timeoutMs: 90000, maxToolRetries: 0,
    capabilities: {
      knowledge: { retrieve: async ({ query }) => { record('knowledge', { query }); return {
        status: 'completed', text: '测试老师课程取消规则，适用所有已报名学员，2026-09-01生效：开课前24小时及以上取消可全额退款；不足24小时原则上不退。例外：因突发疾病取消，48小时内提交证明可全额退款。',
        sources: [{ id: 'owner-policy-fixture', title: '课程取消政策（合成资料）', channel: 'knowledge' }],
      }; } },
      sandbox: {
        execute: async ({ language, code, expectedOutputs }) => { record('compute', { language, code, expectedOutputs });
          return scenario.kind === 'compute' ? { status: 'completed', text: '1012', resultRef: 'synthetic-execution-calc' }
            : { status: 'unavailable', text: 'This synthetic adapter cannot obtain live public data.' }; },
        browse: async ({ url }) => { record('browser', { url });
          if (scenario.id === 'aio-public-page') {
            if (calls.filter(c => c.tool === 'browser').length > 1) return { status: 'unavailable', text: 'Integration fixture allows one cloud browser read.' };
            const { browsePublicFixture } = await import('./aio-public-browser-fixture.mts');
            return browsePublicFixture(url, async observation => { await writeFile(resolve(output, 'aio-observation.json'), JSON.stringify(observation, null, 2)); });
          }
          if (scenario.kind === 'ask') return { status: 'pending_approval', text: 'Owner approval required by configured browser ASK.', details: { approvalId: 'synthetic-approval' } };
          if (scenario.kind === 'blocked' || scenario.kind === 'empty') return { status: 'completed', text: scenario.kind === 'blocked' ? 'Too Many Requests' : '',
            observation: { state: scenario.kind === 'blocked' ? 'blocked' : 'empty', httpStatus: scenario.kind === 'blocked' ? 429 : 200, observedAt: currentTime } };
          return publicResult(scenario.page ?? '页面不包含请求的数据。', url);
        },
      },
      mcp: { listTools: async () => [{ server: 'open-meteo', name: 'current_weather', description: 'Only current weather for a city. Cannot provide stocks, historical events or owner policies.',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, effectClassification: 'read', readOnly: true, idempotent: true, approvalRequired: false }],
        callTool: async ({ arguments: args }) => { record('weather', args); return { status: 'completed', text: '杭州，31°C，晴；观测时间2026-09-29 15:00北京时间。',
          sources: [{ id: 'weather-fixture', title: '天气服务测试夹具', channel: 'mcp', observedAt: currentTime, dataTime: currentTime }] }; },
      },
    },
  });
  const elapsedMs = Math.round(performance.now() - start);
  const names = calls.map(c => c.tool);
  const checks: Record<string, boolean> = {};
  const only = (name: string) => names.length > 0 && names.every(n => n === name);
  if (scenario.kind === 'direct') checks.noUnneededTool = names.length === 0;
  if (scenario.kind === 'knowledge') checks.ownerKnowledgeOnly = only('knowledge');
  if (scenario.kind === 'browser') checks.browserWithoutWeatherOrOwnerKB = only('browser');
  if (scenario.kind === 'weather') checks.matchingWeatherTool = only('weather');
  if (scenario.kind === 'compute') checks.requestedSandbox = only('compute');
  if (scenario.kind === 'ask') { checks.waitingForConfiguredApproval = result.status === 'waiting_approval'; checks.browserOnly = only('browser'); }
  if (scenario.kind === 'blocked' || scenario.kind === 'empty') {
    checks.noFalseCompletion = result.status !== 'completed'; checks.browserAttempted = names.includes('browser');
    checks.noUnrelatedFallback = !names.includes('weather') && !names.includes('knowledge');
  }
  if (!['ask', 'blocked', 'empty'].includes(scenario.kind)) checks.completed = result.status === 'completed';
  for (const term of scenario.expected ?? []) checks[`answerIncludes:${term}`] = result.text.includes(term);
  if (scenario.id === 'explicit-browser' || scenario.id === 'public-stock') {
    checks.noDoubleAppliedDelay = !result.text.includes('14:30');
    checks.noWrongWeekday = !/星期一|周一|Monday/iu.test(result.text);
  }
  const modelSpans = result.spans.filter(s => s.module === 'model' && ['generate', 'goal_assessment'].includes(s.operation));
  const pass = Object.values(checks).every(Boolean);
  failed ||= !pass;
  const report = { id: scenario.id, pass, checks, status: result.status, question: scenario.question, text: result.text, calls,
    modelCalls: result.modelCalls, toolCalls: result.toolCalls, elapsedMs, runtimeMs: result.totalDurationMs,
    modelUsage: modelSpans.map(s => ({ operation: s.operation, inputTokens: s.inputTokens, outputTokens: s.outputTokens, durationMs: s.durationMs })),
    error: result.error };
  reports.push(report);
  await writeFile(resolve(output, `${scenario.id}.json`), JSON.stringify({ ...report, requests, messages: result.messages, events: result.events, spans: result.spans }, null, 2));
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ id: scenario.id, pass, checks, modelCalls: result.modelCalls, elapsedMs, status: result.status }));
}
if (failed) process.exitCode = 1;
