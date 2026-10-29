import { NotionError } from "./types";
import { notionFetch } from "./transport";

// The adapter never follows user-provided URLs or redirects with credentials.
export type NotionObject = Record<string, any>;
export class NotionClient {
  constructor(private token: string, private signal?: AbortSignal, private transport: typeof fetch = notionFetch) {}
  private async pause(seconds: number) {
    this.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { this.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, Math.max(1, seconds) * 1000);
      const abort = () => { clearTimeout(timer); this.signal?.removeEventListener("abort", abort); reject(this.signal?.reason); };
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
    });
  }
  async request(path: string, body?: unknown): Promise<NotionObject> {
    if (!/^\/(pages|blocks|search|data_sources|databases)(\/|\?|$)/.test(path)) throw new Error("Invalid Notion endpoint");
    for (let attempt = 0; attempt < 4; attempt++) {
      this.signal?.throwIfAborted();
      let response: Response;
      try { response = await this.transport(`https://api.notion.com/v1${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      }); } catch {
        this.signal?.throwIfAborted();
        if (attempt === 3) throw new NotionError("NETWORK", "无法连接 Notion，请检查网络后重试。 / Unable to connect to Notion. Retry later.");
        await this.pause(2 ** attempt);
        continue;
      }
      if ((response.status === 429 || response.status === 529 || response.status === 503) && attempt < 3) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after") ?? 2 ** attempt);
        if (!Number.isFinite(seconds) || seconds > 20) throw new NotionError("LIMIT", "Notion 请求繁忙，请稍后重试。 / Notion is busy. Retry later.");
        await this.pause(seconds);
        continue;
      }
      if (response.status === 401) throw new NotionError("AUTH", "Notion 连接已失效，请重新授权。 / Reconnect Notion.");
      if (response.status === 403 || response.status === 404) throw new NotionError("ACCESS", "页面不可访问，可能已删除或尚未授权。 / Page unavailable or not shared.");
      if (!response.ok) throw new NotionError("NETWORK", "Notion 读取失败，请重试。 / Unable to read Notion.");
      // Bound decoded responses, not just Content-Length (which may be compressed).
      const reader = response.body?.getReader();
      if (!reader) throw new NotionError("NETWORK", "Notion 返回了空响应。 / Empty response.");
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new NotionError("LIMIT", "Notion 响应过大，请减少选择。 / Response too large."); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    throw new NotionError("NETWORK", "Notion 请求失败。 / Request failed.");
  }
  async all(path: string, body?: NotionObject, limit = 1000): Promise<NotionObject[]> {
    return (await this.collection(path, body, limit)).items;
  }
  async collection(path: string, body?: NotionObject, limit = 1000): Promise<{ items: NotionObject[]; last: NotionObject }> {
    const items: NotionObject[] = []; let cursor: string | undefined;
    let last: NotionObject = {};
    const cursors = new Set<string>();
    do {
      const data = body === undefined
        ? await this.request(`${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`)
        : await this.request(path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      items.push(...(data.results ?? []));
      last = data;
      if (items.length > limit) throw new NotionError("LIMIT", "内容超出单次读取限制，请缩小范围。 / Too many items. Narrow the selection.");
      cursor = data.has_more ? data.next_cursor : undefined;
      if (data.has_more && !cursor) throw new NotionError("NETWORK", "Notion 分页不完整，请重试。 / Incomplete pagination.");
      if (cursor && cursors.has(cursor)) throw new NotionError("NETWORK", "Notion 分页异常，请重试。 / Invalid pagination.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { items, last };
  }
}
