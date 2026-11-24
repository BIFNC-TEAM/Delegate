"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  boundaryLabels,
  boundaryPresets,
  knowledgeSettingsSchema,
  normalizeFaqQuestion,
  type KnowledgeSettings,
} from "@delegate/domain/representative-knowledge-settings";
import {
  KNOWLEDGE_FILE_BYTES,
  KNOWLEDGE_TEXT_CHARACTERS,
  requiresKnowledgeSourceChange,
} from "@delegate/domain/knowledge-limits";
import {
  WorkbenchIcon as Icon,
  WorkbenchPanelHeading,
} from "./representative-workbench";
import { uploadKnowledgeFile } from "./knowledge-file-upload";
import "./representative-knowledge-rules.css";
import { RepresentativeBoundaryExample } from "./representative-boundary-example";

type Faq = {
  id: string;
  title: string;
  summary: string;
  kind:
    | "faq"
    | "bio"
    | "policy"
    | "pricing"
    | "case_study"
    | "deck"
    | "calendar"
    | "download";
  url?: string | undefined;
};
type Asset = {
  id: string;
  title: string;
  originalFileName: string | null;
  status: string;
  kind: string;
  processingError?: string | null;
  sizeBytes?: number | null;
};
type Candidate = Faq & { selected: boolean; source: string };
type Props = {
  representativeSlug: string;
  name: string;
  description: string;
  initialSetup: boolean;
  settings: KnowledgeSettings;
  faq: Faq[];
  handoffPrompt: string;
  hours: number;
  onChange: (patch: {
    knowledgeSettings?: KnowledgeSettings;
    faq?: Faq[];
    handoffPrompt?: string;
    hours?: number;
  }) => void;
  onBusy: (busy: boolean) => void;
  onSkip: () => void;
};
const statusLabels: Record<string, string> = {
  ready: "可用",
  processing: "解析中",
  failed: "解析失败",
  archived: "已归档",
};
function Panel({
  title,
  icon,
  children,
  subtitle,
  action,
}: {
  title: string;
  icon: string;
  children: ReactNode;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <section className="d-panel">
      <header className="d-panel-head">
        <div>
          <WorkbenchPanelHeading icon={icon} title={title} description="" />
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="d-panel-body">{children}</div>
    </section>
  );
}
function Modal({
  title,
  children,
  footer,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="d-modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="d-modal-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="d-button d-ghost"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="d-modal-body">{children}</div>
      <footer className="d-modal-footer">{footer}</footer>
    </dialog>
  );
}
export function RepresentativeKnowledgeRules(p: Props) {
  const [tab, setTab] = useState("files"),
    [modal, setModal] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [picker, setPicker] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [uploadNote, setUploadNote] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]),
    [note, setNote] = useState("");
  const [sources, setSources] = useState<string[]>([]),
    [includeIntro, setIncludeIntro] = useState(true);
  const [rules, setRules] = useState(p.settings.boundaries);
  const [editing, setEditing] = useState<Faq | null>(null);
  const mounted = useRef(true),
    autoStarted = useRef(false),
    activeRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    faqInput = useRef<HTMLInputElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const linked = p.settings.files.map(
    (f) =>
      assets.find((a) => a.id === f.id) ?? {
        id: f.id,
        title: "文件不可用",
        originalFileName: null,
        status: "unavailable",
        kind: "",
      },
  );
  const ready = linked.filter((a) => a.status === "ready");
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      try {
        const r = await fetch(
          `/api/dashboard/representatives/${encodeURIComponent(p.representativeSlug)}/knowledge-assets`,
          { signal: controller.signal },
        );
        const body = await r.json();
        if (!r.ok) throw Error(body.error || "读取知识库失败");
        if (!stopped) {
          setAssets(body.assets.filter((a: Asset) => a.status !== "archived"));
          setLoading(false);
        }
      } catch (e) {
        if (!stopped) {
          setError(e instanceof Error ? e.message : "读取知识库失败");
          setLoading(false);
        }
      }
      if (!stopped) timer = setTimeout(load, 5000);
    }
    void load();
    return () => {
      stopped = true;
      mounted.current = false;
      controller.abort();
      activeRequest.current?.abort();
      clearTimeout(timer);
    };
  }, [p.representativeSlug]);
  function changeSettings(patch: Partial<KnowledgeSettings>) {
    p.onChange({ knowledgeSettings: { ...p.settings, ...patch } });
  }
  function activity(value: boolean) {
    setBusy(value);
    p.onBusy(value);
  }
  function close() {
    if (!busy) {
      setModal(null);
      setError("");
    }
  }
  function openPicker() {
    setPicker(p.settings.files.map((f) => f.id));
    setModal("library");
    setError("");
  }
  async function upload(files: File[]) {
    if (busy) return;
    if (files.length > 20) {
      setError("每批最多上传20个文件。");
      return;
    }
    activity(true);
    setError("");
    const uploaded: Asset[] = [];
    const failures: string[] = [];
    for (const file of files) {
      if (
        file.size > KNOWLEDGE_FILE_BYTES ||
        !/\.(pdf|docx|txt|md|markdown)$/i.test(file.name)
      ) {
        failures.push(
          `${file.name}：支持 PDF、DOCX、TXT、Markdown，单个不超过150MB。`,
        );
        continue;
      }
      const form = new FormData();
      form.set("file", file);
      form.set("visibility", "owner_only");
      form.set("tags", "[]");
      form.set("representativeLinks", "[]");
      form.set("conflictPolicy", "skip_duplicates");
      try {
        const result = await uploadKnowledgeFile(
          p.representativeSlug,
          form,
          (progress) => {
            if (mounted.current)
              setUploadNote(`${file.name} · 正在上传 ${progress}%`);
          },
        );
        uploaded.push(result.asset);
        if (mounted.current)
          setAssets((old) => [
            result.asset,
            ...old.filter((a) => a.id !== result.asset.id),
          ]);
      } catch (e) {
        failures.push(
          `${file.name}：${e instanceof Error ? e.message : "上传失败，请重新选择。"}`,
        );
      }
    }
    if (!mounted.current) return;
    const current = latest.current.settings;
    p.onChange({
      knowledgeSettings: {
        ...current,
        files: [
          ...current.files,
          ...uploaded
            .filter((a) => !current.files.some((f) => f.id === a.id))
            .map((a) => ({ id: a.id, allowDownload: false })),
        ],
      },
    });
    setPicker((old) => [...new Set([...old, ...uploaded.map((a) => a.id)])]);
    setUploadNote(
      uploaded.length ? `已上传 ${uploaded.length} 份文件，后台继续解析。` : "",
    );
    setError(failures.join("\n"));
    activity(false);
  }
  async function retry(asset: Asset) {
    if (busy) return;
    activity(true);
    setError("");
    try {
      const r = await fetch(
        `/api/dashboard/knowledge-assets/${asset.id}/actions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Delegate-Representative": p.representativeSlug,
          },
          body: JSON.stringify({ action: "reprocess" }),
        },
      );
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "重试失败");
      setAssets((old) =>
        old.map((a) =>
          a.id === asset.id ? { ...a, status: "processing" } : a,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      activity(false);
    }
  }
  async function generate(ids: string[], intro: boolean, review: boolean) {
    if (busy) return;
    if (!ids.length && !intro) {
      setError("请至少选择一项信息来源。");
      return;
    }
    activity(true);
    setError("");
    setNote("");
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const r = await fetch("/api/dashboard/faq-suggestions", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds: ids.slice(0, 5),
          count: 3,
          ...(intro
            ? { representative: { name: p.name, description: p.description } }
            : {}),
        }),
      });
      const body = await r.json();
      if (!r.ok)
        throw Error(
          r.status === 401
            ? "请先登录后生成常见问题。"
            : body.error || "生成失败，请重试。",
        );
      const seen = new Set(
        latest.current.faq.map((q) => normalizeFaqQuestion(q.title)),
      );
      const rows: Candidate[] = [];
      for (const item of body.suggestions ?? []) {
        const key = normalizeFaqQuestion(item.question);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          id: crypto.randomUUID(),
          kind: "faq",
          title: item.question,
          summary: item.answer,
          source: (item.sourceIds ?? [])
            .map((id: string) =>
              id === "representative"
                ? "基本信息"
                : assets.find((a) => a.id === id)?.title || "所选资料",
            )
            .join("、"),
          selected: true,
        });
      }
      if (!mounted.current) return;
      setCandidates(rows);
      setNote(
        body.status === "partial_success" || body.status === "failed"
          ? "部分资料未能生成建议，可检查已生成内容或稍后重试。"
          : !rows.length
            ? "没有新的可用建议。可以调整来源或补充资料后重试。"
            : "请核对答案与来源，确认后再采用。每次最多参考5份资料，每份前2000字。",
      );
      if (review) setModal("review");
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error && e.name === "AbortError"
            ? "生成超时，请稍后重试。"
            : e instanceof Error
              ? e.message
              : "生成失败",
        );
    } finally {
      clearTimeout(timeout);
      if (mounted.current) activity(false);
    }
  }
  useEffect(() => {
    if (tab === "faq" && !loading && !autoStarted.current && !p.faq.length) {
      autoStarted.current = true;
      void generate(
        ready.slice(0, 5).map((a) => a.id),
        Boolean(p.description.trim()),
        false,
      );
    }
  }, [tab, loading]); // One automatic preparation per mounted representative, never re-run on edits.
  function adopt() {
    const selected = candidates.filter((q) => q.selected);
    const seen = new Set(p.faq.map((q) => normalizeFaqQuestion(q.title)));
    const accepted: Faq[] = [];
    let duplicates = 0;
    for (const q of selected) {
      if (
        !q.title.trim() ||
        !q.summary.trim() ||
        Array.from(q.title).length > 100 ||
        Array.from(q.summary).length > 2000
      ) {
        setError("请补齐问题和答案，问题最多100字、答案最多2000字。");
        return;
      }
      const key = normalizeFaqQuestion(q.title);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      accepted.push({
        id: q.id,
        kind: "faq",
        title: q.title.trim(),
        summary: q.summary.trim(),
      });
    }
    p.onChange({
      faq: [...p.faq, ...accepted],
      knowledgeSettings: {
        ...p.settings,
        faqSources: {
          ...p.settings.faqSources,
          ...Object.fromEntries(
            accepted.map((q) => [
              q.id,
              candidates.find((c) => c.id === q.id)?.source.slice(0, 600) ||
                "手动添加",
            ]),
          ),
        },
      },
    });
    setCandidates([]);
    setModal(null);
    setNote(
      `已加入 ${accepted.length} 条问答${duplicates ? `，跳过 ${duplicates} 条重复问题` : ""}，保存草稿后保留。`,
    );
    setError("");
  }
  function saveEdit() {
    if (!editing) return;
    if (
      !editing.title.trim() ||
      !editing.summary.trim() ||
      Array.from(editing.title).length > 100 ||
      Array.from(editing.summary).length > 2000
    ) {
      setError("请填写问题和答案，问题最多100字、答案最多2000字。");
      return;
    }
    if (editing.url && !/^https?:\/\//i.test(editing.url)) {
      setError("参考链接需以 http:// 或 https:// 开头。");
      return;
    }
    if (
      p.faq.some(
        (q) =>
          q.id !== editing.id &&
          normalizeFaqQuestion(q.title) === normalizeFaqQuestion(editing.title),
      )
    ) {
      setError("已有相同问题，请编辑原问答，避免重复添加。");
      return;
    }
    p.onChange({
      faq: p.faq.some((q) => q.id === editing.id)
        ? p.faq.map((q) => (q.id === editing.id ? editing : q))
        : [...p.faq, editing],
    });
    setModal(null);
    setError("");
  }
  async function importFaq(file: File) {
    if (file.size > KNOWLEDGE_FILE_BYTES) {
      setError("文件超过150MB，请拆分后导入。");
      return;
    }
    if (!/\.(txt|md|markdown)$/i.test(file.name)) {
      setError(
        "问答文档目前支持TXT和Markdown；PDF、Word的问答整理接口尚未接入。",
      );
      return;
    }
    const text = await file.text();
    if (text.length > KNOWLEDGE_TEXT_CHARACTERS) {
      setError("正文超过200万字符，请拆分后导入。");
      return;
    }
    const rows: Candidate[] = [];
    const pattern =
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:Q|问|问题)\s*[:：]\s*([^\n]+)\n\s*(?:A|答|答案)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:Q|问|问题)\s*[:：]|$)/gi;
    for (const m of text.matchAll(pattern)) {
      rows.push({
        id: crypto.randomUUID(),
        kind: "faq",
        title: m[1]!.trim(),
        summary: m[2]!.trim(),
        source: file.name,
        selected: true,
      });
      if (rows.length >= 50) break;
    }
    if (!rows.length) {
      setError(
        "未识别到问答，请按“问：… 换行 答：…”或“Q: … 换行 A: …”整理文件。",
      );
      return;
    }
    setCandidates(rows);
    setNote("从文档读取问答，请检查后采用；每批最多50条。");
    setModal("review");
  }
  const errorNode = error ? (
    <p className="d-error" role="alert" style={{ whiteSpace: "pre-wrap" }}>
      {error}
    </p>
  ) : null;
  return (
    <div className="d-knowledge-rules">
      <nav className="d-answer-tabs" role="tablist" aria-label="知识与规则内容">
        {[
          ["files", "folder", "知识文件", `${linked.length} 份`],
          ["faq", "inbox", "常见问题", `${p.faq.length} 条`],
          ["boundaries", "shield", "服务边界", "按场景设置"],
        ].map(([key, icon, label, count]) => (
          <button
            type="button"
            role="tab"
            key={key}
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            disabled={busy}
            onClick={() => setTab(key!)}
          >
            <Icon name={icon!} />
            <span>
              {label}
              <small>{count}</small>
            </span>
          </button>
        ))}
      </nav>
      {!modal && errorNode}
      <div
        role="tabpanel"
        aria-label={
          tab === "files" ? "知识文件" : tab === "faq" ? "常见问题" : "服务边界"
        }
      >
        {tab === "files" && (
          <Panel title="知识文件" icon="knowledge">
            <div
              className={`d-kb-library-entry ${linked.length ? "compact" : ""}`}
            >
              <span className="d-kb-drop-icon">
                <Icon name="folder" />
              </span>
              <div>
                <h3>{linked.length ? "继续关联资料" : "关联知识库文件"}</h3>
                <p>选择资料，供当前对外代理提供服务时参考。</p>
              </div>
              <div className="d-kb-main-actions">
                <button
                  type="button"
                  className="d-button d-primary"
                  onClick={openPicker}
                >
                  从知识库选择
                </button>
              </div>
            </div>
            {!!linked.length && (
              <>
                <div className="d-kb-list-heading">
                  <h3>
                    已关联文件 <span>{linked.length}</span>
                  </h3>
                  <small>下载权限仅适用于当前对外代理</small>
                </div>
                <div className="d-kb-file-list">
                  {linked.map((a) => (
                    <div key={a.id} className="d-kb-file-row">
                      <span className="d-kb-file-icon">
                        <Icon name="file" />
                      </span>
                      <div className="d-kb-file-info">
                        <strong>{a.originalFileName || a.title}</strong>
                        <span>
                          {a.status === "ready" ? "已保存到知识库" : ""}
                        </span>
                        {a.processingError && (
                          <p className="d-error">{a.processingError}</p>
                        )}
                      </div>
                      <div className="d-kb-row-status" role="status">
                        <span className="d-badge">
                          {statusLabels[a.status] || "不可用"}
                        </span>
                      </div>
                      <label className="d-kb-download">
                        <input
                          type="checkbox"
                          checked={
                            p.settings.files.find((f) => f.id === a.id)
                              ?.allowDownload ?? false
                          }
                          onChange={(e) =>
                            changeSettings({
                              files: p.settings.files.map((f) =>
                                f.id === a.id
                                  ? { ...f, allowDownload: e.target.checked }
                                  : f,
                              ),
                            })
                          }
                        />
                        <span>允许下载</span>
                      </label>
                      <div className="d-kb-row-actions">
                        {a.status === "failed" &&
                          !requiresKnowledgeSourceChange(a.processingError) && (
                            <button
                              type="button"
                              className="d-button d-ghost"
                              disabled={busy}
                              onClick={() => void retry(a)}
                            >
                              重试
                            </button>
                          )}
                        <button
                          type="button"
                          className="d-button d-ghost"
                          onClick={() =>
                            changeSettings({
                              files: p.settings.files.filter(
                                (f) => f.id !== a.id,
                              ),
                            })
                          }
                        >
                          移除关联
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="d-kb-permission-note">
                  <Icon name="lock" />
                  <p>
                    <strong>默认不允许访客下载原文件</strong>
                    <span>
                      关闭下载后，资料仍可用于回答。移除关联不会删除知识库文件。
                    </span>
                  </p>
                </div>
              </>
            )}
          </Panel>
        )}
        {tab === "faq" && (
          <Panel title="常见问题" icon="inbox">
            <section className="d-faq-suggestions" aria-label="AI 常见问题建议">
              <div className="d-faq-suggestions-head">
                <span className="d-faq-spark">
                  <Icon name="sparkles" />
                </span>
                <div>
                  <h3>
                    {p.faq.length
                      ? "让 AI 继续补充常见问题"
                      : "先让 AI 帮你整理常见问题"}
                  </h3>
                  <p>根据基本信息和已关联资料准备建议，你确认后再加入。</p>
                </div>
              </div>
              <div className="d-faq-inputs">
                <span>
                  <Icon name="user" />
                  基本信息
                </span>
                <span>
                  <Icon name="file" />
                  已关联 {ready.length} 份就绪资料
                </span>
                {linked.length > ready.length && (
                  <span>{linked.length - ready.length} 份文件待就绪</span>
                )}
              </div>
              {!p.faq.length && !!candidates.length && (
                <div className="d-faq-suggestion-list">
                  {candidates.slice(0, 3).map((q, i) => (
                    <article className="d-faq-suggestion" key={q.id}>
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <div>
                        <h4>{q.title}</h4>
                        <p>{q.summary}</p>
                        <small>{q.source}</small>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div className="d-faq-suggestion-actions">
                <button
                  type="button"
                  className="d-button d-primary"
                  disabled={busy}
                  onClick={() =>
                    candidates.length
                      ? setModal("review")
                      : void generate(
                          ready.slice(0, 5).map((a) => a.id),
                          true,
                          true,
                        )
                  }
                >
                  <Icon name="sparkles" />
                  {busy
                    ? "正在准备建议…"
                    : candidates.length
                      ? `检查并采用（${candidates.length}）`
                      : p.faq.length
                        ? "生成补充建议"
                        : "检查并采用"}
                </button>
                <button
                  type="button"
                  className="d-button d-ghost"
                  disabled={busy}
                  onClick={() => {
                    setSources(ready.slice(0, 5).map((a) => a.id));
                    setIncludeIntro(true);
                    setModal("sources");
                  }}
                >
                  调整生成来源
                </button>
              </div>
              {note && (
                <p className="d-faq-footnote" role="status">
                  {note}
                </p>
              )}
            </section>
            {!p.initialSetup && (
              <div className="d-faq-discovery">
                <div>
                  <strong>从服务记录发现高频问题</strong>
                  <p>服务记录分析尚未接入，当前不会自动生成或提醒。</p>
                </div>
              </div>
            )}
            {!!p.faq.length && (
              <details className="d-faq-saved" open>
                <summary>
                  已采用 {p.faq.length} 条问答{" "}
                  <span className="d-muted d-small">
                    输入框常见问题 Top 3 · {p.settings.featuredFaqIds.length} /
                    3
                  </span>
                </summary>
                <div className="d-faq-saved-list">
                  {p.faq.map((q) => (
                    <div className="d-faq-saved-row" key={q.id}>
                      <div>
                        <strong>{q.title}</strong>
                        <p>{q.summary}</p>
                        <small>
                          {p.settings.faqSources?.[q.id] ||
                            "手动添加 / 已有问答"}
                        </small>
                      </div>
                      <div className="d-faq-saved-controls">
                        <label>
                          <input
                            type="checkbox"
                            checked={p.settings.featuredFaqIds.includes(q.id)}
                            onChange={(e) => {
                              if (
                                e.target.checked &&
                                p.settings.featuredFaqIds.length >= 3
                              ) {
                                setError(
                                  "输入框常见问题最多3条，请先取消其他选项。",
                                );
                                return;
                              }
                              changeSettings({
                                featuredFaqIds: e.target.checked
                                  ? [...p.settings.featuredFaqIds, q.id]
                                  : p.settings.featuredFaqIds.filter(
                                      (id) => id !== q.id,
                                    ),
                              });
                            }}
                          />
                          设为常见问题
                        </label>
                        <button
                          type="button"
                          className="d-button d-ghost"
                          onClick={() => {
                            setEditing({ ...q });
                            setModal("edit");
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="d-button d-ghost"
                          onClick={() =>
                            p.onChange({
                              faq: p.faq.filter((f) => f.id !== q.id),
                              knowledgeSettings: {
                                ...p.settings,
                                featuredFaqIds:
                                  p.settings.featuredFaqIds.filter(
                                    (id) => id !== q.id,
                                  ),
                              },
                            })
                          }
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {!p.initialSetup && (
              <details className="d-faq-other">
                <summary>其他添加方式</summary>
                <div className="d-faq-actions">
                  <button
                    type="button"
                    className="d-button"
                    onClick={() => setModal("import")}
                  >
                    导入问答文档
                  </button>
                  <button
                    type="button"
                    className="d-button"
                    onClick={() => {
                      setEditing({
                        id: crypto.randomUUID(),
                        kind: "faq",
                        title: "",
                        summary: "",
                      });
                      setModal("edit");
                    }}
                  >
                    ＋ 手动添加
                  </button>
                </div>
              </details>
            )}
          </Panel>
        )}
        {tab === "boundaries" && (
          <>
            <Panel
              title="服务边界"
              icon="shield"
              subtitle="哪些事情需要你出面？"
              action={
                <button
                  type="button"
                  className="d-button"
                  onClick={() => {
                    setRules(structuredClone(p.settings.boundaries));
                    setModal("boundaries");
                  }}
                >
                  调整边界
                </button>
              }
            >
              <div className="d-sb-overview">
                {Object.entries(boundaryLabels).map(([action, label]) => {
                  const count = p.settings.boundaries.filter(
                    (b) => b.action === action,
                  ).length;
                  return count ? (
                    <div key={action}>
                      <strong>{count}</strong>
                      <span>{label}</span>
                    </div>
                  ) : null;
                })}
              </div>
              <p className="d-sb-scenarios">
                {p.settings.boundaries
                  .map(
                    (b) =>
                      boundaryPresets.find((x) => x.id === b.id)?.name ||
                      b.request,
                  )
                  .join(" · ")}
              </p>
              <p className="d-help">
                需要你作决定时先审批；需要持续沟通时申请人工接手。
              </p>
              <p className="d-knowledge-pending">
                当前可保存配置；按场景自动审批、接手及拒绝服务尚待 Agent
                执行端接入。
              </p>
            </Panel>
            <Panel
              title="人工接待说明"
              icon="user"
              subtitle="触及服务边界、需要本人接手时，向访客说明后续安排。"
            >
              <div className="d-grid2">
                <label className="d-field">
                  <span className="d-label">人工接管提示语</span>
                  <textarea
                    maxLength={600}
                    rows={3}
                    value={p.handoffPrompt}
                    onChange={(e) =>
                      p.onChange({ handoffPrompt: e.target.value })
                    }
                  />
                  <span className="d-help">向访客说明接下来会发生什么。</span>
                </label>
                <label className="d-field">
                  <span className="d-label">人工评估时窗</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={p.hours || ""}
                    onChange={(e) =>
                      p.onChange({ hours: Number(e.target.value) })
                    }
                  />
                  <span className="d-help">
                    单位：小时。与提示语一起保存草稿，发布后生效。
                  </span>
                </label>
              </div>
            </Panel>
          </>
        )}
      </div>
      <div className="d-answer-footer-note">
        <span>可稍后完善，发布后对访客生效。</span>
        <button
          type="button"
          className="d-button d-ghost"
          disabled={busy}
          onClick={p.onSkip}
        >
          暂时跳过 →
        </button>
      </div>
      <p className="d-knowledge-pending">
        本批先保存新版配置草稿；文件关联发布、访客下载和常见问题展示将在发布链路接通后生效。
      </p>
      {modal && (
        <Modal
          title={
            {
              library: "从知识库选择",
              sources: "调整生成来源",
              review: "确认常见问题",
              edit: "编辑常见问题",
              boundaries: "调整服务边界",
              import: "导入问答文档",
            }[modal] || ""
          }
          onClose={close}
          busy={busy}
          footer={
            <>
              <button
                type="button"
                className="d-button"
                disabled={busy}
                onClick={close}
              >
                取消
              </button>
              {modal === "library" && (
                <button
                  type="button"
                  className="d-button d-primary"
                  disabled={busy}
                  onClick={() => {
                    changeSettings({
                      files: picker.map(
                        (id) =>
                          p.settings.files.find((f) => f.id === id) ?? {
                            id,
                            allowDownload: false,
                          },
                      ),
                    });
                    close();
                  }}
                >
                  确认关联
                </button>
              )}
              {modal === "sources" && (
                <button
                  type="button"
                  className="d-button d-primary"
                  disabled={busy}
                  onClick={() => void generate(sources, includeIntro, true)}
                >
                  生成建议
                </button>
              )}
              {modal === "review" && (
                <button
                  type="button"
                  className="d-button d-primary"
                  disabled={!candidates.some((q) => q.selected)}
                  onClick={adopt}
                >
                  采用选中问答
                </button>
              )}
              {modal === "edit" && (
                <button
                  type="button"
                  className="d-button d-primary"
                  onClick={saveEdit}
                >
                  加入草稿
                </button>
              )}
              {modal === "boundaries" && (
                <button
                  type="button"
                  className="d-button d-primary"
                  onClick={() => {
                    const result = knowledgeSettingsSchema.safeParse({
                      ...p.settings,
                      boundaries: rules,
                    });
                    if (!result.success) {
                      setError(result.error.issues[0]?.message || "配置错误");
                      return;
                    }
                    changeSettings({ boundaries: rules });
                    close();
                  }}
                >
                  应用到草稿
                </button>
              )}
            </>
          }
        >
          {errorNode}
          {modal === "library" && (
            <>
              <div className="d-kb-picker-toolbar">
                <p className="d-help">
                  选择已有文件，或上传新文件。
                  <br />
                  新文件自动保存到知识库，并加入当前对外代理的草稿。
                </p>
                <button
                  type="button"
                  className="d-button"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  上传新文件
                </button>
              </div>
              <p className="d-kb-picker-upload-hint">
                PDF、DOCX、TXT、Markdown · 单个文件最大150MB
              </p>
              <input
                hidden
                ref={fileInput}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.markdown"
                onChange={(e) => {
                  void upload(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              {uploadNote && (
                <p className="d-help" role="status">
                  {uploadNote}
                </p>
              )}
              {loading ? (
                <p>正在读取知识库…</p>
              ) : !assets.length ? (
                <div
                  className="d-kb-picker-empty"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void upload(Array.from(e.dataTransfer.files));
                  }}
                >
                  <Icon name="folder" />
                  <h3>知识库里还没有文件</h3>
                  <p>上传后自动保存到知识库，并关联当前对外代理草稿。</p>
                  <button
                    type="button"
                    className="d-button d-primary"
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                  >
                    上传新文件
                  </button>
                  <p>支持拖拽上传 · 单个文件最大150MB</p>
                </div>
              ) : (
                assets.map((a) => (
                  <div key={a.id} className="d-kb-picker-item">
                    <label className="d-kb-picker-row">
                      <input
                        type="checkbox"
                        disabled={busy || a.status !== "ready"}
                        checked={picker.includes(a.id)}
                        onChange={(e) =>
                          setPicker((old) =>
                            e.target.checked
                              ? [...old, a.id]
                              : old.filter((id) => id !== a.id),
                          )
                        }
                      />
                      <span className="d-kb-file-icon">
                        <Icon name="file" />
                      </span>
                      <span className="d-kb-picker-name">
                        <strong>{a.originalFileName || a.title}</strong>
                        <small>{a.kind}</small>
                      </span>
                      <span className="d-badge">
                        {statusLabels[a.status] || a.status}
                      </span>
                    </label>
                    {a.processingError && (
                      <p className="d-error">{a.processingError}</p>
                    )}
                  </div>
                ))
              )}
            </>
          )}
          {modal === "sources" && (
            <>
              <p className="d-faq-modal-intro">
                默认参考基本信息和已关联的知识文件，每次最多5份资料。
              </p>
              <label className="d-faq-source-option">
                <input
                  type="checkbox"
                  checked={includeIntro}
                  onChange={(e) => setIncludeIntro(e.target.checked)}
                />
                <span>
                  <strong>基本信息</strong>
                  <small>{p.description}</small>
                </span>
              </label>
              {ready.map((a) => (
                <label className="d-faq-source-option" key={a.id}>
                  <input
                    type="checkbox"
                    checked={sources.includes(a.id)}
                    onChange={(e) => {
                      if (e.target.checked && sources.length >= 5) {
                        setError("每次最多选择5份资料。");
                        return;
                      }
                      setSources((old) =>
                        e.target.checked
                          ? [...old, a.id]
                          : old.filter((id) => id !== a.id),
                      );
                    }}
                  />
                  <span>
                    <strong>{a.title}</strong>
                    <small>已关联文件</small>
                  </span>
                </label>
              ))}
              <p className="d-faq-footnote">
                接口每份参考前2000字。生成结果需要检查，不代表覆盖全文。
              </p>
            </>
          )}
          {modal === "review" && (
            <>
              <p className="d-faq-modal-intro">
                可批量采用，也可修改问题和答案。
              </p>
              <p className="d-faq-footnote">{note}</p>
              <div className="d-faq-review-tools">
                <span>
                  {candidates.length} 条建议 · 已选{" "}
                  {candidates.filter((q) => q.selected).length} 条
                </span>
                <button
                  type="button"
                  className="d-button d-ghost"
                  onClick={() =>
                    setCandidates((old) =>
                      old.map((q) => ({ ...q, selected: true })),
                    )
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  className="d-button d-ghost"
                  onClick={() =>
                    setCandidates((old) =>
                      old.map((q) => ({ ...q, selected: false })),
                    )
                  }
                >
                  取消全选
                </button>
              </div>
              {candidates.map((q, index) => (
                <div className="d-faq-review-row" key={q.id}>
                  <div className="d-faq-review-head">
                    <label>
                      <input
                        type="checkbox"
                        checked={q.selected}
                        onChange={(e) =>
                          setCandidates((old) =>
                            old.map((item, i) =>
                              i === index
                                ? { ...item, selected: e.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      采用
                    </label>
                    <span className="d-faq-source">{q.source}</span>
                  </div>
                  <label className="d-field">
                    <span className="d-label">问题</span>
                    <input
                      maxLength={100}
                      value={q.title}
                      onChange={(e) =>
                        setCandidates((old) =>
                          old.map((item, i) =>
                            i === index
                              ? { ...item, title: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="d-field">
                    <span className="d-label">答案</span>
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={q.summary}
                      onChange={(e) =>
                        setCandidates((old) =>
                          old.map((item, i) =>
                            i === index
                              ? { ...item, summary: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
            </>
          )}
          {modal === "edit" && editing && (
            <>
              <label className="d-field">
                <span className="d-label">问题</span>
                <input
                  maxLength={100}
                  value={editing.title}
                  onChange={(e) =>
                    setEditing({ ...editing, title: e.target.value })
                  }
                />
              </label>
              <label className="d-field">
                <span className="d-label">答案</span>
                <textarea
                  rows={5}
                  maxLength={2000}
                  value={editing.summary}
                  onChange={(e) =>
                    setEditing({ ...editing, summary: e.target.value })
                  }
                />
              </label>
              <label className="d-field">
                <span className="d-label">参考链接（选填）</span>
                <input
                  type="url"
                  value={editing.url || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, url: e.target.value || undefined })
                  }
                />
              </label>
            </>
          )}
          {modal === "import" && (
            <div className="d-faq-import-box">
              <Icon name="file" />
              <strong>导入已有问答文档</strong>
              <p>使用“问：… 答：…”或“Q: … A: …”格式。</p>
              <button
                type="button"
                className="d-button"
                onClick={() => faqInput.current?.click()}
              >
                选择问答文档
              </button>
              <input
                hidden
                type="file"
                ref={faqInput}
                accept=".txt,.md,.markdown"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void importFaq(f).catch(() =>
                      setError("读取文件失败，请重试。"),
                    );
                  e.target.value = "";
                }}
              />
              <p>目前可读取 TXT、Markdown；PDF、Word 问答整理尚未接入。</p>
            </div>
          )}
          {modal === "boundaries" && (
            <>
              <div className="d-sb-explanation">
                <p>
                  <strong>需要我审批</strong>
                  ：你同意或拒绝后，对外代理继续沟通。
                </p>
                <p>
                  <strong>需要我接手</strong>：由你亲自进入会话，持续处理。
                </p>
              </div>
              <div className="d-sb-rule-list">
                {rules.map((b, index) => {
                  const preset = boundaryPresets.find((x) => x.id === b.id);
                  return (
                    <div
                      className={`d-sb-rule ${preset ? "" : "custom"}`}
                      key={b.id}
                    >
                      <div>
                        <div className="d-sb-rule-title">
                          <strong>{preset?.name || "遇到什么请求？"}</strong>
                          <RepresentativeBoundaryExample rule={b} />
                        </div>
                        {preset ? (
                          <p>{preset.description}</p>
                        ) : (
                          <input
                            aria-label="自定义请求"
                            maxLength={200}
                            value={b.request}
                            onChange={(e) =>
                              setRules((old) =>
                                old.map((r, i) =>
                                  i === index
                                    ? { ...r, request: e.target.value }
                                    : r,
                                ),
                              )
                            }
                          />
                        )}
                      </div>
                      <select
                        aria-label={`${preset?.name || "自定义场景"}处理方式`}
                        value={b.action}
                        onChange={(e) =>
                          setRules((old) =>
                            old.map((r, i) =>
                              i === index
                                ? {
                                    ...r,
                                    action: e.target.value as typeof r.action,
                                  }
                                : r,
                            ),
                          )
                        }
                      >
                        {Object.entries(boundaryLabels).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                      {!preset && (
                        <button
                          type="button"
                          className="d-button d-ghost"
                          onClick={() =>
                            setRules((old) => old.filter((r) => r.id !== b.id))
                          }
                        >
                          移除
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="d-button d-ghost"
                disabled={rules.length >= 50}
                onClick={() =>
                  setRules((old) => [
                    ...old,
                    { id: crypto.randomUUID(), request: "", action: "approve" },
                  ])
                }
              >
                ＋ 添加其他场景
              </button>
              <p className="d-sb-eligibility">
                人工接手仍按「价格」中的收费方式与套餐权益处理；触发边界不会自动获得付费人工权益。
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
