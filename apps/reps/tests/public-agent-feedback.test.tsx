import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublicAnswerSources, PublicRunProgress } from '../app/reps/[slug]/public-agent-feedback';

describe('public progress and provenance UI', () => {
  it('renders an actual stage and elapsed time, not an invented percentage', () => {
    const html = renderToStaticMarkup(<PublicRunProgress locale="zh" now={Date.parse('2026-10-14T08:00:12Z')} progress={{ sequence: 3, stage: 'verifying', startedAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:11Z' }} />);
    expect(html).toContain('正在核对回答与来源'); expect(html).toContain('已等待 12 秒'); expect(html).not.toContain('%');
  });
  it('renders public citations and provider links; empty evidence has no misleading footer', () => {
    expect(renderToStaticMarkup(<PublicAnswerSources locale="zh" />)).toBe('');
    const html = renderToStaticMarkup(<PublicAnswerSources locale="zh" citations={[{ title: '地理教材', kind: 'knowledge' }]} sources={[
      { kind: 'web', title: 'apec.org', url: 'https://apec.org/', access: 'page' },
      { kind: 'mcp', title: 'Open-Meteo' },
    ]} />);
    expect(html).toContain('知识库'); expect(html).toContain('地理教材'); expect(html).toContain('href="https://apec.org/"');
    expect(html).toContain('Open-Meteo'); expect(html).toContain('MCP'); expect(html).not.toContain('未引用');
  });
});
