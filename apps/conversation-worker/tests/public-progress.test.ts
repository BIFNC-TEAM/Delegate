import { describe, expect, it, vi } from 'vitest';
import { createPublicProgress } from '../src/public-progress';
import type { PiRuntimeEvent } from '@delegate/model-runtime';

const event = (type: PiRuntimeEvent['type'], extra: Partial<PiRuntimeEvent> = {}): PiRuntimeEvent => ({ type, traceId: 'private-trace', runId: 'run', atOffsetMs: 0, ...extra });
describe('public runtime progress', () => {
  it('publishes real stages without deltas, raw arguments, private identifiers or repeated writes', async () => {
    const persist = vi.fn(async () => {}); const progress = createPublicProgress(persist);
    await progress.onEvent(event('request.accepted'));
    await progress.onEvent(event('tool.started', { toolName: 'retrieve_authorized_knowledge', data: { query: 'PRIVATE' } }));
    await progress.onEvent(event('retrieval.completed', { data: { sourceCount: 0 } }));
    await progress.onEvent(event('tool.started', { toolName: 'browse_in_sandbox', data: { url: 'PRIVATE' } }));
    await progress.onEvent(event('model.started'));
    await progress.onEvent(event('model.started'));
    await progress.onEvent(event('response.delta', { delta: 'PRIVATE_DRAFT' }));
    await progress.onEvent(event('response.review_started'));
    await progress.onEvent(event('response.review_rejected'));
    expect(persist.mock.calls.map(c => (c as unknown as [{ stage: string }])[0].stage)).toEqual(['processing','knowledge','knowledge_checked','browser','generating','verifying','revising']);
    expect(JSON.stringify(persist.mock.calls)).not.toMatch(/PRIVATE|private-trace|url/);
  });
  it('keeps a parallel tool active when another finishes; progress storage failure does not retry tools', async () => {
    const frames: unknown[] = []; const progress = createPublicProgress(async f => { frames.push(f); throw new Error('storage'); });
    await progress.onEvent(event('tool.started', { toolName: 'browse_in_sandbox', data: { toolCallId: 'a' } }));
    await progress.onEvent(event('tool.started', { toolName: 'mcp_weather', data: { toolCallId: 'b' } }));
    await progress.onEvent(event('tool.completed', { toolName: 'browse_in_sandbox', data: { toolCallId: 'a' } }));
    expect(frames).toEqual([{ sequence: 1, stage: 'browser' }, { sequence: 2, stage: 'mcp' }]);
  });
});
