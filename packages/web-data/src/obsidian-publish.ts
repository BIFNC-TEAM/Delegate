import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { isObsidianNotePath, MAX_OBSIDIAN_CHARACTERS, MAX_OBSIDIAN_NOTES, MAX_OBSIDIAN_SELECTION_BYTES } from "./knowledge-obsidian";

export class PublishError extends Error {}
export type PublishNote = { url: string; path: string };
export type PublishSite = { id: string; host: string; url: string; name: string };
export type PublishListing = { site: PublishSite; notes: PublishNote[]; incomplete: boolean; selectedUrl: string | null };
type Page = { url: string; text: string };
type ReadPage = (url: string, limit?: number) => Promise<Page>;
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix);

export function publishUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(url.hostname.replace(/^\[|\]$/g, "")) || url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new PublishError("请输入 HTTPS 公网 Publish 地址。 / Enter a public HTTPS Publish URL.");
  }
  url.hash = "";
  return url;
}

// Resolve and pin a public address for each request, including redirects. Never execute site scripts.
export async function readPublishPage(raw: string, limit = 2 * 1024 * 1024, redirects = 0, signal?: AbortSignal): Promise<Page> {
  signal?.throwIfAborted();
  const url = publishUrl(raw);
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => blocked.check(address))) throw new PublishError("无法访问该公网地址。 / Public address unavailable.");
  const result = await new Promise<{ status: number; location: string | undefined; text: string }>((resolve, reject) => {
    const req = request(url, {
      agent: false, family: 4, ...(signal ? { signal } : {}),
      lookup: (_hostname, _options, callback) => callback(null, addresses[0]!.address, 4),
      headers: { "User-Agent": "Delegate-Knowledge-Ingest/1.0", Accept: "text/html,application/xml,text/plain", "Accept-Encoding": "identity" },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) req.destroy(new PublishError("页面超出读取限制，请分批导入。 / Page exceeds import limits."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 500, location: response.headers.location, text: Buffer.concat(chunks).toString("utf8") }));
    });
    const timer = setTimeout(() => req.destroy(new PublishError("读取超时，请重试。 / Reading timed out.")), 15_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location) {
    if (redirects >= 3) throw new PublishError("网址跳转次数过多。 / Too many redirects.");
    return readPublishPage(new URL(result.location, url).href, limit, redirects + 1, signal);
  }
  if ([401, 403].includes(result.status)) throw new PublishError("该站点需要访问授权；目前仅支持公开 Publish 站点。 / Only public Publish sites are supported.");
  if (result.status !== 200) throw new PublishError(`无法读取页面（HTTP ${result.status}）。 / Page unavailable.`);
  return { url: url.href, text: result.text };
}

const infoSchema = z.object({ uid: z.string().regex(/^[a-f0-9]{32}$/), host: z.string().regex(/^publish-\d{1,3}\.obsidian\.md$/), slug: z.string().nullable().optional(), customurl: z.string().nullable().optional() });
const decodeXml = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
function siteFromPage(page: Page): PublishSite {
  const match = page.text.match(/window\.siteInfo\s*=\s*(\{[^\n]*?\});/);
  if (!match) throw new PublishError("未识别到 Obsidian Publish 站点。 / This is not a supported Obsidian Publish site.");
  const info = infoSchema.parse(JSON.parse(match[1]!));
  const actual = new URL(page.url);
  const base = info.customurl ? new URL(`https://${info.customurl.replace(/^https?:\/\//, "")}/`) : new URL(`https://publish.obsidian.md/${encodeURIComponent(info.slug ?? "")}/`);
  if (base.origin !== actual.origin || !actual.pathname.startsWith(base.pathname.replace(/\/$/, ""))) throw new PublishError("站点地址不匹配。 / Site address mismatch.");
  const title = decodeXml(page.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? base.hostname).replace(/ - Obsidian Publish$/, "");
  return { id: info.uid, host: info.host, url: base.href, name: (title.split(" - ").slice(1).join(" - ") || title).slice(0, 512) };
}

export function publishNote(urlValue: string, site: PublishSite): PublishNote {
  const url = publishUrl(urlValue);
  const base = new URL(site.url);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new PublishError("请添加当前站点内的笔记链接。 / Add a note from this site.");
  url.search = "";
  let path = decodeURIComponent(url.pathname.slice(base.pathname.length).replace(/\+/g, " "));
  if (/\.(?:png|jpe?g|gif|svg|webp|pdf|mp[34]|wav|zip|css|js|xml)$/i.test(path)) throw new PublishError("仅支持笔记，不导入附件。 / Notes only; attachments are excluded.");
  if (!/\.(md|markdown)$/i.test(path)) path += ".md";
  if (!isObsidianNotePath(path)) throw new PublishError("无效的笔记链接。 / Invalid note URL.");
  return { url: url.href, path };
}

function markdownUrl(page: Page, site: PublishSite): string | null {
  const value = page.text.match(/window\.preloadPage\s*=\s*f\(("(?:[^"\\]|\\.)*")\)/)?.[1];
  if (!value) return null;
  const url = publishUrl(JSON.parse(value));
  const prefix = `/access/${site.id}/`;
  if (url.hostname !== site.host || !url.pathname.startsWith(prefix) || !isObsidianNotePath(decodeURIComponent(url.pathname.slice(prefix.length)))) throw new PublishError("笔记来源不匹配。 / Note source mismatch.");
  return url.href;
}

export function createPublishReader(read: ReadPage = readPublishPage) {
  return {
    async list(raw: string): Promise<PublishListing> {
      const page = await read(publishUrl(raw).href);
      const site = siteFromPage(page);
      const notes = new Map<string, PublishNote>();
      let incomplete = false;
      try {
        const sitemap = await read(new URL("sitemap.xml", site.url).href);
        if (!/<urlset\b/.test(sitemap.text)) throw new Error("No URL index");
        for (const match of sitemap.text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)) {
          try {
            const note = publishNote(decodeXml(match[1]!.trim()), site);
            if (notes.size >= 5000) { incomplete = true; break; }
            notes.set(note.url, note);
          } catch { incomplete = true; }
        }
        if (!notes.size) incomplete = true;
      } catch { incomplete = true; }
      // Inspect only the HTML shell. Do not fetch preloadPage or the site's rich cache here.
      let selectedUrl: string | null = null;
      const rootPath = new URL(site.url).pathname.replace(/\/$/, "");
      if (new URL(page.url).pathname.replace(/\/$/, "") !== rootPath && markdownUrl(page, site)) {
        const note = publishNote(page.url, site);
        notes.set(note.url, note);
        selectedUrl = note.url;
      }
      return { site, notes: [...notes.values()].sort((a, b) => a.path.localeCompare(b.path)), incomplete, selectedUrl };
    },
    async download(raw: string, selected: string[]) {
      if (!selected.length || selected.length > MAX_OBSIDIAN_NOTES) throw new PublishError("请选择 1–1000 篇笔记。 / Select 1–1000 notes.");
      const page = await read(publishUrl(raw).href);
      const site = siteFromPage(page);
      const files: { path: string; text: string; sourceUrl: string }[] = [];
      let bytes = 0;
      const unique = [...new Set(selected)];
      for (let offset = 0; offset < unique.length; offset += 4) {
        const batch = await Promise.all(unique.slice(offset, offset + 4).map(async input => {
          const note = publishNote(input, site);
          const shell = note.url === page.url ? page : await read(note.url);
          const actualSite = siteFromPage(shell);
          if (actualSite.id !== site.id) throw new PublishError("笔记已跳转至其他站点。 / Note moved to another site.");
          const url = markdownUrl(shell, site);
          if (!url) throw new PublishError("无法读取笔记；密码保护站点暂不支持。 / Note unavailable; password-protected sites are not supported.");
          const body = await read(url, MAX_OBSIDIAN_CHARACTERS * 4);
          if (body.url !== url || /^\s*(?:<!doctype|<html)/i.test(body.text) || !body.text.trim()) throw new PublishError("未取得有效笔记正文。 / No valid note content returned.");
          if (body.text.length > MAX_OBSIDIAN_CHARACTERS) throw new PublishError("笔记过长，请拆分后导入。 / Note exceeds character limit.");
          bytes += Buffer.byteLength(body.text);
          if (bytes > MAX_OBSIDIAN_SELECTION_BYTES) throw new PublishError("所选正文超过 40 MB，请分批导入。 / Selection exceeds 40 MB.");
          return { path: decodeURIComponent(new URL(url).pathname.slice(`/access/${site.id}/`.length)), text: body.text, sourceUrl: shell.url };
        }));
        files.push(...batch);
      }
      return { site, files, importedAt: new Date().toISOString() };
    },
  };
}
