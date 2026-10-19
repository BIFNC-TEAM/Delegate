import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiModelBinding } from './types';

/** Opt-in, expiring, conversation-scoped local diagnostics. Never public telemetry.
 * Records SDK request/response bodies, not HTTP headers or provider credentials.
 */
export function createLocalCallRecorder(input: { runId: string; sessionId: string; conversationId?: string }, env = process.env) {
  const directory = env.DELEGATE_DIAGNOSTIC_DIR;
  const until = Date.parse(env.DELEGATE_DIAGNOSTIC_UNTIL ?? '');
  if (!directory || !isAbsolute(directory) || !Number.isFinite(until) || until <= Date.now()
    || env.DELEGATE_DIAGNOSTIC_CONVERSATION_ID !== (input.conversationId ?? input.sessionId)) return;
  let path: string;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    path = join(directory, `${randomUUID()}.jsonl`);
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  } catch { console.warn('local_model_diagnostic_open_failed'); return; }
  let lastCallId = 0;
  const record = (type: string, data: unknown) => {
    try {
      appendFileSync(path, JSON.stringify({ type, runId: input.runId, at: new Date().toISOString(), data }) + '\n');
    } catch { console.warn('local_model_diagnostic_write_failed'); }
  };
  record('capture_started', { format: 1, scope: 'SDK bodies; no HTTP headers', captureUntil: new Date(until).toISOString() });
  return {
    record,
    get lastCallId() { return lastCallId; },
    async invoke(fn: PiModelBinding['streamFn'], args: Parameters<PiModelBinding['streamFn']>, phase: string) {
      const callId = ++lastCallId;
      const [model, context, options] = args;
      record('model_request', { callId, phase, model: { id: model.id, provider: model.provider }, context,
        options: { maxTokens: options?.maxTokens, temperature: options?.temperature } });
      try {
        const stream = await fn(...args);
        // result() is the SDK's shared completion promise; do not consume its
        // async iterator, buffer deltas, or wait before returning the stream.
        void stream.result().then(message => record('model_response', { callId, phase, message }),
          error => record('model_error', { callId, phase, message: String(error) }));
        return stream;
      } catch (error) {
        record('model_error', { callId, phase, message: String(error) });
        throw error;
      }
    },
  };
}
