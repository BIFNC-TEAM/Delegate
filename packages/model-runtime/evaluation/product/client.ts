import { randomUUID } from "node:crypto";
import { PRODUCT_LIMITS, PRODUCT_SCOPE } from "./scope";

export function parseSse(text: string): { answer: string; status: string } {
  const events = text.split(/\r?\n\r?\n/).flatMap(block => {
    const body = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!body) return [];
    try { return [JSON.parse(body)]; } catch { throw Error("invalid_sse_json"); }
  });
  if (events.some(e => e.error)) throw Error("sse_error_event");
  const final = events.at(-1);
  if (!final || !["completed", "failed", "cancelled"].includes(final.status)) throw Error("sse_terminal_missing");
  return { answer: final.message?.text ?? "", status: final.status };
}
export function retryDelay(value: string | null): number {
  const seconds = Number(value ?? "1");
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000 + 100, PRODUCT_LIMITS.maxRetryWaitMs) : 1000;
}
export class ProductClient {
  private cookie = "";
  private lastTurnAt = 0;
  readonly admissions: Array<{ status: number; runId?: string }> = [];
  constructor(private signal: AbortSignal, private fetcher: typeof fetch = fetch) {}
  private async request(path = "", init: RequestInit = {}) {
    const response = await this.fetcher(`${PRODUCT_SCOPE.origin}/reps/${PRODUCT_SCOPE.slug}/chat${path}`, {
      ...init, redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(PRODUCT_LIMITS.requestMs)]),
      headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: this.cookie, ...init.headers },
    });
    const entries = [...this.cookie.split("; ").filter(Boolean), ...response.headers.getSetCookie().map(s => s.split(";")[0]!)];
    this.cookie = [...new Map(entries.map(s => [s.slice(0, s.indexOf("=")), s])).values()].join("; ");
    let bytes = 0; const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try { for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > PRODUCT_LIMITS.responseBytes) throw Error("response_size_limit"); chunks.push(value);
      } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") };
  }
  async turn(message: string) {
    const gap = PRODUCT_LIMITS.minTurnGapMs - (Date.now() - this.lastTurnAt);
    if (gap > 0) await this.wait(gap);
    this.lastTurnAt = Date.now();
    const initial = await this.request(); if (initial.status !== 200) throw Error("chat_unavailable");
    const disclosure = await this.post({ message, memoryDisclosure: null });
    const proof = JSON.parse(disclosure.text);
    if (disclosure.status !== 409 || !proof.governedMemoryDisclosure) throw Error("disclosure_protocol_changed");
    const clientMessageId = randomUUID();
    const accepted = await this.post({ message, clientMessageId, memoryDisclosure: proof.governedMemoryDisclosure });
    const payload = JSON.parse(accepted.text);
    if (accepted.status !== 202 || typeof payload.runId !== "string" || !/^[a-z0-9]+$/i.test(payload.runId)) throw Error("admission_failed");
    const runId = payload.runId;
    this.admissions.push({ status: accepted.status, runId }); // Saved even if the stream fails; never replay an unknown admission.
    const stream = await this.request(`/runs/${runId}/events`, { headers: { Accept: "text/event-stream" } });
    if (stream.status !== 200) throw Error("stream_unavailable");
    return { runId, clientMessageId, ...parseSse(stream.text) };
  }
  async readArtifact(id: string) {
    if (!/^[a-z0-9_-]+$/i.test(id)) throw Error("artifact_identifier_invalid");
    const result = await this.request(`/artifacts/${id}/download`);
    if (result.status !== 200) throw Error("artifact_not_authorized");
    return result.text;
  }
  private async post(body: unknown) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.request("", { method: "POST", body: JSON.stringify(body) });
      if (r.status !== 429 || attempt >= PRODUCT_LIMITS.admissionRetries) return r;
      this.admissions.push({ status: 429 });
      await this.wait(retryDelay(r.headers.get("retry-after")));
    }
  }
  private async wait(ms: number) {
    const { setTimeout } = await import("node:timers/promises");
    await setTimeout(ms, undefined, { signal: this.signal });
  }
}
