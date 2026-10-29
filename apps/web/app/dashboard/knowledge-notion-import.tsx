"use client";

import { useEffect, useRef, useState } from "react";
import type { NotionConnectionInfo, NotionDocument, NotionEntry } from "@delegate/web-data/notion-types";
import { KnowledgeObsidianSelection } from "./knowledge-obsidian-selection";

export function KnowledgeNotionImport({ activeSlug, zh, disabled, onPrepared, onBusyChange }: {
  activeSlug: string; zh: boolean; disabled: boolean;
  onPrepared: (documents: NotionDocument[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [connections, setConnections] = useState<NotionConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [entries, setEntries] = useState<NotionEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState(""); const [link, setLink] = useState("");
  const [busy, setBusy] = useState(true); const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<NotionDocument[]>([]);
  const [failures, setFailures] = useState<{ id: string; title: string; error: string }[]>([]);
  const controller = useRef<AbortController | null>(null);
  const locked = disabled || busy;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    void run(async signal => {
      const data = await request({ action: "status" }, signal);
      setConnections(data.connections); setConnectionId(data.connections[0]?.id ?? "");
      if (data.connections[0]) await load(data.connections[0].id, signal);
    });
    return () => controller.current?.abort();
    // Scope is fixed for the lifetime of the import dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function request(body: unknown, signal: AbortSignal) {
    const response = await fetch("/api/dashboard/notion", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(115_000)]), headers: { "Content-Type": "application/json", "X-Delegate-Representative": activeSlug }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Notion request failed.");
    signal.throwIfAborted(); return data;
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort(); const next = new AbortController(); controller.current = next;
    setBusy(true); setError(null);
    try { await action(next.signal); } catch (error) { if (!next.signal.aborted) setError(error instanceof Error ? error.message : "Notion request failed."); }
    finally { if (controller.current === next && !next.signal.aborted) { setBusy(false); setProgress(""); } }
  }
  function merge(items: NotionEntry[]) {
    setEntries(current => [...new Map([...current, ...items].map(item => [item.id, item])).values()]);
  }
  async function load(id: string, signal: AbortSignal) {
    const data = await request({ action: "list", connectionId: id, query }, signal);
    // Preserve selections and already discovered records when refreshing/searching.
    merge(data.entries); setExpanded(false);
  }
  function connect() {
    // Open synchronously from the click so browsers do not treat this as an unsolicited popup.
    // Keep this dialog mounted: pending reads, selections and upload files must survive reauthorization.
    const popup = window.open("about:blank", "_blank", "popup,width=720,height=800");
    if (!popup) { setError(zh ? "请允许此站点打开授权窗口，然后重试。" : "Allow the authorization popup and retry."); return; }
    void run(async signal => {
      try {
        const data = await request({ action: "connect", lang: zh ? "zh" : "en", representative: activeSlug }, signal);
        popup.location.href = data.url;
        setProgress(zh ? "请在 Notion 窗口选择允许访问的页面并完成授权。" : "Select pages and finish authorization in Notion.");
        const result = await new Promise<string>((resolve, reject) => {
          const finish = (value?: string) => { clearInterval(timer); clearTimeout(timeout); signal.removeEventListener("abort", abort); if (value) resolve(value); else reject(signal.reason); };
          const abort = () => finish();
          const timer = window.setInterval(() => {
            if (popup.closed) { finish("cancelled"); return; }
            try {
              const url = new URL(popup.location.href);
              if (url.origin === window.location.origin && url.pathname === "/dashboard" && url.searchParams.has("notionResult")) finish(url.searchParams.get("notionResult")!);
            } catch { /* Notion is cross-origin until it returns to our callback. */ }
          }, 400);
          const timeout = window.setTimeout(() => finish("error"), 600_000);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        if (result === "error") throw new Error(zh ? "授权未完成或已过期，请重新连接。" : "Authorization failed or expired. Reconnect.");
        if (result === "cancelled") { setNotice(zh ? "已取消授权，当前选择已保留。" : "Authorization cancelled. Your selection is preserved."); return; }
        const status = await request({ action: "status" }, signal);
        const previousWorkspace = connections.find(item => item.id === connectionId)?.workspaceId;
        const active = status.connections.find((item: NotionConnectionInfo) => item.workspaceId === previousWorkspace) ?? status.connections.at(-1);
        setConnections(status.connections); setConnectionId(active?.id ?? "");
        if (active) await load(active.id, signal);
        setNotice(zh ? "授权成功。可选择已授权页面，或重试刚才未能读取的内容。" : "Connected. Select pages or retry unavailable content.");
      } finally { popup.close(); }
    });
  }
  function toggle(ids: string[], checked: boolean) {
    setSelected(current => { const next = new Set(current); for (const id of ids) { if (checked) next.add(id); else next.delete(id); } return next; });
    if (checked) setExpanded(false);
  }
  async function download(ids: string[], signal: AbortSignal) {
    for (let i = 0; i < ids.length; i++) {
      signal.throwIfAborted();
      setProgress(zh ? `正在读取 ${i + 1} / ${ids.length} 篇` : `Reading ${i + 1} / ${ids.length}`);
      const id = ids[i]!;
      try {
        const { document } = await request({ action: "read", connectionId, pageId: id }, signal) as { document: NotionDocument };
        if (document.metadata.incomplete) setPending(current => [...current.filter(item => item.id !== id), document]);
        else { onPrepared([document]); setPending(current => current.filter(item => item.id !== id)); }
        setFailures(current => current.filter(item => item.id !== id));
        setSelected(current => { const next = new Set(current); next.delete(id); return next; });
      } catch (error) {
        signal.throwIfAborted();
        const failure = { id, title: entries.find(item => item.id === id)?.title ?? id, error: error instanceof Error ? error.message : "Read failed" };
        setFailures(current => [...current.filter(item => item.id !== id), failure]);
      }
    }
  }
  const visible = entries.filter(item => !query || item.title.toLowerCase().includes(query.toLowerCase()));
  const pages = visible.filter(item => item.kind === "page");
  return <section className="knowledge-obsidian-sync" aria-label="Notion" aria-busy={busy}>
    {notice ? <p className="knowledge-obsidian-notice" role="status">{notice}</p> : null}
    <div className="knowledge-sync-selection-footer"><small>{zh ? "连接授权保留7天。" : "Connections last 7 days. Selected content is imported as a snapshot."}</small><button type="button" disabled={locked} onClick={connect}>{zh ? (connections.length ? "连接其他工作空间 / 补充授权" : "连接 Notion") : "Connect / update access"}</button></div>
    {connections.length ? <>
      <div className="knowledge-sync-vault-row"><label className="knowledge-form-field"><span>{zh ? "工作空间" : "Workspace"}</span><select disabled={locked} value={connectionId} onChange={event => {
        const id = event.target.value; setConnectionId(id); setEntries([]); setSelected(new Set()); setPending([]); setFailures([]); setExpanded(false);
        void run(signal => load(id, signal));
      }}>{connections.map(item => <option key={item.id} value={item.id}>{item.workspaceName}</option>)}</select></label><button type="button" disabled={locked} onClick={() => void run(async signal => {
        await request({ action: "disconnect", connectionId }, signal);
        const remaining = connections.filter(item => item.id !== connectionId); setConnections(remaining); setConnectionId(remaining[0]?.id ?? ""); setEntries([]); setSelected(new Set()); setPending([]); setFailures([]);
        if (remaining[0]) await load(remaining[0].id, signal);
      })}>{zh ? "断开连接" : "Disconnect"}</button></div>
      {/* Search controls temporarily hidden; retained for restoration.
      <div className="knowledge-sync-vault-row"><label className="knowledge-form-field"><span>{zh ? "搜索页面" : "Search pages"}</span><input value={query} disabled={locked} onChange={event => setQuery(event.target.value)} /></label><button type="button" disabled={locked} onClick={() => void run(signal => load(connectionId, signal))}>{zh ? "搜索 / 刷新列表" : "Search / refresh"}</button></div>
      */}
      <KnowledgeObsidianSelection zh={zh} disabled={locked} selectedCount={pages.filter(p => selected.has(p.id)).length} totalCount={pages.length} onSelectAll={checked => toggle(pages.map(p => p.id), checked)}>
        <ul className="knowledge-obsidian-tree">{pages.map(page => <li key={page.id}><label><input type="checkbox" checked={selected.has(page.id)} onChange={event => toggle([page.id], event.target.checked)} /><span>{page.title}</span></label></li>)}</ul>
      </KnowledgeObsidianSelection>
      <label className="knowledge-conflict-policy knowledge-notion-include-children"><input type="checkbox" checked={children} disabled={locked} onChange={event => { setChildren(event.target.checked); setExpanded(false); }} /><span>{zh ? "导入页面时是否自动导入其子页面" : "Include descendant pages"}</span></label>
      <details className="knowledge-publish-add-link"><summary>{zh ? "找不到页面？添加已授权页面链接" : "Missing a page? Add its URL"}</summary><label className="knowledge-form-field"><span>{zh ? "Notion 页面链接" : "Notion page URL"}</span><input type="url" value={link} disabled={locked} onChange={event => setLink(event.target.value)} /></label><button type="button" disabled={locked || !link.trim()} onClick={() => void run(async signal => { const data = await request({ action: "lookup", connectionId, url: link }, signal); merge([data.entry]); toggle([data.entry.id], true); setLink(""); setQuery(""); })}>{zh ? "添加页面" : "Add page"}</button></details>
      <div className="knowledge-sync-selection-footer"><small>{zh ? `共选 ${selected.size} 篇；附件、评论和外部嵌入正文不导入。` : `${selected.size} selected. Attachments, comments and external embeds excluded.`}</small><button type="button" className="knowledge-sync-primary" disabled={locked || !selected.size} onClick={() => void run(async signal => {
        if (children && !expanded) {
          const data = await request({ action: "expand", connectionId, selected: [...selected] }, signal);
          merge(data.entries); setSelected(new Set(data.entries.map((p: NotionEntry) => p.id))); setExpanded(true); setQuery("");
        } else await download([...selected], signal);
      })}>{children && !expanded ? (zh ? "展开并确认子页面" : "Review descendants") : (zh ? "上传所选文件 →" : "Upload selected files →")}</button></div>
      {pending.map(item => <div className="knowledge-obsidian-notice" key={item.id}><strong>{item.title}</strong><ul>{item.metadata.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><div className="knowledge-sync-selection-footer"><a href={item.metadata.sourceUrl} target="_blank" rel="noreferrer">{zh ? "前往 Notion 检查来源权限" : "Check access in Notion"} ↗</a><button type="button" disabled={locked} onClick={() => void run(signal => download([item.id], signal))}>{zh ? "重新读取" : "Retry"}</button><button type="button" disabled={locked} onClick={() => { onPrepared([item]); setPending(current => current.filter(doc => doc.id !== item.id)); }}>{zh ? "仅导入已读取内容" : "Import available content"}</button></div></div>)}
      {failures.map(item => <div className="knowledge-form-error" key={item.id}><strong>{item.title}</strong><p>{item.error}</p><button type="button" disabled={locked} onClick={() => void run(signal => download([item.id], signal))}>{zh ? "重试此页面" : "Retry page"}</button></div>)}
    </> : null}
    {busy ? <div className="knowledge-sync-selection-footer"><small role="status">{progress || (zh ? "正在加载…" : "Loading…")}</small><button type="button" onClick={() => { controller.current?.abort(); setBusy(false); setProgress(""); }}>{zh ? "取消" : "Cancel"}</button></div> : null}
    {error ? <p className="knowledge-form-error" role="alert">{error}<button type="button" disabled={locked} onClick={() => void run(async signal => { const data = await request({ action: "status" }, signal); setConnections(data.connections); setConnectionId(data.connections[0]?.id ?? ""); if (data.connections[0]) await load(data.connections[0].id, signal); })}>{zh ? "重试" : "Retry"}</button></p> : null}
  </section>;
}
