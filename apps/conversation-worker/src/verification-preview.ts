import type { PiRuntimeEvent, PiCapabilityResult } from '@delegate/model-runtime';

/** A transport/tool completion alone does not mean a usable public page exists. */
export function createPublicReadPreviewGate() {
  let attempted = false;
  let available = false;
  return {
    canShow: () => !attempted || available,
    hasEvidence: () => available,
    async observe(call: () => Promise<PiCapabilityResult>): Promise<PiCapabilityResult> {
      attempted = true; available = false;
      const result = await call();
      available = ['completed', 'found', 'success', 'ok'].includes(result.status ?? '')
        && result.observation?.state === 'available'
        && result.sources?.some(source => source.channel === 'web') === true;
      return result;
    },
  };
}

type Phase = 'generating' | 'verifying' | 'revising' | 'withheld';
export type VerificationPreviewFrame = { sequence: number; text: string; previewPhase: Phase };

/** Transient Web draft only. Final messages and provider delivery are separate. */
export function createVerificationPreview(input: {
  enabled: boolean;
  canShow: () => boolean;
  publicReadTools?: readonly string[];
  authorize: () => Promise<void>;
  persist: (frame: VerificationPreviewFrame) => Promise<unknown>;
}) {
  let text = '';
  let phase: Phase = 'generating';
  let revision = 0;
  let sequence = 0;
  let shown = false;
  let blocked = false;
  let envelope = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const queue = () => {
    stopTimer();
    const current = revision;
    const frame = { sequence: ++sequence, text, previewPhase: phase };
    chain = chain.then(async () => {
      if (current !== revision || (blocked && frame.text)) return;
      if (frame.text) await input.authorize();
      if (current !== revision || (blocked && frame.text)) return;
      await input.persist(frame);
    }).catch(async () => {
      // A revoked source or lost lease must never leave a queued draft eligible.
      blocked = true; text = ''; revision += 1;
      await input.persist({ sequence: ++sequence, text: '', previewPhase: 'withheld' }).catch(() => undefined);
    });
  };
  const clear = (next: Phase) => {
    stopTimer(); revision += 1; text = ''; phase = next;
    if (shown) queue();
  };
  return {
    async onEvent(event: PiRuntimeEvent) {
      if (!input.enabled) return;
      if (event.type === 'model.started') { envelope = false; clear(blocked ? 'withheld' : phase === 'revising' ? 'revising' : 'generating'); return; }
      if (event.type === 'tool.started' && event.toolName !== 'retrieve_authorized_knowledge') {
        if (!input.publicReadTools?.includes(event.toolName ?? '')) blocked = true;
        clear('withheld'); return;
      }
      if (event.type === 'response.review_rejected') { clear('revising'); await chain; return; }
      if (event.type === 'response.review_started') {
        if (!blocked && shown && text) { phase = 'verifying'; queue(); await chain; }
        return;
      }
      if (event.type !== 'response.delta' || !event.delta || blocked || !input.canShow()) return;
      if (envelope) return;
      const start = text + event.delta;
      if (!text.trim() && /^(?:\s*\{|\s*`)/u.test(start)) { envelope = true; clear('withheld'); return; }
      phase = 'generating';
      text = `${text}${event.delta}`.slice(0, 32_000);
      if (!shown) { shown = true; queue(); }
      else timer ??= setTimeout(queue, 300);
    },
    async finish(withhold = false) {
      if (!input.enabled) return;
      if (withhold) clear('withheld');
      else if (timer) queue();
      stopTimer(); await chain;
    },
  };
}
