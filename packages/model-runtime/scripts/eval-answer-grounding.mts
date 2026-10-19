/** Replays fixed synthetic candidates/evidence through the existing real-model reviewer. No tools/DB/cloud. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assessGoalCompletion, createPiModelBindingFromEnv } from '../src/pi/index.ts';
import type { PiAgentRunInput, PiModelBinding, PiToolObservation } from '../src/pi/types.ts';
import { evaluateGroundingDecision } from './grounding-evaluation.ts';

type Case = { id: string; question: string; candidate: string; observations: PiToolObservation[]; expectedRelease: boolean; reason: string;
  evidenceRequirements?: PiAgentRunInput['evidenceRequirements']; availableTools: {name: string; description: string}[] };
const inputRoot = resolve('reports/agent-remediation/20260929-d19');
const cases: Case[] = [];
const good: Record<string, string> = {
  'owner-policy': '适用所有已报名学员：开课前24小时及以上取消可全额退款；不足24小时原则上不退。突发疾病取消的例外是48小时内提交证明可全额退款。政策于2026年9月1日生效。',
  'public-history': '开幕日期是1992年7月25日。此次读取的是搜索结果页，返回内容记载了该日期；未另行核验国际奥委会官网。出处：https://www.google.com/search?q=1992%E5%B9%B4%E5%B7%B4%E5%A1%9E%E7%BD%97%E9%82%A3%E5%A5%A5%E8%BF%90%E4%BC%9A%E5%BC%80%E5%B9%95%E6%97%A5%E6%9C%9F',
  'explicit-browser': '沙盒浏览器返回：腾讯控股0700.HK，546.50港元，上涨1.20%；数据时间2026年9月29日14:45香港时间，盘中，延迟15分钟。这是测试页面提供的示例数据。来源：https://www.hkexnews.hk/listedco/listconews/sehk/2024/0928/2024092800001.pdf',
  geography: '山高几千米，相对约1.5亿公里的日地距离，变化很小。山上通常更冷主要与对流层的温度变化有关：地表吸收太阳能并加热近地面空气，空气向上运动时，因气压降低而膨胀，对外做功，温度下降。所以不能仅凭离太阳稍近就判断更热。',
};
for (const id of Object.keys(good)) {
  const part = id === 'public-history' ? 'final-b' : 'final-a';
  const saved = JSON.parse(await readFile(resolve(inputRoot, part, `${id}.json`), 'utf8'));
  const review = saved.requests.find((r: any) => r.systemPrompt?.startsWith('You verify'));
  const payload = JSON.parse(review.messages[0].content);
  const common = { question: payload.goal, observations: payload.observations, evidenceRequirements: payload.evidenceRequirements,
    availableTools: payload.availableCapabilities };
  cases.push({ ...common, id: `${id}-bad`, candidate: payload.candidate, expectedRelease: false, reason: 'Recorded D19 answer-quality failure; compare claims with actual evidence or internal arithmetic.' });
  cases.push({ ...common, id: `${id}-good`, candidate: good[id]!, expectedRelease: true,
    ...(id === 'explicit-browser' ? { question: '请复述浏览器返回的测试页面行情数据，并说明这不是实际行情。' } : {}),
    reason: id === 'explicit-browser' ? 'Control is a faithful report of supplied synthetic data, not proof of current real stock data. The original 2024 PDF fixture is unsuitable as a positive live-quote control.' : 'Control preserving only supported claims; general explanation remains allowed.' });
}
// Contrast controls: the same wording is allowed when evidence supports it; names are not banned words.
const policySource: PiToolObservation = { callId: 'policy', toolName: 'retrieve_authorized_knowledge', status: 'completed',
  text: '合成租赁政策：提前72小时取消退90%，另外10%为服务费；不足72小时不退款。延期可以申请，经管理员审核后生效。',
  sources: [{ id: 'rental', title: '合成租赁条款', channel: 'knowledge' }], artifacts: [] };
const publicSource: PiToolObservation = { callId: 'page', toolName: 'browse_in_sandbox', status: 'completed',
  text: '澄川展览于2026年10月6日09:30开幕。', sources: [{ id: 'event', title: '澄川展览主办方公告', channel: 'web', url: 'https://organizer.example/event' }], artifacts: [], observation: { state: 'available', httpStatus: 200 } };
cases.push(
  { id: 'rental-good', question: '所有者租赁业务的取消和延期条款是什么？', candidate: '提前72小时取消退90%，10%作为服务费；不足72小时不退款。延期可申请，经管理员审核后生效。', observations: [policySource], availableTools: [], expectedRelease: true, reason: 'Approval and fee actually appear in source; do not ban these words.' },
  { id: 'rental-bad', question: '所有者租赁业务的取消和延期条款是什么？', candidate: '提前72小时取消退90%，但必须在24小时内上传身份证扫描件并支付20%额外手续费；不足72小时不退款。延期可申请，经管理员审核后生效。', observations: [policySource], availableTools: [], expectedRelease: false, reason: 'Invented deadline, document and fee.' },
  { id: 'official-good', question: '查询澄川展览开幕时间并说明出处。', candidate: '已读取主办方公告，澄川展览于2026年10月6日09:30开幕。出处：https://organizer.example/event', observations: [publicSource], availableTools: [], expectedRelease: true, reason: 'Actual observed organizer source supports attribution.' },
  { id: 'corroboration-bad', question: '查询澄川展览开幕时间并说明出处。', candidate: '澄川展览于2026年10月6日09:30开幕。我已访问主办方和文化部门官网并交叉核实，两家官方来源均确认该时间。', observations: [publicSource], availableTools: [], expectedRelease: false, reason: 'Only organizer was observed; department corroboration invented.' },
  { id: 'mentioned-name-good', question: '资料中提到《世界地图集》这本书吗？', candidate: '资料中提到了《世界地图集》，但这不代表本轮已读取该书。', observations: [{ ...policySource, text: '阅读建议：《世界地图集》。' }], availableTools: [], expectedRelease: true, reason: 'Mentioning a supplied name is allowed without claiming verification.' },
  { id: 'arithmetic-good', question: '把8849米和1.5亿公里的距离做个比例，说明山顶靠近太阳的幅度。', candidate: '8849米等于8.849公里，占1.5亿公里的约0.0000059%，相对距离变化极小。', observations: [], availableTools: [], expectedRelease: true, reason: 'Internally correct arithmetic without demanding a tool.' },
);
const selected = cases.filter(c => !process.env.EVAL_CASE || process.env.EVAL_CASE.split(',').includes(c.id));
if (!selected.length) throw new Error('No matching EVAL_CASE');
const output = resolve(process.env.EVAL_OUTPUT_DIR ?? `reports/agent-remediation/20260930-d08-quality/review-${Date.now()}`);
await mkdir(output, { recursive: true });
const requestedProvider = process.env.EVAL_PROVIDER?.trim();
const preferred = requestedProvider === 'agicto' ? 'agicto' : requestedProvider === 'bailian' ? 'bailian' : undefined;
if (requestedProvider && !preferred) throw new Error('Unsupported evaluation provider');
const configured = createPiModelBindingFromEnv(process.env, preferred);
if (!configured.ok) throw new Error(configured.reason);
if (preferred && configured.binding.provider !== preferred) throw new Error('Requested evaluation provider unavailable');
await writeFile(resolve(output, 'protocol.json'), JSON.stringify({ fixtureVersion: 2, model: configured.binding.modelId, provider: configured.binding.provider,
  currentTime: '2026-09-29T07:00:00.000Z', environment: 'real model; fixed synthetic evidence/candidates; existing reviewer only; no effects', cases: selected }, null, 2));
let failed = false;
const reports: unknown[] = [];
const transport = globalThis.fetch;
let wire: unknown[] = [];
globalThis.fetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body);
    wire.push({ model: body.model, roles: body.messages?.map((m: any) => m.role),
      instructionCharacters: body.messages?.filter((m: any) => ['system', 'developer'].includes(m.role)).reduce((n: number, m: any) => n + String(m.content).length, 0) });
  }
  return transport(input, init);
};
for (const item of selected) {
  wire = [];
  const requests: any[] = [];
  const model: PiModelBinding = { ...configured.binding, streamFn: async (model, context, options) => {
    const captured: any = structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }); requests.push(captured);
    const events = await configured.binding.streamFn(model, context, options);
    void events.result().then(response => { captured.response = response; }).catch(() => {});
    return events;
  } };
  const started = performance.now();
  let assessment: Awaited<ReturnType<typeof assessGoalCompletion>> | undefined;
  let error: string | undefined;
  try {
    assessment = await assessGoalCompletion({
      run: { runId: `quality-${item.id}`, sessionId: `quality-${item.id}`, userText: item.question, model,
        currentTime: '2026-09-29T07:00:00.000Z', timezone: 'Asia/Shanghai', executionProtocol: 'goal_v2',
        ...(item.evidenceRequirements ? { evidenceRequirements: item.evidenceRequirements } : {}),
        representative: { name: '地理AI', ownerName: '测试老师', role: '初中地理数字代表', agentBehavior: { version: 1, answerScope: 'open_public', knowledgePolicy: 'owner_facts', commitmentPolicy: 'information_only' } } },
      candidate: item.candidate, observations: item.observations, availableTools: item.availableTools, signal: AbortSignal.timeout(60000),
    });
  } catch (caught) { error = caught instanceof Error ? caught.name : 'evaluation_failed'; }
  const evaluation = evaluateGroundingDecision({ expectedRelease: item.expectedRelease, assessment, error });
  const pass = evaluation.pass;
  failed ||= !pass;
  const report = { id: item.id, pass, evaluation, expectedRelease: item.expectedRelease, elapsedMs: Math.round(performance.now() - started), assessment, error };
  reports.push(report);
  await writeFile(resolve(output, `${item.id}.json`), JSON.stringify({ ...report, requests, wire }, null, 2));
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ id: item.id, pass, released: assessment?.releaseCandidate, error }));
}
if (failed) process.exitCode = 1;
