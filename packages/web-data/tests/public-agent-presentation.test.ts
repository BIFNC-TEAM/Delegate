import { describe, expect, it } from 'vitest';
import { projectPublicAnswerSources, readPublicAnswerSources, readPublicAgentProgress, readPublicExecution } from '../src/public-agent-presentation';

describe('public provenance projection', () => {
  it('projects execution states without internal names, inputs or results', () => {
    expect(readPublicExecution({ publicExecution: [{ category: 'knowledge', status: 'ok', durationMs: 12.7, toolName: 'private_contract', arguments: 'SECRET', result: 'PRIVATE' }, { category: 'web', status: 'invented', durationMs: 1 }] })).toEqual([{ category: 'knowledge', status: 'ok', durationMs: 13 }]);
  });
  it('deduplicates selected sources, separates provider from mechanism, omits knowledge without authoritative citations', () => {
    const browser = { channel: 'web', title: 'UNTRUSTED_PAGE_TITLE', url: 'https://www.apec.org/about-us', provider: 'Tencent sandbox browser', observedAt: '2026-10-14T08:00:00Z' };
    const sources = projectPublicAnswerSources([browser, browser,
      { channel: 'knowledge', title: 'PRIVATE_DOCUMENT' },
      { channel: 'mcp', title: 'internal/tool', provider: 'Open-Meteo' }]);
    expect(sources).toEqual([
      { kind: 'web', title: 'www.apec.org', domain: 'www.apec.org', url: browser.url, access: 'page', observedAt: '2026-10-14T08:00:00.000Z' },
      { kind: 'mcp', title: 'Open-Meteo' },
    ]);
    expect(readPublicAnswerSources({ publicSources: sources })).toEqual(sources);
    expect(projectPublicAnswerSources([{ ...browser, provider: 'Search' }])[0]?.access).toBe('search');
  });
  it.each(['javascript:alert(1)', 'https://user:password@example.com', 'http://127.0.0.1/a', 'http://tool.internal/a', 'https://example.com/?token=private'])('does not project unsafe URL %s', url => {
    expect(projectPublicAnswerSources([{ channel: 'web', title: 'x', url }])).toEqual([]);
  });
  it('does not accept malformed progress or forward internal fields', () => {
    const frame = { sequence: 1, stage: 'browser', startedAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:01:00Z' };
    expect(readPublicAgentProgress({ ...frame, arguments: 'PRIVATE' })).toEqual(frame);
    expect(readPublicAgentProgress({ ...frame, stage: 'secret action' })).toBeUndefined();
    expect(readPublicAgentProgress({ ...frame, sequence: -1 })).toBeUndefined();
  });
});
