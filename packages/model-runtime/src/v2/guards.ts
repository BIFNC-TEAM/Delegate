import { createHash } from "node:crypto";
import { V2Error } from "./types";

export function fingerprint(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function byteLength(value: unknown): number { return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8"); }
export function truncateUtf8(text: string, bytes: number): string {
  if (byteLength(text) <= bytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(Buffer.from(text).subarray(0, Math.max(0, bytes))).replace(/\uFFFD$/u, "");
}
export function safeError(error: unknown): string {
  return error instanceof V2Error ? error.code : "operation_failed";
}
/** Settles even for a misbehaving adapter; its signal must also stop remote work. */
export async function bounded<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason instanceof V2Error ? signal.reason : new V2Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      let wake: (() => void) | undefined;
      try { await bounded(() => new Promise<void>(resolve => { wake = resolve; this.waiting.push(resolve); }), signal); }
      catch (error) {
        const index = wake ? this.waiting.indexOf(wake) : -1;
        if (index >= 0) this.waiting.splice(index, 1);
        else this.release(); // A reserved slot raced cancellation.
        throw error;
      }
    } else this.active++;
    try { signal.throwIfAborted(); return await call(); }
    finally { this.release(); }
  }
  private release() { const next = this.waiting.shift(); if (next) next(); else this.active--; }
}
