/** Paired D18A evaluation with actual Pi/model; adapters contain only synthetic data and no effects. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPiModelBindingFromEnv, DelegatePiAgentRuntime } from '../src/pi/index.ts';
import type { PiAgentRunInput } from '../src/pi/types.ts';
const configured = createPiModelBindingFromEnv();
if (!configured.ok) throw new Error(configured.reason);
const cases = [
  { id: 'greeting-zh', question: '你好' },
  { id: 'greeting-en', question: 'Hello!' },
  { id: 'translation-en', question: '把“今天股票市场休市”翻译成英文，只给译文。' },
  { id: 'translation-zh', question: 'Translate "Please close the window." into Chinese.' },
  { id: 'translation-time', question: '将「明天上午九点开会」译成英文，只给译文。' },
  { id: 'translation-command', question: '把“请查询今天的天气”翻译成英文，只给译文。' },
];
const selected = cases.filter(c => !process.env.EVAL_CASE || process.env.EVAL_CASE.split(',').includes(c.id));
if (!selected.length) throw new Error('No matching EVAL_CASE');
const rounds = Math.max(1, Math.min(2, Number(process.env.EVAL_ROUNDS ?? 2)));
const output = resolve(process.env.EVAL_OUTPUT_DIR ?? `reports/agent-remediation/20260930-d18a/live-${Date.now()}`);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'protocol.json'), JSON.stringify({ model: configured.binding.modelId, provider: configured.binding.provider, cases: selected, rounds,
  environment: 'real model + installed Pi; no app DB/cloud/real tool effects',
  comparison: 'Each pair differs by the host reviewMode; round 1 always then simple, round 2 reverse. Greeting mode adds a short-output instruction. No latency/cost improvement threshold inferred from this small diagnostic sample.',
  acceptance: 'Standalone simple mode should complete in one generation, zero tool calls and no semantic review. Always mode should retain review. Answers are manually compared for fidelity; no translation claim is proven by output shape alone.' }, null, 2));
const results: any[] = [];
let failed = false;
for (let round = 0; round < rounds; round++) {
  for (const item of selected) {
    const modes: NonNullable<PiAgentRunInput['reviewMode']>[] = round % 2 ? ['simple_text_v1', 'always'] : ['always', 'simple_text_v1'];
    for (const mode of modes) {
      const effects: string[] = [];
      const start = performance.now();
      const result = await new DelegatePiAgentRuntime().run({
        runId: `${item.id}-${round}-${mode}`, sessionId: `${item.id}-${round}-${mode}`, userText: item.question,
        executionProtocol: 'goal_v2', reviewMode: mode, currentTime: '2026-09-30T07:00:00.000Z',
        representative: { name: '地理AI', ownerName: '测试老师', role: '初中地理数字代表', agentBehavior: {
          version: 1, answerScope: 'open_public', knowledgePolicy: 'owner_facts', commitmentPolicy: 'information_only' } },
        model: configured.binding, maxSteps: 6, timeoutMs: 60000, maxToolRetries: 0,
        capabilities: {
          knowledge: { retrieve: async () => { effects.push('knowledge'); return { status: 'not_found', text: '本样例无需要读取的资料。' }; } },
          sandbox: { execute: async () => { effects.push('compute'); return { status: 'unavailable', text: '本样例无代码执行需求。' }; },
            browse: async () => { effects.push('browser'); return { status: 'unavailable', text: '本样例无外部页面。' }; } },
          mcp: { listTools: async () => [{ server: 'weather', name: 'read', description: 'Current weather only', inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
              effectClassification: 'read', readOnly: true, idempotent: true }],
            callTool: async () => { effects.push('weather'); return { status: 'unavailable', text: '本样例无天气查询结果。' }; } },
        },
      });
      const shortcut = result.spans.some(s => s.operation === 'simple_text_release');
      const reviews = result.spans.filter(s => s.operation === 'goal_assessment').length;
      const pass = result.status === 'completed' && effects.length === 0
        && (mode === 'simple_text_v1' ? shortcut && result.modelCalls === 1 && reviews === 0 : !shortcut && reviews > 0);
      failed ||= !pass;
      const report = { id: item.id, question: item.question, round: round + 1, mode, pass, shortcut, reviews, status: result.status,
        modelCalls: result.modelCalls, httpAttempts: result.spans.filter(s => s.operation === 'provider_attempt').length,
        toolCalls: result.toolCalls, effects, text: result.text, elapsedMs: Math.round(performance.now() - start),
        // Provider-reported fields only; input excludes cached tokens in some providers. No billing claim.
        usage: result.spans.filter(s => s.module === 'model' && ['generate', 'goal_assessment'].includes(s.operation))
          .map(s => ({ operation: s.operation, inputTokens: s.inputTokens, outputTokens: s.outputTokens, durationMs: s.durationMs })), error: result.error };
      results.push(report);
      await writeFile(resolve(output, `${item.id}-${round + 1}-${mode}.json`), JSON.stringify({ ...report, spans: result.spans, messages: result.messages }, null, 2));
      await writeFile(resolve(output, 'summary.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ id: item.id, round: round + 1, mode, pass, calls: result.modelCalls, elapsedMs: report.elapsedMs, status: result.status }));
    }
  }
}
if (failed) process.exitCode = 1;
