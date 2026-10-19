import { describe, expect, it, vi } from 'vitest';
import { createVerificationPreview, createPublicReadPreviewGate, type VerificationPreviewFrame } from '../src/verification-preview';
import type { PiRuntimeEvent } from '@delegate/model-runtime';

const event = (type: PiRuntimeEvent['type'], extra: Partial<PiRuntimeEvent> = {}): PiRuntimeEvent => ({ type, traceId: 'trace', runId: 'run', atOffsetMs: 0, ...extra });
function fixture(canShow = true, authorize = vi.fn(async () => {})) {
  const frames: VerificationPreviewFrame[] = [];
  const persist = vi.fn(async (frame: VerificationPreviewFrame) => { frames.push({ ...frame }); });
  return { frames, persist, authorize, preview: createVerificationPreview({ enabled: true, canShow: () => canShow, authorize, persist }) };
}

describe('transient verification preview', () => {
  it('publishes an early partial draft, then the complete verifying state', async () => {
    const f = fixture();
    await f.preview.onEvent(event('model.started'));
    await f.preview.onEvent(event('response.delta', { delta: 'First ' }));
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toMatchObject({ text: 'First ', previewPhase: 'generating' });
    await f.preview.onEvent(event('response.delta', { delta: 'draft.' }));
    await f.preview.onEvent(event('response.review_started'));
    expect(f.frames.at(-1)).toMatchObject({ text: 'First draft.', previewPhase: 'verifying' });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    await f.preview.finish();
  });
  it('removes a rejected draft and does not concatenate the replacement onto it', async () => {
    const f = fixture();
    await f.preview.onEvent(event('response.delta', { delta: 'WRONG_DRAFT' }));
    await f.preview.onEvent(event('response.review_started'));
    await f.preview.onEvent(event('response.review_rejected'));
    expect(f.frames.at(-1)).toMatchObject({ text: '', previewPhase: 'revising' });
    await f.preview.onEvent(event('model.started'));
    await f.preview.onEvent(event('response.delta', { delta: 'Corrected answer' }));
    await f.preview.onEvent(event('response.review_started'));
    expect(f.frames.at(-1)).toMatchObject({ text: 'Corrected answer', previewPhase: 'verifying' });
    await f.preview.finish();
  });
  it('discards a stale frame whose authorization finishes after its draft was rejected', async () => {
    let release!: () => void;
    const f = fixture(true, vi.fn(() => new Promise<void>(resolve => { release = resolve; })));
    await f.preview.onEvent(event('response.delta', { delta: 'STALE_DRAFT' }));
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce());
    const rejected = f.preview.onEvent(event('response.review_rejected'));
    release(); await rejected; await f.preview.finish();
    expect(f.frames.every(frame => frame.text === '')).toBe(true);
  });
  it('withholds text when authorization is revoked', async () => {
    const f = fixture(true, vi.fn(async () => { throw new Error('revoked'); }));
    await f.preview.onEvent(event('response.delta', { delta: 'REVOKED_SOURCE' }));
    await f.preview.onEvent(event('response.review_started'));
    await f.preview.finish();
    expect(f.frames.every(frame => frame.text === '')).toBe(true);
    expect(f.frames.at(-1)?.previewPhase).toBe('withheld');
  });
  it('does not preview before sources are eligible, and clears on another tool or cancellation', async () => {
    const hidden = fixture(false);
    await hidden.preview.onEvent(event('response.delta', { delta: '{"answer":"internal envelope"}' }));
    await hidden.preview.finish(); expect(hidden.persist).not.toHaveBeenCalled();
    const f = fixture();
    await f.preview.onEvent(event('response.delta', { delta: 'Draft' }));
    await f.preview.onEvent(event('response.review_started'));
    await f.preview.onEvent(event('tool.started', { toolName: 'mcp__business__submit' }));
    await f.preview.onEvent(event('response.delta', { delta: 'PRIVATE_BUSINESS_RESULT' }));
    await f.preview.finish(true);
    expect(f.frames.at(-1)).toMatchObject({ text: '', previewPhase: 'withheld' });
    expect(JSON.stringify(f.frames)).not.toContain('PRIVATE_BUSINESS_RESULT');
  });
});


describe('public read preview continuation', () => {
  it('continues after public browsing and keeps verification and corrected drafts separate', async () => {
    const frames: VerificationPreviewFrame[] = [];
    const preview = createVerificationPreview({ enabled: true, canShow: () => true, publicReadTools: ['browse_in_sandbox'], authorize: async () => {}, persist: async f => { frames.push(f); } });
    await preview.onEvent(event('tool.started', { toolName: 'browse_in_sandbox' }));
    await preview.onEvent(event('model.started'));
    await preview.onEvent(event('response.delta', { delta: 'Public draft' }));
    await preview.onEvent(event('response.review_started'));
    expect(frames.at(-1)).toMatchObject({ text: 'Public draft', previewPhase: 'verifying' });
    await preview.onEvent(event('response.review_rejected'));
    expect(frames.at(-1)?.text).toBe('');
    await preview.onEvent(event('model.started'));
    await preview.onEvent(event('response.delta', { delta: 'Corrected public answer' }));
    await preview.onEvent(event('response.review_started'));
    expect(frames.at(-1)?.text).toBe('Corrected public answer');
    await preview.finish();
  });
  it('never streams a selective JSON envelope as user-facing prose', async () => {
    const f = fixture();
    for (const delta of ['{', '"taskType":"greeting",', '"answer":"Hello"}']) await f.preview.onEvent(event('response.delta', { delta }));
    await f.preview.finish();
    expect(f.frames.every(frame => frame.text === '')).toBe(true);
  });
});


describe('public read evidence gating for previews only', () => {
  it.each(['blocked','empty','unknown'] as const)('withholds drafts after a completed but %s page without changing the result', async state => {
    const gate = createPublicReadPreviewGate();
    const result = { status: 'completed', text: 'page', observation: { state }, sources: [{ id: 's', title: 'page', channel: 'web' as const }] };
    const call = vi.fn(async () => result);
    expect(await gate.observe(call)).toBe(result);
    expect(call).toHaveBeenCalledOnce();
    expect(gate.canShow()).toBe(false);
    expect(gate.hasEvidence()).toBe(false);
  });
  it('opens the draft only after a successful public read, and resets when the next read fails', async () => {
    const gate = createPublicReadPreviewGate();
    await gate.observe(async () => ({ status: 'completed', text: 'page', observation: { state: 'available' }, sources: [{ id: 's', title: 'page', channel: 'web' }] }));
    expect(gate.canShow()).toBe(true);
    expect(gate.hasEvidence()).toBe(true);
    await expect(gate.observe(async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
    expect(gate.canShow()).toBe(false);
  });
});
