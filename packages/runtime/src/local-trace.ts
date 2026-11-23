/** Opt-in local diagnostics. Keep this Node-only entry separate from the browser barrel. */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const context = new AsyncLocalStorage<LocalTrace>();
const secretKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[_-]?key|token|auth[_-]?token|session[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|credential|credentials|client[_-]?secret|private[_-]?key)$/i;
const omittedKey = /^(?:thinking|reasoning|reasoning_content|thinkingSignature|textSignature|signature|partialJson)$/i;
export function sanitizeLocalTrace(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: any): any => {
    if (typeof item === "string") {
      if (/^\s*[\[{]/.test(item)) { try { return JSON.stringify(visit(JSON.parse(item))); } catch { /* Plain text is kept verbatim except secret redaction. */ } }
      let text = item.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, "[THINKING_OMITTED]");
      for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
      return text.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
        .replace(/(?:https?|postgres(?:ql)?|redis|mysql):\/\/[^\s<>"'`]+/gi, raw => { try { const url = new URL(raw); url.username = ""; url.password = ""; if (url.search) url.search = "?redacted"; return url.toString(); } catch { return "[REDACTED_URL]"; } });
    }
    if (item === null || typeof item !== "object") return typeof item === "bigint" ? String(item) : item;
    if (Buffer.isBuffer(item) || ArrayBuffer.isView(item)) return { binaryOmitted: true, bytes: item.byteLength, sha256: createHash("sha256").update(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)).digest("hex") };
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    try {
      if (item instanceof Date) return item.toISOString();
      if (item instanceof Error) return visit({ name: item.name, message: item.message, stack: item.stack, ...Object.fromEntries(Object.getOwnPropertyNames(item).filter(k => !["name", "message", "stack"].includes(k)).map(k => [k, (item as any)[k]])) });
      if (Array.isArray(item)) return item.filter(x => !(x && ["thinking", "reasoning", "reasoning_content"].includes(x.type))).map(visit);
      // Provider inline image/data bodies may be huge; attachment metadata remains available.
      if (item.type === "image" && typeof item.data === "string") return { type: "image", mimeType: item.mimeType, binaryOmitted: true, encodedLength: item.data.length };
      return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, secretKey.test(key) ? "[REDACTED]" : omittedKey.test(key) ? "[OMITTED]" : visit(v)]));
    } finally { seen.delete(item); }
  };
  return visit(value);
}

export class LocalTrace {
  readonly id = randomUUID();
  readonly file: string;
  private sequence = 0;
  private readonly start = performance.now();
  private readonly secrets = Object.entries(process.env).filter(([k, v]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i.test(k) && v && v.length >= 8).map(([, v]) => v!);
  constructor(directory: string, readonly scope: string, readonly coordinates: Record<string, unknown>) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${scope.replace(/[^a-z0-9_-]/gi, "_")}_${this.id}.jsonl`;
    this.file = join(directory, name);
    closeSync(openSync(this.file, "wx", 0o600));
  }
  record(event: string, data?: unknown) {
    try {
      appendFileSync(this.file, JSON.stringify({ version: 1, traceId: this.id, scope: this.scope, coordinates: sanitizeLocalTrace(this.coordinates, this.secrets),
        sequence: ++this.sequence, at: new Date().toISOString(), elapsedMs: performance.now() - this.start, pid: process.pid,
        event, data: sanitizeLocalTrace(data, this.secrets) }) + "\n", { mode: 0o600 });
    } catch { console.error("[local-trace] write failed; diagnostic record may be incomplete"); }
  }
}
export function localTraceEvent(event: string, data?: unknown) { context.getStore()?.record(event, data); }
export function localTraceEnabled() { return process.env.DELEGATE_LOCAL_TRACE_ENABLED === "1" && !!process.env.DELEGATE_LOCAL_TRACE_DIR && isAbsolute(process.env.DELEGATE_LOCAL_TRACE_DIR); }
export async function withLocalTrace<T>(scope: string, coordinates: Record<string, unknown>, action: () => Promise<T>): Promise<T> {
  if (!localTraceEnabled()) return action();
  let trace: LocalTrace;
  try { trace = new LocalTrace(process.env.DELEGATE_LOCAL_TRACE_DIR!, scope, coordinates); }
  catch { console.error("[local-trace] initialization failed; diagnostics unavailable"); return action(); }
  return context.run(trace, async () => {
    trace.record("lifecycle.started");
    try { const result = await action(); trace.record("lifecycle.completed", result instanceof Response ? { status: result.status } : result); return result; }
    catch (error) { trace.record("lifecycle.failed", { error }); throw error; }
  });
}
