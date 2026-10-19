import { describe, expect, it, vi } from "vitest";
import { createPiModelBindingFromEnv } from "../src/pi/provider";
import { measureGoalAssessment } from "../scripts/review-latency-probe";

const answer = JSON.stringify({ verdict: "complete", requiresEvidence: false, evidenceIds: [], missing: [], summary: "", responseKind: "result", claimsSupported: true });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: Record<string, string>) => frame({ id: "fixture", choices: [{ index: 0, delta: value, finish_reason: null }] });
function response(text = answer, delayMs = 0, thinking = false, signal?: AbortSignal | null) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const encode = (text: string) => controller.enqueue(new TextEncoder().encode(text));
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => { clearTimeout(timer); controller.error(new DOMException("fixture abort", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    encode(delta({ role: "assistant" }));
    timer = setTimeout(() => {
      if (thinking) encode(delta({ reasoning_content: "PRIVATE_REASONING_SENTINEL" }));
      encode(delta({ content: text }));
      encode(frame({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      encode("data: [DONE]\n\n"); controller.close(); signal?.removeEventListener("abort", abort);
    }, delayMs);
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function input(retries: number, timeout = 30, signal = AbortSignal.timeout(3000)) {
  const binding = createPiModelBindingFromEnv({ DELEGATE_MODEL_PROVIDER: "agicto", DELEGATE_AGICTO_API_KEY: "UNIT_PRIVATE_KEY_SENTINEL", DELEGATE_AGICTO_BASE_URL: "https://fixture.invalid/v1", DELEGATE_AGICTO_MODEL: "latency-fixture", DELEGATE_MODEL_TIMEOUT_MS: String(timeout), DELEGATE_PI_MODEL_MAX_RETRIES: String(retries) });
  if (!binding.ok) throw new Error("fixture_binding_unavailable");
  return { run: { runId: "timing", sessionId: "timing", userText: "hello", model: binding.binding, representative: { name: "Fixture", ownerName: "Owner", role: "general" } }, observations: [], candidate: "hello", signal };
}

describe("evaluation latency probe (installed Pi/OpenAI SDK, fake HTTP transport)", () => {
  it("separates response headers/start from nonempty content and preserves a body slower than the header timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => response(answer, 80, true, init?.signal));
    const result = await measureGoalAssessment(input(1, 30), { fetch });
    expect(fetch).toHaveBeenCalledOnce(); expect(result.assessment?.releaseCandidate).toBe(true);
    expect(result.attempts).toHaveLength(1); expect(result.attempts[0]?.status).toBe(200);
    expect(result.timing.firstContentMs! - result.attempts[0]!.headersMs!).toBeGreaterThanOrEqual(50);
    expect(result.timing.firstTextMs!).toBeGreaterThanOrEqual(result.timing.firstThinkingMs!);
    expect(result.timing.completedMs!).toBeGreaterThanOrEqual(result.timing.firstTextMs!);
    expect(result.response?.text).toBe(answer);
    expect(JSON.stringify(result)).not.toMatch(/UNIT_PRIVATE_KEY_SENTINEL|PRIVATE_REASONING_SENTINEL|Authorization|fixture\.invalid/);
  });

  it("counts actual HTTP attempts for a retry, keeping status and identical request bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"synthetic_busy"}}', { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } }))
      .mockImplementationOnce(async () => response());
    const result = await measureGoalAssessment(input(1), { fetch });
    expect(result.assessment?.releaseCandidate).toBe(true); expect(result.attempts.map(a => a.status)).toEqual([503, 200]);
    expect(result.attempts[1]!.startedMs).toBeGreaterThanOrEqual(result.attempts[0]!.headersMs!);
    expect(result.attempts[0]!.requestBodyHash).toBe(result.attempts[1]!.requestBodyHash);
  });

  it("does not turn a faster error with retries disabled into a successful assessment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"error":{"message":"synthetic_busy"}}', { status: 503 }));
    const result = await measureGoalAssessment(input(0), { fetch });
    expect(fetch).toHaveBeenCalledOnce(); expect(result.attempts).toHaveLength(1);
    expect(result.assessment).toBeUndefined(); expect(result.errorClass).toBe("Error");
    expect(result.response?.stopReason).toBe("error"); expect(result.timing.firstTextMs).toBeUndefined();
  });

  it("records a pre-header request timeout separately from the following attempt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("fixture timeout", "AbortError")), { once: true });
      }))
      .mockImplementationOnce(async () => response());
    const result = await measureGoalAssessment(input(1, 30), { fetch });
    expect(result.assessment?.releaseCandidate).toBe(true); expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ errorClass: "AbortError" });
    expect(result.attempts[0]!.headersMs).toBeUndefined(); expect(result.attempts[0]!.abortedMs).toBeDefined();
    expect(result.attempts[1]!.startedMs).toBeGreaterThan(result.attempts[0]!.failedMs!);
  });

  it("preserves caller cancellation after headers without consuming a second request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      setTimeout(() => controller.abort(), 25);
      return response(answer, 500, false, init?.signal);
    });
    const result = await measureGoalAssessment(input(1, 1000, controller.signal), { fetch });
    expect(fetch).toHaveBeenCalledOnce(); expect(result.response?.stopReason).toBe("aborted");
    expect(result.assessment).toBeUndefined(); expect(result.attempts[0]!.headersMs).toBeDefined();
    expect(result.attempts[0]!.abortedMs).toBeDefined(); expect(result.timing.logicalAbortMs).toBeDefined();
  });

  it("does not issue HTTP for an already aborted review", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const result = await measureGoalAssessment(input(1, 30, controller.signal), { fetch });
    expect(fetch).not.toHaveBeenCalled(); expect(result.attempts).toHaveLength(0);
    // The installed SDK reports a pre-request cancellation as error; the probe
    // preserves that result instead of relabeling it. No request was issued.
    expect(result.response?.stopReason).toBe("error"); expect(result.assessment).toBeUndefined();
    expect(result.timing.logicalAbortMs).toBeDefined(); expect(result.timing.firstContentMs).toBeUndefined();
  });

  it("records complete transport timing while preserving an invalid-review failure", async () => {
    const result = await measureGoalAssessment(input(0), { fetch: async () => response("not review JSON") });
    expect(result.response?.stopReason).toBe("stop"); expect(result.errorClass).toBe("ModelReviewError");
    expect(result.assessment).toBeUndefined(); expect(result.timing.firstTextMs).toBeDefined();
    expect(result.timing.completedMs).toBeDefined();
  });
});
