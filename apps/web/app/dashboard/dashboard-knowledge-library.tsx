"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  KnowledgeAssetRecord,
  KnowledgeRepresentativeOption,
} from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type LibraryResponse = {
  assets: KnowledgeAssetRecord[];
  representatives: KnowledgeRepresentativeOption[];
};

type ImportMode = "file" | "url" | "text";
type Visibility = KnowledgeAssetRecord["visibility"];
type UploadConflictPolicy = "skip_duplicates" | "replace_existing" | "keep_both";
type UploadQueueStatus = "queued" | "uploading" | "processing" | "completed" | "skipped" | "failed";
type UploadQueueItem = {
  id: string;
  file: File;
  status: UploadQueueStatus;
  progress: number;
  assetId?: string;
  message?: string;
};
type FileUploadResponse = {
  asset: KnowledgeAssetRecord;
  upload: {
    outcome: "created" | "replaced" | "skipped_duplicate";
    conflictType?: "exact" | "same_name";
    conflictAssetId?: string;
  };
};

const MAX_BATCH_FILES = 20;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;

const visibilityOptions: Array<{ value: Visibility; zh: string; en: string; detailZh: string; detailEn: string }> = [
  { value: "owner_only", zh: "仅 Owner", en: "Owner only", detailZh: "只有工作区所有者可以使用", detailEn: "Only the workspace owner can use it" },
  { value: "organization_shared", zh: "组织共享", en: "Organization shared", detailZh: "组织成员和代表可按规则访问", detailEn: "Available across the organization" },
  { value: "selected_representatives", zh: "指定代表", en: "Selected representatives", detailZh: "仅关联的对外代理可使用", detailEn: "Only linked representatives can use it" },
  { value: "public_material", zh: "公开资料", en: "Public material", detailZh: "可用于公开回答和资料交付", detailEn: "Safe for public answers and delivery" },
];

export function DashboardKnowledgeLibrary({ activeSlug, locale }: { activeSlug: string; locale: Locale }) {
  const zh = locale === "zh";
  const [assets, setAssets] = useState<KnowledgeAssetRecord[]>([]);
  const [representatives, setRepresentatives] = useState<KnowledgeRepresentativeOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [visibility, setVisibility] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);

  const loadLibrary = useCallback(async (options: { silent?: boolean } = {}) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (!options.silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("query", query.trim());
      if (status) params.set("status", status);
      if (kind) params.set("kind", kind);
      if (visibility) params.set("visibility", visibility);
      if (includeArchived) params.set("includeArchived", "true");
      const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets?${params}`, { cache: "no-store", signal: controller.signal });
      const payload = await readResponse<LibraryResponse>(response);
      setAssets(payload.assets);
      setRepresentatives(payload.representatives);
      setSelectedId((current) => current && !payload.assets.some((asset) => asset.id === current) ? null : current);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(messageOf(loadError, zh ? "知识库加载失败。" : "Failed to load the knowledge library."));
    } finally {
      if (loadAbortRef.current === controller && !options.silent) setLoading(false);
    }
  }, [activeSlug, includeArchived, kind, query, status, visibility, zh]);

  useEffect(() => {
    loadAbortRef.current?.abort();
    setLoading(true);
    const timer = window.setTimeout(() => void loadLibrary(), query ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      loadAbortRef.current?.abort();
    };
  }, [loadLibrary, query]);

  useEffect(() => {
    if (!assets.some((asset) => asset.status === "processing")) return;
    const timer = window.setInterval(() => void loadLibrary({ silent: true }), 2_000);
    return () => window.clearInterval(timer);
  }, [assets, loadLibrary]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const metrics = useMemo(() => ({
    total: assets.length,
    ready: assets.filter((asset) => asset.status === "ready").length,
    processing: assets.filter((asset) => asset.status === "processing").length,
    failed: assets.filter((asset) => asset.status === "failed").length,
    linked: assets.filter((asset) => asset.representativeLinks.some((link) => link.enabled)).length,
  }), [assets]);

  async function runAssetAction(assetId: string, action: "reprocess" | "archive" | "restore") {
    setError(null);
    try {
      const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets/${assetId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const { asset } = await readResponse<{ asset: KnowledgeAssetRecord }>(response);
      setAssets((current) => current.map((item) => item.id === asset.id ? asset : item));
      await loadLibrary();
      setNotice(action === "reprocess" ? (zh ? "已重新处理知识。" : "Knowledge reprocessed.") : action === "archive" ? (zh ? "已归档。" : "Archived.") : (zh ? "已恢复。" : "Restored."));
    } catch (actionError) {
      setError(messageOf(actionError, zh ? "操作失败。" : "Action failed."));
    }
  }

  async function permanentlyDelete(assetId: string) {
    if (!window.confirm(zh ? "永久删除后无法恢复。确认删除这条知识吗？" : "Permanent deletion cannot be undone. Delete this knowledge asset?")) return;
    try {
      const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets/${assetId}`, { method: "DELETE" });
      await readResponse(response);
      setAssets((current) => current.filter((item) => item.id !== assetId));
      setSelectedId(null);
      setNotice(zh ? "知识已永久删除。" : "Knowledge permanently deleted.");
    } catch (deleteError) {
      setError(messageOf(deleteError, zh ? "删除失败。" : "Delete failed."));
    }
  }

  return (
    <>
      <div
        aria-hidden={importOpen || Boolean(selected) ? true : undefined}
        className="knowledge-page-main"
        inert={importOpen || Boolean(selected) ? true : undefined}
      >
      <header className="knowledge-page-header">
        <div>
          <p>Knowledge Library / 01</p>
          <h1>{zh ? "把每份资料变成可控、可复用的知识。" : "Turn every source into controlled, reusable knowledge."}</h1>
          <span>{zh ? "统一管理文件、网页和手工知识，并明确哪些对外代理可以在什么场景下使用。" : "Manage files, webpages, and authored knowledge with explicit representative permissions."}</span>
        </div>
        <button className="knowledge-primary-button" onClick={() => setImportOpen(true)} type="button">
          <span>＋</span>{zh ? "导入知识" : "Import knowledge"}
        </button>
      </header>

      <section className="knowledge-metrics" aria-label={zh ? "知识库摘要" : "Knowledge summary"}>
        <Metric label={zh ? "当前知识" : "Active knowledge"} value={String(metrics.total).padStart(2, "0")} detail={zh ? "当前筛选范围" : "Current filtered view"} />
        <Metric label={zh ? "处理完成" : "Ready"} value={String(metrics.ready).padStart(2, "0")} detail={zh ? "可以被代表使用" : "Available to representatives"} tone="ready" />
        <Metric label={zh ? "处理中" : "Processing"} value={String(metrics.processing).padStart(2, "0")} detail={zh ? "正在提取或索引" : "Extracting or indexing"} tone="processing" />
        <Metric label={zh ? "异常" : "Failed"} value={String(metrics.failed).padStart(2, "0")} detail={zh ? "需要检查或重试" : "Needs review or retry"} tone={metrics.failed ? "failed" : undefined} />
        <Metric label={zh ? "已关联代表" : "Linked"} value={String(metrics.linked).padStart(2, "0")} detail={zh ? "至少授权给一个代表" : "Linked to at least one rep"} />
      </section>

      {error ? <div className="knowledge-alert" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError(null)} type="button">×</button></div> : null}
      {notice ? <div className="knowledge-toast" role="status"><span>✓</span>{notice}</div> : null}

      <section className="knowledge-library-panel">
        <div className="knowledge-panel-heading">
          <div><span>{zh ? "工作区资产" : "Workspace assets"}</span><h2>{zh ? "知识文件" : "Knowledge assets"}</h2></div>
          <div className="knowledge-heading-actions">
            <label className="knowledge-archive-toggle"><input checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} type="checkbox" /><span>{zh ? "显示归档" : "Show archived"}</span></label>
            <button onClick={() => void loadLibrary()} type="button">↻ <span>{zh ? "刷新" : "Refresh"}</span></button>
          </div>
        </div>

        <div className="knowledge-toolbar">
          <label className="knowledge-search"><span>⌕</span><input aria-label={zh ? "搜索知识" : "Search knowledge"} onChange={(event) => { setLoading(true); setQuery(event.target.value); }} placeholder={zh ? "搜索标题、文件名、网址或标签" : "Search title, filename, URL, or tag"} value={query} /></label>
          <FilterSelect label={zh ? "状态" : "Status"} onChange={setStatus} value={status} options={[["", zh ? "全部状态" : "All statuses"], ["ready", zh ? "已完成" : "Ready"], ["processing", zh ? "处理中" : "Processing"], ["failed", zh ? "异常" : "Failed"], ["archived", zh ? "已归档" : "Archived"]]} />
          <FilterSelect label={zh ? "类型" : "Type"} onChange={setKind} value={kind} options={[["", zh ? "全部类型" : "All types"], ["pdf", "PDF"], ["docx", "DOCX"], ["txt", "TXT"], ["markdown", "Markdown"], ["url", "URL"], ["text", zh ? "手工文本" : "Manual text"]]} />
          <FilterSelect label={zh ? "权限" : "Visibility"} onChange={setVisibility} value={visibility} options={[["", zh ? "全部权限" : "All visibility"], ...visibilityOptions.map((option) => [option.value, zh ? option.zh : option.en] as [string, string])]} />
        </div>

        <div className="knowledge-table-wrap">
          <table className="knowledge-table">
            <thead><tr><th>{zh ? "知识" : "Knowledge"}</th><th>{zh ? "类型 / 标签" : "Type / tags"}</th><th>{zh ? "处理状态" : "Status"}</th><th>{zh ? "权限" : "Visibility"}</th><th>{zh ? "关联代表" : "Representatives"}</th><th>{zh ? "更新时间" : "Updated"}</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {loading ? <LoadingRows /> : assets.length ? assets.map((asset) => (
                <tr className={selectedId === asset.id ? "is-selected" : undefined} key={asset.id} onClick={() => setSelectedId(asset.id)}>
                  <td><div className={`knowledge-file-icon is-${asset.kind}`}>{fileMark(asset.kind)}</div><div className="knowledge-file-name"><strong>{asset.title}</strong><span>{asset.originalFileName ?? asset.sourceUrl ?? (zh ? "手工录入" : "Manual entry")}</span></div></td>
                  <td><div className="knowledge-tag-cell"><span className="knowledge-type-pill">{kindLabel(asset.kind)}</span>{asset.tags.slice(0, 2).map((tag) => <em key={tag}>{tag}</em>)}{asset.tags.length > 2 ? <small>+{asset.tags.length - 2}</small> : null}</div></td>
                  <td><StatusBadge status={asset.status} zh={zh} /></td>
                  <td><span className="knowledge-visibility"><i>{visibilityIcon(asset.visibility)}</i>{visibilityLabel(asset.visibility, zh)}</span></td>
                  <td><RepresentativeStack links={asset.representativeLinks} zh={zh} /></td>
                  <td><time>{formatDate(asset.updatedAt, locale)}</time></td>
                  <td><button aria-label={zh ? "查看详情" : "View details"} className="knowledge-row-open" onClick={(event) => { event.stopPropagation(); setSelectedId(asset.id); }} type="button">→</button></td>
                </tr>
              )) : <tr className="knowledge-empty-row"><td className="knowledge-empty-cell" colSpan={7}><EmptyState hasFilters={Boolean(query || status || kind || visibility)} onImport={() => setImportOpen(true)} zh={zh} /></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="knowledge-panel-footer"><span>{zh ? `显示 ${assets.length} 条知识` : `${assets.length} knowledge assets`}</span><small>{zh ? "文件最大 15 MB · 支持 PDF / DOCX / TXT / MD" : "15 MB max · PDF / DOCX / TXT / MD"}</small></div>
      </section>

      </div>
      {importOpen ? <KnowledgeImportDialog activeSlug={activeSlug} locale={locale} onClose={() => setImportOpen(false)} onCreated={(asset) => { setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]); }} representatives={representatives} /> : null}
      {selected ? <KnowledgeDetailDrawer activeSlug={activeSlug} asset={selected} locale={locale} onAction={runAssetAction} onClose={() => setSelectedId(null)} onDelete={permanentlyDelete} onUpdated={(asset) => setAssets((current) => current.map((item) => item.id === asset.id ? asset : item))} representatives={representatives} /> : null}
    </>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: string | undefined }) {
  return <article className={tone ? `is-${tone}` : undefined}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label className="knowledge-filter"><span className="sr-only">{label}</span><select aria-label={label} onChange={(event) => onChange(event.target.value)} value={value}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><i>⌄</i></label>;
}

function KnowledgeImportDialog({ activeSlug, locale, representatives, onClose, onCreated }: { activeSlug: string; locale: Locale; representatives: KnowledgeRepresentativeOption[]; onClose: () => void; onCreated: (asset: KnowledgeAssetRecord) => void }) {
  const zh = locale === "zh";
  const [mode, setMode] = useState<ImportMode>("file");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("owner_only");
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [conflictPolicy, setConflictPolicy] = useState<UploadConflictPolicy>("skip_duplicates");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isUploading = queue.some((item) => item.status === "uploading");
  const queueProgress = queue.length
    ? Math.round(queue.reduce((total, item) => total + item.progress, 0) / queue.length)
    : 0;
  const queuedCount = queue.filter((item) => item.status === "queued").length;
  const failedCount = queue.filter((item) => item.status === "failed").length;
  const completedCount = queue.filter((item) => item.status === "completed" || item.status === "skipped").length;
  const closeDialog = useCallback(() => {
    if (!submitting && !isUploading) onClose();
  }, [isUploading, onClose, submitting]);
  useModalBehavior(closeDialog, ".knowledge-import-dialog");

  function updateQueueItem(itemId: string, patch: Partial<Omit<UploadQueueItem, "id" | "file">>) {
    setQueue((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
  }

  function addFiles(selectedFiles: File[]) {
    setError(null);
    const rejected: string[] = [];
    setQueue((current) => {
      const next = [...current];
      for (const selectedFile of selectedFiles) {
        if (next.length >= MAX_BATCH_FILES) {
          rejected.push(zh ? `单次最多上传 ${MAX_BATCH_FILES} 个文件。` : `Up to ${MAX_BATCH_FILES} files per batch.`);
          break;
        }
        const validationError = validateUploadFile(selectedFile, zh);
        if (validationError) {
          rejected.push(`${selectedFile.name}: ${validationError}`);
          continue;
        }
        next.push({ id: crypto.randomUUID(), file: selectedFile, status: "queued", progress: 0 });
      }
      return next;
    });
    if (rejected.length) setError(rejected.slice(0, 3).join("\n"));
  }

  async function watchProcessing(itemId: string, assetId: string) {
    let transientFailures = 0;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await waitFor(1_200);
      try {
        const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets/${assetId}`, { cache: "no-store" });
        const { asset } = await readResponse<{ asset: KnowledgeAssetRecord }>(response);
        transientFailures = 0;
        onCreated(asset);
        if (asset.status === "ready") {
          updateQueueItem(itemId, { status: "completed", progress: 100, assetId, message: zh ? "上传和索引均已完成" : "Uploaded and indexed" });
          return;
        }
        if (asset.status === "failed") {
          updateQueueItem(itemId, { status: "failed", progress: 100, assetId, message: asset.processingError ?? (zh ? "知识处理失败" : "Knowledge processing failed") });
          return;
        }
        updateQueueItem(itemId, { status: "processing", progress: Math.min(96, 82 + Math.floor(attempt / 8)), assetId, message: zh ? "正在解析并写入向量索引" : "Parsing and indexing" });
      } catch (pollError) {
        transientFailures += 1;
        if (transientFailures >= 4) {
          updateQueueItem(itemId, { status: "failed", progress: 100, assetId, message: messageOf(pollError, zh ? "无法读取处理进度" : "Unable to read processing progress") });
          return;
        }
      }
    }
    updateQueueItem(itemId, { status: "failed", progress: 100, assetId, message: zh ? "处理超时，可稍后重试" : "Processing timed out; retry later" });
  }

  async function uploadQueueItem(item: UploadQueueItem, policy: UploadConflictPolicy) {
    updateQueueItem(item.id, { status: "uploading", progress: 1, message: zh ? "正在上传原始文件" : "Uploading source file" });
    const representativeLinks = linkedIds.map((representativeId) => ({ representativeId, usageMode: visibility === "public_material" ? "both" : "qa_source", reviewStatus: "approved", enabled: true, priority: 50 }));
    const form = new FormData();
    form.set("file", item.file);
    form.set("title", queue.length === 1 ? title.trim() : "");
    form.set("visibility", visibility);
    form.set("tags", JSON.stringify(parseTags(tags)));
    form.set("representativeLinks", JSON.stringify(representativeLinks));
    form.set("conflictPolicy", policy);
    try {
      const payload = await uploadKnowledgeFile(activeSlug, form, (progress) => {
        updateQueueItem(item.id, { status: "uploading", progress, message: zh ? `正在上传 ${progress}%` : `Uploading ${progress}%` });
      });
      onCreated(payload.asset);
      if (payload.upload.outcome === "skipped_duplicate") {
        updateQueueItem(item.id, { status: "skipped", progress: 100, assetId: payload.asset.id, message: zh ? "内容完全相同，已跳过" : "Identical content skipped" });
        return;
      }
      updateQueueItem(item.id, {
        status: "processing",
        progress: 82,
        assetId: payload.asset.id,
        message: payload.upload.outcome === "replaced"
          ? (zh ? "已覆盖源文件，正在重建索引" : "Source replaced; rebuilding index")
          : (zh ? "上传完成，正在处理知识" : "Upload complete; processing knowledge"),
      });
      void watchProcessing(item.id, payload.asset.id);
    } catch (uploadError) {
      updateQueueItem(item.id, { status: "failed", progress: 100, message: messageOf(uploadError, zh ? "上传失败" : "Upload failed") });
    }
  }

  async function runUploads(items: UploadQueueItem[], policy = conflictPolicy) {
    if (!items.length) return;
    setSubmitting(true);
    setError(null);
    try {
      await runWithConcurrency(items, UPLOAD_CONCURRENCY, (item) => uploadQueueItem(item, policy));
    } finally {
      setSubmitting(false);
    }
  }

  async function retryQueueItem(item: UploadQueueItem) {
    if (!item.assetId) {
      await runUploads([item]);
      return;
    }
    updateQueueItem(item.id, { status: "processing", progress: 82, message: zh ? "正在重新解析和索引" : "Reprocessing and indexing" });
    try {
      const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets/${item.assetId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reprocess" }),
      });
      const { asset } = await readResponse<{ asset: KnowledgeAssetRecord }>(response);
      onCreated(asset);
      void watchProcessing(item.id, item.assetId);
    } catch (retryError) {
      updateQueueItem(item.id, { status: "failed", progress: 100, message: messageOf(retryError, zh ? "重新处理失败" : "Reprocessing failed") });
    }
  }

  async function retryFailedItems() {
    const failedItems = queue.filter((item) => item.status === "failed");
    if (!failedItems.length) return;
    setSubmitting(true);
    setError(null);
    try {
      await runWithConcurrency(failedItems, UPLOAD_CONCURRENCY, retryQueueItem);
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "file") {
      if (!queue.length) {
        setError(zh ? "请选择至少一个知识文件。" : "Choose at least one knowledge file.");
        return;
      }
      await runUploads(queue.filter((item) => item.status === "queued"));
      return;
    }
    setSubmitting(true);
    setError(null);
    const representativeLinks = linkedIds.map((representativeId) => ({ representativeId, usageMode: visibility === "public_material" ? "both" : "qa_source", reviewStatus: "approved", enabled: true, priority: 50 }));
    try {
      const response = await knowledgeFetch(activeSlug, "/api/dashboard/knowledge-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: mode,
          title: title.trim(),
          visibility,
          tags: parseTags(tags),
          representativeLinks,
          ...(mode === "url" ? { sourceUrl: sourceUrl.trim() } : { sourceText: sourceText.trim() }),
        }),
      });
      const { asset } = await readResponse<{ asset: KnowledgeAssetRecord }>(response);
      onCreated(asset);
      onClose();
    } catch (submitError) {
      setError(messageOf(submitError, zh ? "导入失败。" : "Import failed."));
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="knowledge-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDialog(); }} role="presentation">
    <section aria-label={zh ? "导入知识" : "Import knowledge"} aria-modal="true" className="knowledge-import-dialog" role="dialog">
      <header><div><span>Knowledge Intake</span><h2>{zh ? "导入新的知识" : "Import new knowledge"}</h2><p>{zh ? "支持批量上传、进度跟踪和失败重试；导入后会自动提取正文、生成摘要与标签。" : "Batch upload with progress and retry; Delegate then extracts, summarizes, tags, and indexes every source."}</p></div><button aria-label={zh ? "关闭" : "Close"} disabled={submitting || isUploading} onClick={closeDialog} type="button">×</button></header>
      <nav className="knowledge-import-tabs">{(["file", "url", "text"] as ImportMode[]).map((item) => <button className={mode === item ? "is-active" : undefined} disabled={submitting || isUploading} key={item} onClick={() => setMode(item)} type="button"><span>{item === "file" ? "▤" : item === "url" ? "↗" : "Aa"}</span>{item === "file" ? (zh ? "上传文件" : "Upload files") : item === "url" ? (zh ? "导入网址" : "Import URL") : (zh ? "手工文本" : "Manual text")}</button>)}</nav>
      <form onSubmit={submit}>
        {mode === "file" ? <>
          <div className={`knowledge-dropzone${queue.length ? " has-file" : ""}`} onClick={() => { if (!submitting) fileRef.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!submitting) addFiles(Array.from(event.dataTransfer.files)); }}>
            <input accept=".pdf,.docx,.txt,.md,.markdown" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} ref={fileRef} type="file" />
            <span>{queue.length ? String(queue.length).padStart(2, "0") : "↑"}</span>
            <strong>{queue.length ? (zh ? `${queue.length} 个文件已加入上传队列` : `${queue.length} files in the upload queue`) : (zh ? "拖入多个文件，或点击选择" : "Drop files, or click to browse")}</strong>
            <small>{queue.length ? `${formatBytes(queue.reduce((total, item) => total + item.file.size, 0))} · ${zh ? `单批最多 ${MAX_BATCH_FILES} 个` : `${MAX_BATCH_FILES} files max per batch`}` : (zh ? "PDF、DOCX、TXT、Markdown · 单文件最大 15 MB" : "PDF, DOCX, TXT, Markdown · 15 MB per file")}</small>
          </div>
          <label className="knowledge-conflict-policy"><div><span>{zh ? "重复文件处理" : "Duplicate handling"}</span><small>{conflictPolicyDescription(conflictPolicy, zh)}</small></div><select disabled={submitting || isUploading} onChange={(event) => setConflictPolicy(event.target.value as UploadConflictPolicy)} value={conflictPolicy}><option value="skip_duplicates">{zh ? "跳过完全重复内容" : "Skip identical content"}</option><option value="keep_both">{zh ? "始终保留为新副本" : "Always keep a new copy"}</option><option value="replace_existing">{zh ? "覆盖已有文件" : "Replace existing file"}</option></select></label>
          {queue.length ? <section className="knowledge-upload-queue" aria-label={zh ? "上传队列" : "Upload queue"}>
            <header><div><span>{zh ? "上传队列" : "Upload queue"}</span><small>{completedCount}/{queue.length} {zh ? "已完成" : "complete"}{failedCount ? ` · ${failedCount} ${zh ? "失败" : "failed"}` : ""}</small></div><strong>{queueProgress}%</strong></header>
            <div className="knowledge-upload-overall"><i style={{ width: `${queueProgress}%` }} /></div>
            <div className="knowledge-upload-list">{queue.map((item) => <article className={`is-${item.status}`} key={item.id}>
              <span className="knowledge-upload-file-icon">{fileMark(uploadFileKind(item.file.name))}</span>
              <div className="knowledge-upload-item-main"><header><strong title={item.file.name}>{item.file.name}</strong><span>{uploadStatusLabel(item.status, zh)}</span></header><small>{formatBytes(item.file.size)}{item.message ? ` · ${item.message}` : ""}</small><div className="knowledge-upload-progress"><i style={{ width: `${item.progress}%` }} /></div></div>
              <div className="knowledge-upload-actions">
                {item.status === "failed" ? <button onClick={() => void retryQueueItem(item)} type="button">↻ {item.assetId ? (zh ? "重新处理" : "Reprocess") : (zh ? "重传" : "Retry")}</button> : null}
                {item.status === "skipped" ? <button onClick={() => void runUploads([item], "replace_existing")} type="button">↻ {zh ? "覆盖重传" : "Replace"}</button> : null}
                {!(["uploading", "processing"] as UploadQueueStatus[]).includes(item.status) ? <button aria-label={zh ? `移除 ${item.file.name}` : `Remove ${item.file.name}`} className="is-remove" onClick={() => setQueue((current) => current.filter((entry) => entry.id !== item.id))} type="button">×</button> : null}
              </div>
            </article>)}</div>
            {failedCount ? <button className="knowledge-retry-all" disabled={submitting} onClick={() => void retryFailedItems()} type="button">↻ {zh ? `重试 ${failedCount} 个失败项` : `Retry ${failedCount} failed item${failedCount === 1 ? "" : "s"}`}</button> : null}
          </section> : null}
        </> : mode === "url" ? <label className="knowledge-form-field"><span>{zh ? "公开网址" : "Public URL"}<b>*</b></span><input onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/about" required type="url" value={sourceUrl} /><small>{zh ? "只支持可公开访问的 HTTP/HTTPS 页面，不会访问内网地址。" : "Public HTTP/HTTPS pages only. Private network addresses are blocked."}</small></label> : <label className="knowledge-form-field"><span>{zh ? "知识正文" : "Knowledge text"}<b>*</b></span><textarea minLength={20} onChange={(event) => setSourceText(event.target.value)} placeholder={zh ? "粘贴 FAQ、服务说明、政策、品牌信息或其他可复用知识…" : "Paste FAQs, service guidance, policies, brand context, or other reusable knowledge…"} required rows={8} value={sourceText} /><small>{sourceText.length.toLocaleString()} / 400,000</small></label>}
        <div className="knowledge-form-grid"><label className="knowledge-form-field"><span>{zh ? "知识标题" : "Title"}{mode !== "file" ? <b>*</b> : null}</span><input disabled={mode === "file" && queue.length > 1} maxLength={180} onChange={(event) => setTitle(event.target.value)} placeholder={mode === "file" ? (queue.length > 1 ? (zh ? "批量上传使用各自文件名" : "Batch uploads use each filename") : (zh ? "不填则使用文件名" : "Defaults to filename")) : (zh ? "例如：产品与服务 FAQ" : "e.g. Product and service FAQ")} required={mode !== "file"} value={title} />{mode === "file" && queue.length > 1 ? <small>{zh ? "批量上传时，每条知识自动使用对应文件名。" : "Each batch item uses its own filename as the title."}</small> : null}</label><label className="knowledge-form-field"><span>{zh ? "手工标签" : "Tags"}</span><input onChange={(event) => setTags(event.target.value)} placeholder={zh ? "产品, FAQ, 价格" : "Product, FAQ, pricing"} value={tags} /><small>{zh ? "用逗号分隔，最多 20 个" : "Comma separated, up to 20"}</small></label></div>
        <fieldset className="knowledge-visibility-options"><legend>{zh ? "可见范围" : "Visibility"}<b>*</b></legend>{visibilityOptions.map((option) => <label className={visibility === option.value ? "is-selected" : undefined} key={option.value}><input checked={visibility === option.value} name="visibility" onChange={() => setVisibility(option.value)} type="radio" /><span>{visibilityIcon(option.value)}</span><div><strong>{zh ? option.zh : option.en}</strong><small>{zh ? option.detailZh : option.detailEn}</small></div><i /></label>)}</fieldset>
        {(visibility === "selected_representatives" || visibility === "public_material") ? <fieldset className="knowledge-representative-picker"><legend>{zh ? "关联对外代理" : "Linked representatives"}{visibility === "selected_representatives" ? <b>*</b> : null}</legend>{representatives.map((representative) => <label key={representative.id}><input checked={linkedIds.includes(representative.id)} onChange={(event) => setLinkedIds((current) => event.target.checked ? [...current, representative.id] : current.filter((id) => id !== representative.id))} type="checkbox" /><span>{representative.name.slice(0, 1)}</span><div><strong>{representative.name}</strong><small>/{representative.slug}</small></div></label>)}{!representatives.length ? <p>{zh ? "当前工作区还没有可关联的代表。" : "No representatives are available in this workspace."}</p> : null}</fieldset> : null}
        {error ? <div className="knowledge-form-error">! {error}</div> : null}
        <footer><button disabled={submitting || isUploading} onClick={closeDialog} type="button">{mode === "file" && completedCount ? (zh ? "完成" : "Done") : (zh ? "取消" : "Cancel")}</button><button className="is-primary" disabled={submitting || (mode === "file" && !queuedCount) || (visibility === "selected_representatives" && !linkedIds.length)} type="submit">{submitting ? <><i className="knowledge-spinner" />{zh ? "正在上传…" : "Uploading…"}</> : mode === "file" ? <>{zh ? `上传队列${queuedCount ? ` (${queuedCount})` : ""}` : `Upload queue${queuedCount ? ` (${queuedCount})` : ""}`}<span>→</span></> : <>{zh ? "开始处理" : "Start processing"}<span>→</span></>}</button></footer>
      </form>
    </section>
  </div>;
}

function KnowledgeDetailDrawer({ activeSlug, asset, locale, representatives, onClose, onUpdated, onAction, onDelete }: { activeSlug: string; asset: KnowledgeAssetRecord; locale: Locale; representatives: KnowledgeRepresentativeOption[]; onClose: () => void; onUpdated: (asset: KnowledgeAssetRecord) => void; onAction: (id: string, action: "reprocess" | "archive" | "restore") => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  useModalBehavior(onClose, ".knowledge-detail-drawer");
  const zh = locale === "zh";
  const [tab, setTab] = useState<"overview" | "content" | "access" | "logs">("overview");
  const [title, setTitle] = useState(asset.title);
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [visibility, setVisibility] = useState<Visibility>(asset.visibility);
  const [linkedIds, setLinkedIds] = useState(asset.representativeLinks.map((link) => link.representativeId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setTitle(asset.title); setTags(asset.tags.join(", ")); setVisibility(asset.visibility); setLinkedIds(asset.representativeLinks.map((link) => link.representativeId)); }, [asset]);

  async function saveAccess() {
    setSaving(true); setError(null);
    try {
      const response = await knowledgeFetch(activeSlug, `/api/dashboard/knowledge-assets/${asset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, tags: parseTags(tags), visibility, representativeLinks: linkedIds.map((representativeId) => { const current = asset.representativeLinks.find((link) => link.representativeId === representativeId); return { representativeId, usageMode: current?.usageMode ?? (visibility === "public_material" ? "both" : "qa_source"), reviewStatus: current?.reviewStatus ?? "approved", enabled: true, priority: current?.priority ?? 50 }; }) }) });
      const { asset: updated } = await readResponse<{ asset: KnowledgeAssetRecord }>(response);
      onUpdated(updated);
    } catch (saveError) { setError(messageOf(saveError, zh ? "保存失败。" : "Save failed.")); } finally { setSaving(false); }
  }

  return <div className="knowledge-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }} role="presentation"><aside aria-label={zh ? "知识详情" : "Knowledge details"} aria-modal="true" className="knowledge-detail-drawer" role="dialog">
    <header><div className={`knowledge-detail-icon is-${asset.kind}`}>{fileMark(asset.kind)}</div><div><span>{kindLabel(asset.kind)} · {asset.originalFileName ?? (asset.kind === "url" ? "URL" : (zh ? "手工文本" : "Manual text"))}</span><h2>{asset.title}</h2><StatusBadge status={asset.status} zh={zh} /></div><button aria-label={zh ? "关闭" : "Close"} onClick={onClose} type="button">×</button></header>
    <nav>{(["overview", "content", "access", "logs"] as const).map((item) => <button className={tab === item ? "is-active" : undefined} key={item} onClick={() => setTab(item)} type="button">{item === "overview" ? (zh ? "概览" : "Overview") : item === "content" ? (zh ? "提取正文" : "Extracted text") : item === "access" ? (zh ? "权限与代表" : "Access & reps") : (zh ? "处理日志" : "Processing logs")}{item === "logs" ? <span>{asset.processingLogs.length}</span> : null}</button>)}</nav>
    <div className="knowledge-detail-body">
      {tab === "overview" ? <><section className="knowledge-summary-card"><span>{zh ? "自动摘要" : "Generated summary"}</span><p>{asset.summary ?? (zh ? "处理完成后会在这里生成摘要。" : "A summary will appear after processing.")}</p></section>{asset.processingError ? <div className="knowledge-processing-error"><strong>{zh ? "处理失败" : "Processing failed"}</strong><p>{asset.processingError}</p><button onClick={() => void onAction(asset.id, "reprocess")} type="button">↻ {zh ? "重新处理" : "Reprocess"}</button></div> : null}<DetailFacts asset={asset} locale={locale} /><section className="knowledge-tag-section"><div><span>{zh ? "手工标签" : "Manual tags"}</span>{asset.tags.length ? asset.tags.map((tag) => <em key={tag}>{tag}</em>) : <small>{zh ? "暂无" : "None"}</small>}</div><div><span>{zh ? "自动标签" : "Generated tags"}</span>{asset.autoTags.length ? asset.autoTags.map((tag) => <em className="is-auto" key={tag}>✦ {tag}</em>) : <small>{zh ? "暂无" : "None"}</small>}</div></section><section className="knowledge-linked-summary"><div><span>{zh ? "正在使用这条知识" : "Representatives using this"}</span><strong>{asset.representativeLinks.filter((link) => link.enabled).length}</strong></div><RepresentativeStack links={asset.representativeLinks} zh={zh} /><button onClick={() => setTab("access")} type="button">{zh ? "管理权限" : "Manage access"} →</button></section></> : null}
      {tab === "content" ? <section className="knowledge-extracted"><header><div><span>{zh ? "规范化正文" : "Normalized content"}</span><small>{(asset.extractedText?.length ?? 0).toLocaleString()} {zh ? "字符" : "characters"}</small></div>{asset.sourceUrl ? <a href={asset.sourceUrl} rel="noreferrer" target="_blank">{zh ? "打开来源" : "Open source"} ↗</a> : null}</header><pre>{asset.extractedText ?? (zh ? "暂无可显示的正文。" : "No extracted content available.")}</pre><footer><span>SHA-256</span><code>{asset.checksum ?? "—"}</code></footer></section> : null}
      {tab === "access" ? <div className="knowledge-access-editor"><label className="knowledge-form-field"><span>{zh ? "知识标题" : "Title"}</span><input maxLength={180} onChange={(event) => setTitle(event.target.value)} value={title} /></label><label className="knowledge-form-field"><span>{zh ? "手工标签" : "Manual tags"}</span><input onChange={(event) => setTags(event.target.value)} value={tags} /></label><fieldset className="knowledge-visibility-options is-compact"><legend>{zh ? "可见范围" : "Visibility"}</legend>{visibilityOptions.map((option) => <label className={visibility === option.value ? "is-selected" : undefined} key={option.value}><input checked={visibility === option.value} name="detail-visibility" onChange={() => setVisibility(option.value)} type="radio" /><span>{visibilityIcon(option.value)}</span><div><strong>{zh ? option.zh : option.en}</strong><small>{zh ? option.detailZh : option.detailEn}</small></div><i /></label>)}</fieldset><fieldset className="knowledge-representative-picker"><legend>{zh ? "关联代表" : "Linked representatives"}</legend>{representatives.map((representative) => <label key={representative.id}><input checked={linkedIds.includes(representative.id)} onChange={(event) => setLinkedIds((current) => event.target.checked ? [...current, representative.id] : current.filter((id) => id !== representative.id))} type="checkbox" /><span>{representative.name.slice(0, 1)}</span><div><strong>{representative.name}</strong><small>/{representative.slug}</small></div></label>)}</fieldset>{error ? <div className="knowledge-form-error">! {error}</div> : null}<button className="knowledge-save-button" disabled={saving || (visibility === "selected_representatives" && !linkedIds.length)} onClick={() => void saveAccess()} type="button">{saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "保存配置" : "Save configuration")}</button></div> : null}
      {tab === "logs" ? <section className="knowledge-log-list">{asset.processingLogs.length ? asset.processingLogs.map((log) => <article className={`is-${log.level}`} key={log.id}><i /><div><header><strong>{log.stage}</strong><time>{formatDateTime(log.createdAt, locale)}</time></header><p>{log.message}</p></div></article>) : <p>{zh ? "暂无处理日志。" : "No processing logs."}</p>}</section> : null}
    </div>
    <footer className="knowledge-detail-actions"><div>{asset.status === "archived" ? <><button onClick={() => void onAction(asset.id, "restore")} type="button">↻ {zh ? "恢复" : "Restore"}</button><button className="is-danger" onClick={() => void onDelete(asset.id)} type="button">{zh ? "永久删除" : "Delete forever"}</button></> : <button onClick={() => void onAction(asset.id, "archive")} type="button">⌑ {zh ? "归档" : "Archive"}</button>}</div><button onClick={() => void onAction(asset.id, "reprocess")} type="button">↻ {zh ? "重新处理" : "Reprocess"}</button></footer>
  </aside></div>;
}

function DetailFacts({ asset, locale }: { asset: KnowledgeAssetRecord; locale: Locale }) { const zh = locale === "zh"; const facts = [[zh ? "来源类型" : "Source type", kindLabel(asset.kind)], [zh ? "文件大小" : "File size", asset.sizeBytes ? formatBytes(asset.sizeBytes) : "—"], [zh ? "处理版本" : "Processing version", `v${asset.processingVersion}`], [zh ? "最近处理" : "Last processed", asset.processedAt ? formatDate(asset.processedAt, locale) : "—"], [zh ? "创建时间" : "Created", formatDate(asset.createdAt, locale)], [zh ? "可见范围" : "Visibility", visibilityLabel(asset.visibility, zh)]]; return <section className="knowledge-detail-facts">{facts.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>; }
function StatusBadge({ status, zh }: { status: KnowledgeAssetRecord["status"]; zh: boolean }) { const labels = { ready: zh ? "已完成" : "Ready", processing: zh ? "处理中" : "Processing", failed: zh ? "异常" : "Failed", archived: zh ? "已归档" : "Archived" }; return <span className={`knowledge-status is-${status}`}><i />{labels[status]}</span>; }
function RepresentativeStack({ links, zh }: { links: KnowledgeAssetRecord["representativeLinks"]; zh: boolean }) { const enabled = links.filter((link) => link.enabled); return enabled.length ? <div className="knowledge-rep-stack" title={enabled.map((link) => link.representativeName).join(", ")}>{enabled.slice(0, 3).map((link) => <span key={link.representativeId}>{link.representativeName.slice(0, 1)}</span>)}{enabled.length > 3 ? <b>+{enabled.length - 3}</b> : null}<small>{enabled.length}</small></div> : <span className="knowledge-unlinked">{zh ? "未关联" : "Not linked"}</span>; }
function LoadingRows() { return <>{[0, 1, 2].map((item) => <tr className="knowledge-loading-row" key={item}><td colSpan={7}><span /></td></tr>)}</>; }
function EmptyState({ zh, hasFilters, onImport }: { zh: boolean; hasFilters: boolean; onImport: () => void }) { return <div className="knowledge-empty"><span>{hasFilters ? "⌕" : "＋"}</span><strong>{hasFilters ? (zh ? "没有匹配的知识" : "No matching knowledge") : (zh ? "从第一份知识开始" : "Start with your first knowledge asset")}</strong><p>{hasFilters ? (zh ? "调整搜索词或筛选条件后再试。" : "Try changing your search or filters.") : (zh ? "上传文件、导入公开网页，或直接粘贴知识正文。" : "Upload a file, import a public webpage, or paste authored knowledge.")}</p>{!hasFilters ? <button onClick={onImport} type="button">{zh ? "导入知识" : "Import knowledge"}</button> : null}</div>; }
function fileMark(kind: KnowledgeAssetRecord["kind"]) { return kind === "pdf" ? "PDF" : kind === "docx" ? "W" : kind === "url" ? "↗" : kind === "markdown" ? "MD" : kind === "text" ? "Aa" : "TXT"; }
function kindLabel(kind: KnowledgeAssetRecord["kind"]) { return kind === "markdown" ? "MD" : kind === "text" ? "TEXT" : kind.toUpperCase(); }
function visibilityIcon(value: Visibility) { return value === "owner_only" ? "●" : value === "organization_shared" ? "◫" : value === "selected_representatives" ? "◉" : "◎"; }
function visibilityLabel(value: Visibility, zh: boolean) { const option = visibilityOptions.find((item) => item.value === value)!; return zh ? option.zh : option.en; }
function parseTags(value: string) { return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20); }
function uploadFileKind(fileName: string): KnowledgeAssetRecord["kind"] { const extension = fileName.split(".").pop()?.toLowerCase(); return extension === "pdf" ? "pdf" : extension === "docx" ? "docx" : extension === "md" || extension === "markdown" ? "markdown" : "txt"; }
function validateUploadFile(file: File, zh: boolean) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!extension || !["pdf", "docx", "txt", "md", "markdown"].includes(extension)) return zh ? "不支持该文件类型" : "Unsupported file type";
  if (!file.size) return zh ? "文件内容为空" : "The file is empty";
  if (file.size > MAX_FILE_BYTES) return zh ? "文件超过 15 MB" : "File exceeds 15 MB";
  return null;
}
function uploadStatusLabel(status: UploadQueueStatus, zh: boolean) {
  const labels: Record<UploadQueueStatus, [string, string]> = {
    queued: ["等待上传", "Queued"],
    uploading: ["上传中", "Uploading"],
    processing: ["解析索引中", "Indexing"],
    completed: ["已完成", "Complete"],
    skipped: ["已跳过", "Skipped"],
    failed: ["失败", "Failed"],
  };
  return labels[status][zh ? 0 : 1];
}
function conflictPolicyDescription(policy: UploadConflictPolicy, zh: boolean) {
  if (policy === "replace_existing") return zh ? "覆盖同内容或同名知识；保留已有标题、标签和权限，并重建向量索引。" : "Replaces identical or same-name sources, retains existing title, tags, and access, then rebuilds the index.";
  if (policy === "keep_both") return zh ? "即使内容或名称相同，也创建带序号的新知识。" : "Always creates a numbered copy, even when content or names match.";
  return zh ? "完全相同的内容不重复存储；同名但内容不同会保留为新副本。" : "Identical content is not stored twice; same-name files with different content become copies.";
}
function uploadKnowledgeFile(activeSlug: string, form: FormData, onProgress: (progress: number) => void): Promise<FileUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/dashboard/knowledge-assets");
    request.setRequestHeader("X-Delegate-Representative", activeSlug);
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.max(1, Math.min(78, Math.round((event.loaded / event.total) * 78))));
    });
    request.addEventListener("load", () => {
      let payload: (FileUploadResponse & { error?: string }) | null = null;
      try {
        payload = JSON.parse(request.responseText) as FileUploadResponse & { error?: string };
      } catch {
        reject(new Error(`Request failed (${request.status || 0})`));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(payload.error || `Request failed (${request.status})`));
        return;
      }
      onProgress(80);
      resolve(payload);
    });
    request.addEventListener("error", () => reject(new Error("Network error while uploading file")));
    request.addEventListener("abort", () => reject(new Error("File upload was cancelled")));
    request.send(form);
  });
}
async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}
function waitFor(milliseconds: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatDate(value: string, locale: Locale) { return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value: string, locale: Locale) { return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function messageOf(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
async function readResponse<T = unknown>(response: Response): Promise<T> { const payload = await response.json().catch(() => ({})) as T & { error?: string }; if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`); return payload; }
function knowledgeFetch(activeSlug: string, input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Delegate-Representative", activeSlug);
  return fetch(input, { ...init, headers });
}
function useModalBehavior(onClose: () => void, selector: string) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backgroundRegions = [...document.querySelectorAll<HTMLElement>(".dashboard-v2-sidebar, .dashboard-v2-topbar")].map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const region of backgroundRegions) {
      region.element.inert = true;
      region.element.setAttribute("aria-hidden", "true");
    }
    const firstButton = document.querySelector<HTMLElement>(`${selector} button`);
    firstButton?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const region of backgroundRegions) {
        region.element.inert = region.inert;
        if (region.ariaHidden === null) region.element.removeAttribute("aria-hidden");
        else region.element.setAttribute("aria-hidden", region.ariaHidden);
      }
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, selector]);
}
