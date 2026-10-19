/** Evaluation-only instrumentation for result-only assessGoalCompletion calls.
 * Pi's event queue has one consumer. This probe consumes it exactly once before
 * returning the already-completed stream to the assessor, which uses result().
 * Do not install this wrapper on an Agent that also consumes stream events. */
import { createHash } from "node:crypto";
import { assessGoalCompletion } from "../src/pi/execution-state";

export type HttpAttemptTiming = {
  attempt: number;
  startedMs: number;
  headersMs?: number;
  status?: number;
  contentType?: string | null;
  failedMs?: number;
  errorClass?: string;
  abortedMs?: number;
  requestBodyHash?: string;
};

export async function measureGoalAssessment(
  input: Parameters<typeof assessGoalCompletion>[0],
  options: { fetch?: typeof fetch; now?: () => number; onProgress?: (event: Record<string, unknown>) => void } = {},
) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const at = () => now() - started;
  const cleanup: Array<() => void> = [];
  const attempts: HttpAttemptTiming[] = [];
  const timing: {
    streamStartMs?: number; firstContentMs?: number; firstTextMs?: number;
    firstThinkingMs?: number; lastContentMs?: number; lastTextMs?: number;
    completedMs?: number; logicalAbortMs?: number;
  } = {};
  let response: { stopReason: string; usage: unknown; text: string } | undefined;
  let wire: { model?: unknown; maxTokens?: unknown; stream?: unknown; reasoningEffort?: unknown; enableThinking?: unknown; thinkingBudget?: unknown } | undefined;
  const progress = (event: Record<string, unknown>) => options.onProgress?.(event);
  const logicalAbort = () => { timing.logicalAbortMs = at(); progress({ event: "logical_abort", atMs: timing.logicalAbortMs }); };
  if (input.signal.aborted) logicalAbort();
  else { input.signal.addEventListener("abort", logicalAbort, { once: true }); cleanup.push(() => input.signal.removeEventListener("abort", logicalAbort)); }
  const realFetch = options.fetch ?? globalThis.fetch;
  const measuredFetch: typeof fetch = async (request, init) => {
    const attempt: HttpAttemptTiming = { attempt: attempts.length + 1, startedMs: at() };
    if (typeof init?.body === "string") attempt.requestBodyHash = createHash("sha256").update(init.body).digest("hex");
    attempts.push(attempt); progress({ event: "http_start", attempt: attempt.attempt, atMs: attempt.startedMs });
    const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    const abort = () => { attempt.abortedMs = at(); progress({ event: "http_abort", attempt: attempt.attempt, atMs: attempt.abortedMs }); };
    if (signal?.aborted) abort();
    else if (signal) { signal.addEventListener("abort", abort, { once: true }); cleanup.push(() => signal.removeEventListener("abort", abort)); }
    try {
      const result = await realFetch(request, init);
      attempt.headersMs = at(); attempt.status = result.status; attempt.contentType = result.headers.get("content-type");
      progress({ event: "http_headers", attempt: attempt.attempt, atMs: attempt.headersMs, status: result.status });
      return result; // Original response/body; no clone, tee, decoding or buffering here.
    } catch (error) {
      attempt.failedMs = at(); attempt.errorClass = error instanceof Error ? error.name : "unknown";
      progress({ event: "http_error", attempt: attempt.attempt, atMs: attempt.failedMs, errorClass: attempt.errorClass });
      throw error;
    }
  };
  const binding = input.run.model;
  let assessment: Awaited<ReturnType<typeof assessGoalCompletion>> | undefined;
  let errorClass: string | undefined;
  try {
    assessment = await assessGoalCompletion({ ...input, run: { ...input.run, model: { ...binding,
      streamFn: async (model, context, streamOptions) => {
        const stream = await binding.streamFn(model, context, { ...streamOptions, fetch: measuredFetch,
          onPayload: async (payload, selectedModel) => {
            const value = payload as Record<string, unknown>;
            wire = { model: value.model, maxTokens: value.max_tokens ?? value.max_completion_tokens, stream: value.stream,
              reasoningEffort: value.reasoning_effort, enableThinking: value.enable_thinking, thinkingBudget: value.thinking_budget };
            return streamOptions?.onPayload?.(payload, selectedModel);
          },
        });
        for await (const event of stream) {
          const time = at();
          if (event.type === "start" && timing.streamStartMs === undefined) timing.streamStartMs = time;
          if ((event.type === "text_delta" || event.type === "thinking_delta") && event.delta.length > 0) {
            if (timing.firstContentMs === undefined) { timing.firstContentMs = time; progress({ event: "first_content", atMs: time, kind: event.type }); }
            timing.lastContentMs = time;
            if (event.type === "text_delta") {
              if (timing.firstTextMs === undefined) { timing.firstTextMs = time; progress({ event: "first_text", atMs: time }); }
              timing.lastTextMs = time;
            } else if (timing.firstThinkingMs === undefined) timing.firstThinkingMs = time;
          }
        }
        const message = await stream.result();
        timing.completedMs = at();
        response = { stopReason: message.stopReason, usage: message.usage,
          text: message.content.filter(part => part.type === "text").map(part => part.text).join("") };
        return stream; // Same result object/promise; no second call or regenerated response.
      },
    } } });
  } catch (error) { errorClass = error instanceof Error ? error.name : "unknown"; }
  finally { for (const remove of cleanup) remove(); }
  const elapsedMs = at();
  return { assessment, errorClass, response, wire, attempts, timing, elapsedMs };
}
