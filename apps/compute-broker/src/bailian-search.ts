import { isBailianSearchEndpoint } from "@delegate/web-data";
import { SessionError } from "./session-error";

/** This server-held credential is never stored in a binding, URL, tool argument or artifact. */
export function publicSearchHeaders(url: URL, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!isBailianSearchEndpoint(url.href)) return {};
  const key = environment.DELEGATE_BAILIAN_API_KEY?.trim();
  if (!key) throw new SessionError(503, "mcp_search_credentials_missing");
  return { authorization: `Bearer ${key}` };
}

/** Keep actual snippets and links, not provider images/tracking metadata or generated answers. */
export function normalizePublicSearchResult(value: unknown): {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
} {
  const failed = () => ({ isError: true, content: [{ type: "text" as const, text: "Public search failed or returned an invalid receipt; no verified search results." }] });
  const record = value as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
  if (!record || record.isError || !Array.isArray(record.content)) return failed();
  const texts = record.content.filter(item => item && item.type === "text" && typeof item.text === "string");
  if (texts.length !== 1) return failed();
  let payload: { status?: number; request_id?: string; pages?: Array<{ title?: string; url?: string; snippet?: string }> };
  try { payload = JSON.parse(texts[0]!.text!); } catch { return failed(); }
  if (!payload || payload.status !== 0 || typeof payload.request_id !== "string" || !payload.request_id.trim()
    || !Array.isArray(payload.pages)) return failed();
  const pages: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of payload.pages.slice(0, 10)) {
    if (!item || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.snippet !== "string") return failed();
    try {
      const url = new URL(item.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || item.url.length > 4096) return failed();
    } catch { return failed(); }
    pages.push({ title: item.title.slice(0, 300), url: item.url, snippet: item.snippet.slice(0, 2000) });
  }
  return { isError: false, content: [{ type: "text", text: JSON.stringify({
    kind: "public_search_results", provider: "Alibaba Cloud EnhancedSearch", requestId: payload.request_id,
    totalResults: payload.pages.length, returnedCount: pages.length, truncated: payload.pages.length > pages.length,
    note: "These are retrieved search snippets and source URLs, not full-page reads. Snippets can be incomplete or stale. Open relevant URLs with the browser for current details or when the user requests browser verification. Search time is not the source's data time. No matches do not establish that information does not exist.",
    pages,
  }) }] };
}
