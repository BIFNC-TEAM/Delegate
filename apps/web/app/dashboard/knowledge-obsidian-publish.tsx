"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PublishListing } from "@delegate/web-data/obsidian-publish";
import type { ObsidianReadResult } from "./knowledge-obsidian-types";
import { MAX_OBSIDIAN_NOTES, MAX_OBSIDIAN_SELECTION_BYTES } from "@delegate/web-data/knowledge-obsidian";
import { KnowledgeObsidianSelection } from "./knowledge-obsidian-selection";
import { ObsidianNoteTree, buildObsidianNoteTree } from "./knowledge-obsidian-note-tree";

export function KnowledgeObsidianPublish({ activeSlug, zh, disabled, onRead, onBusyChange }: {
  activeSlug: string; zh: boolean; disabled: boolean; onRead: (result: ObsidianReadResult) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [extraUrl, setExtraUrl] = useState("");
  const [listing, setListing] = useState<PublishListing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const tree = useMemo(() => buildObsidianNoteTree((listing?.notes ?? []).map(note => ({ id: note.url, path: note.path }))), [listing]);
  const locked = disabled || busy;
  function select(ids: string[], checked: boolean) {
    setSelected(current => { const next = new Set(current); for (const id of ids) { if (checked) next.add(id); else next.delete(id); } return next; });
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true); setError(null); setProgress(null);
    try { await action(next.signal); }
    catch (error) { if (!next.signal.aborted) setError(error instanceof Error ? error.message : "Unable to read Publish."); }
    finally { if (!next.signal.aborted) { setBusy(false); setProgress(null); } }
  }
  async function request(body: unknown, signal: AbortSignal) {
    const response = await fetch("/api/dashboard/obsidian-publish", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), headers: { "Content-Type": "application/json", "X-Delegate-Representative": activeSlug }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to read Publish.");
    signal.throwIfAborted();
    return data;
  }
  function load() {
    void run(async signal => {
      const data = await request({ action: "list", url: url.trim() }, signal) as PublishListing;
      setListing(data);
      setSelected(new Set(data.selectedUrl ? [data.selectedUrl] : []));
    });
  }
  function addLink() {
    if (!listing) return;
    try {
      const target = new URL(extraUrl.trim());
      const base = new URL(listing.site.url);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.username || target.password) throw new Error(zh ? "请添加当前站点内的笔记链接。" : "Add a note from this site.");
      target.hash = ""; target.search = "";
      const path = decodeURIComponent(target.pathname.slice(base.pathname.length).replace(/\+/g, " "));
      if (!path) throw new Error(zh ? "请输入具体笔记链接。" : "Enter a note URL.");
      setListing({ ...listing, notes: [...listing.notes.filter(note => note.url !== target.href), { url: target.href, path: /\.md$/i.test(path) ? path : `${path}.md` }].sort((a, b) => a.path.localeCompare(b.path)) });
      select([target.href], true); setExtraUrl(""); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Invalid URL."); }
  }
  function download() {
    if (!listing) return;
    void run(async signal => {
      const urls = [...selected];
      if (urls.length > MAX_OBSIDIAN_NOTES) throw new Error(zh ? "每次最多选择 1000 篇笔记。" : "Select up to 1000 notes.");
      const root = `publish-${listing.site.id}`;
      const files: ObsidianReadResult["files"] = [];
      let bytes = 0;
      for (let offset = 0; offset < urls.length; offset += 8) {
        setProgress(zh ? `正在读取所选笔记 ${offset} / ${urls.length}` : `Reading selected notes ${offset} / ${urls.length}`);
        const data = await request({ action: "download", url: listing.site.url, selected: urls.slice(offset, offset + 8) }, signal) as {
          files: { path: string; text: string; sourceUrl: string }[]; importedAt: string;
        };
        for (const note of data.files) {
          const file = new File([note.text], note.path.split("/").pop()!, { type: "text/markdown" });
          bytes += file.size;
          if (bytes > MAX_OBSIDIAN_SELECTION_BYTES) throw new Error(zh ? "所选正文超过 40 MB，请分批导入。" : "Selection exceeds 40 MB. Import a smaller batch.");
          files.push({ path: `${root}/${note.path}`, file, publishSource: { siteName: listing.site.name, sourceUrl: note.sourceUrl, originalPath: note.path, importedAt: data.importedAt } });
        }
      }
      onRead({
        files,
        availablePaths: listing.notes.map(note => `${root}/${note.path}`),
      });
      setSelected(new Set());
    });
  }
  return <section className="knowledge-obsidian-sync" aria-label="Obsidian Publish" aria-busy={busy}>
    <label className="knowledge-form-field"><span>{zh ? "Publish 站点或笔记网址" : "Publish site or note URL"}</span><input type="url" value={url} disabled={locked} placeholder="https://publish.obsidian.md/your-site" onChange={event => { setUrl(event.target.value); setListing(null); setSelected(new Set()); }} /></label>
    <div className="knowledge-sync-selection-footer"><small>{zh ? "支持公开站点和自定义域名，暂不支持密码保护站点。" : "Public sites and custom domains supported. Password-protected sites are not supported."}</small><button type="button" className="knowledge-sync-primary" disabled={locked || !url.trim()} onClick={load}>{zh ? "获取笔记列表" : "Load notes"}</button></div>
    {listing ? <>
      {listing.incomplete ? <div className="knowledge-obsidian-notice" role="status"><p>{zh ? `已找到 ${listing.notes.length} 篇笔记，列表可能不完整。找不到需要的笔记？可在下方添加笔记链接。` : `Found ${listing.notes.length} notes. The list may be incomplete. Add a missing note URL below.`}</p></div> : null}
      <KnowledgeObsidianSelection zh={zh} disabled={locked} selectedCount={selected.size} totalCount={listing.notes.length} onSelectAll={checked => select(listing.notes.map(note => note.url), checked)}>
        <ObsidianNoteTree node={tree} selected={selected} select={select} />
      </KnowledgeObsidianSelection>
      <details className="knowledge-publish-add-link"><summary>{zh ? "找不到笔记？添加笔记链接" : "Missing a note? Add its URL"}</summary><label className="knowledge-form-field"><span>{zh ? "当前站点内的笔记链接" : "Note URL within this site"}</span><input type="url" disabled={locked} value={extraUrl} onChange={event => setExtraUrl(event.target.value)} /></label><button type="button" disabled={locked || !extraUrl.trim()} onClick={addLink}>{zh ? "添加到列表" : "Add to list"}</button></details>
      <div className="knowledge-sync-selection-footer"><small>{zh ? "仅下载所选笔记，不自动导入引用笔记或附件。" : "Download selected notes only. Linked notes and attachments are not imported automatically."}</small><button type="button" className="knowledge-sync-primary" disabled={locked || !selected.size} onClick={download}>{zh ? "上传所选文件 →" : "Upload selected files →"}</button></div>
    </> : null}
    {busy ? <div className="knowledge-sync-selection-footer"><small role="status">{progress ?? (zh ? "正在读取，请稍候…" : "Reading, please wait…")}</small><button type="button" onClick={() => { controller.current?.abort(); setBusy(false); setProgress(null); }}>{zh ? "取消读取" : "Cancel reading"}</button></div> : null}
    {error ? <p className="knowledge-form-error" role="alert">{error}</p> : null}
  </section>;
}
