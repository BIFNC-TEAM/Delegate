import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { DelegatePiAgentRuntime } from '../src/pi/runtime';
import { fixtureContextAuthority } from './context-authority-fixture';

function binding(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: 'faux', modelId: faux.getModel().id };
}
const base = {
  runId: 'relevance', sessionId: 'relevance', executionProtocol: 'goal_v2' as const,
  contextAuthorization: fixtureContextAuthority('relevance'), maxSteps: 4,
  representative: { name: '测试代表', ownerName: '合成所有者', role: '公开问答' },
};
const review = (requiresEvidence: boolean, responseKind = 'result', claimsSupported = true) => fauxAssistantMessage(JSON.stringify({
  verdict: responseKind === 'result' ? 'complete' : 'partial', responseKind, claimsSupported,
  requiresEvidence, evidenceIds: [], missing: [], summary: '',
}));
function unrelatedTool(name = 'weather') {
  const callTool = vi.fn(async () => ({ status: 'completed', text: '无关查询结果', sources: [{ id: 'unrelated', channel: 'mcp' as const, title: '无关来源' }] }));
  return { callTool, listTools: async () => [{ server: 'fixture', name, description: 'Read an unrelated record only; cannot answer this request.',
    inputSchema: { type: 'object', properties: {} }, readOnly: true, idempotent: true }] };
}

describe('tool availability is not a tool-use obligation', () => {
  it.each(['weather', 'repository', 'calendar'])('answers stable knowledge with zero unrelated %s calls', async name => {
    const mcp = unrelatedTool(name);
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: '解释什么是三角形', capabilities: { mcp },
      model: binding([fauxAssistantMessage('三角形是由三条线段围成的平面图形。'), review(false)]) });
    expect(result.status).toBe('completed'); expect(result.toolCalls).toBe(0);
    expect(mcp.callTool).not.toHaveBeenCalled(); expect(result.sources).toEqual([]);
  });

  it.each(['查今天的股票价格', '用沙盒浏览器查询这个页面'])('allows an honest limitation without attempting unrelated tools: %s', async userText => {
    const mcp = unrelatedTool();
    const text = '当前可用工具不能完成这项查询，我没有取得所需信息。';
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, capabilities: { mcp },
      model: binding([fauxAssistantMessage(text), review(true, 'limitation')]) });
    expect(result.status).toBe('partial'); expect(result.text).toBe(text);
    expect(result.toolCalls).toBe(0); expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])('does not demand more evidence after discarding a %s unrelated lookup', async status => {
    const mcp = unrelatedTool();
    mcp.callTool.mockResolvedValue({ status, text: '无关结果，不支持三角形解释',
      sources: status === 'completed' ? [{ id: 'unrelated', channel: 'mcp', title: '无关来源' }] : [] });
    const text = '三角形是由三条线段围成的平面图形。';
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxToolRetries: 0, userText: '解释什么是三角形', capabilities: { mcp },
      model: binding([
        fauxAssistantMessage(fauxToolCall('mcp__fixture__weather', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage(text), review(false),
      ]) });
    expect(result.status).toBe('completed'); expect(result.text).toBe(text);
    expect(mcp.callTool).toHaveBeenCalledOnce(); expect(result.toolCalls).toBe(1);
    expect(result.modelCalls).toBe(3); expect(result.sources).toEqual([]);
  });

  it('still rejects a live fact without evidence even if an unrelated tool succeeded', async () => {
    const mcp = unrelatedTool();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, userText: '查今天的股票价格', capabilities: { mcp },
      model: binding([
        fauxAssistantMessage(fauxToolCall('mcp__fixture__weather', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage('今日价格是123。'), review(false),
      ]) });
    expect(result.status).not.toBe('completed'); expect(result.text).not.toContain('123');
    expect(mcp.callTool).toHaveBeenCalledOnce(); expect(result.sources).toEqual([]);
  });
});
