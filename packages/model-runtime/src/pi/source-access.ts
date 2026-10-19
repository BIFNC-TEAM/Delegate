import type { PiToolObservation } from "./types";

/** Explicit user method requirement, not a claim inferred from model prose.
 * Asking for citations alone does not require a page visit. */
export function requestsOriginalPageRead(request: string): boolean {
  const text = request.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"/gu, " ");
  return text.split(/[。；;\n]/u).some(clause => {
    if (/(?:不要|不用|不需要|无需|不必|禁止|别).{0,12}(?:打开|阅读|读取|访问|查阅)|(?:do not|don't|no need to|without)\s+(?:actually\s+)?(?:open|read|visit|access)(?:ing)?\b/iu.test(clause)) return false;
    return /(?:实际|亲自|直接)(?:查阅|阅读|读取|访问|打开)(?:过|的)?[^。；;\n]{0,16}(?:网页|页面|网站|官网|原文)|(?:打开|阅读|读取|访问|查阅)(?:一下)?\s*(?:原网页|原页面|网页原文|官网原文|原始网页|原始页面)|\b(?:open|read|visit|access)\s+(?:the\s+)?original\s+(?:web\s*page|page|website)\b|\bsources?\s+(?:that\s+)?you\s+(?:have\s+)?actually\s+(?:read|visited|opened)\s+(?:on\s+the\s+web|online)\b/iu.test(clause);
  });
}

/** Narrow fallback for explicit report headings the reviewer can omit from claim extraction. */
export function explicitPageReadHeadings(candidate: string): string[] {
  const lines = candidate.split(/\r?\n/u);
  const claims: string[] = [];
  let fence = "";
  const noRead = /^(?:none\b|not\s+(?:read|opened|visited)\b|no\s+(?:pages?|sources?)\b|无|未|没有|尚未)/iu;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const marker = /^(?:`{3,}|~{3,})/u.exec(line)?.[0];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; continue; }
    if (fence || line.startsWith(">")) continue;
    const unstyled = line.replace(/^#{1,6}\s+/u, "").replace(/\*\*|__/gu, "");
    if (/(?:[:：]|[（(])\s*(?:none\b|无|未|没有|尚未)/iu.test(unstyled)) continue;
    const plain = unstyled.replace(/[（(][^()（）]*[）)]/gu, "").trim();
    if (!/^(?:(?:实际|已经|已)(?:直接)?(?:查阅|阅读|读取|访问|打开)(?:的)?(?:原始)?(?:网页|页面|原文|网站)(?:来源|出处|列表)?|(?:pages|webpages|web pages|websites|sources)\s+(?:actually\s+)?(?:read|opened|visited|verified))\s*(?:[:：]|$)/iu.test(plain)) continue;
    const following = lines.slice(index + 1).find(value => value.trim())?.trim().replace(/^(?:[-*]\s+|\*\*)/u, "") ?? "";
    if (noRead.test(following)) continue;
    claims.push(line);
  }
  return claims;
}

/** A summary of actual adapter observations, never of URLs/claims embedded in page text. */
export function buildObservationAccess(observation: PiToolObservation) {
  const available = ["completed", "succeeded", "success", "found"].includes(observation.status)
    && (!observation.observation || observation.observation.state === "available");
  const method = observation.toolName === "browse_in_sandbox" ? "browser_page"
    : observation.toolName === "retrieve_authorized_knowledge" ? "authorized_material" : "tool_or_search_result";
  const directlyReadPages: Array<{ title: string; url: string }> = [];
  if (available && method === "browser_page") {
    for (const source of observation.sources) {
      if (!source || source.channel !== "web" || typeof source.url !== "string" || source.url.length > 4096) continue;
      try {
        const url = new URL(source.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
        if (!directlyReadPages.some(page => page.url === source.url)) directlyReadPages.push({ title: source.title, url: source.url });
      } catch { /* An invalid source address is not a verified browser visit. */ }
    }
  }
  return { callId: observation.callId, method, available, directlyReadPages };
}

export const sourceAccessInstructions = [
  "SOURCE ACCESS CHECK: Evaluate factual content and claimed access separately. observationAccess/sourceAccess summarize which pages the adapters actually read. A webpage citing another organization does not establish that the original announcement was read. A search result listing an official page is not a browser read of that page. A failed access is not a successful read.",
  "Judge personal access claims literally, independently of whether the underlying fact is true. If an answer says it directly read a museum announcement but the only read was a newsletter citing it, that access claim is unsupported. Faithful reporting of the newsletter or search snippet without claiming a separate visit is allowed. Do not impose an original-page visit solely to report what a secondary source or search snippet explicitly says, unless the user requires that visit or verification. Returned URLs can satisfy a URL-only search request. User-supplied names, quotations, negated access claims and suggestions to visit a source are not claims of completed access.",
].join("\n");
