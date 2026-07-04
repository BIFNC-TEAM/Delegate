"use client";

import type { FormEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  DashboardPanelFrame,
  DashboardSignalStrip,
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

type TrainingSource = {
  id: string;
  kind: "url" | "pdf" | "text" | "notion" | "drive" | "website";
  status: "draft" | "active" | "disabled" | "failed";
  title: string;
  locator: string | null;
  contentText: string | null;
  updatedAt: string;
};

type FeedbackSignal = {
  id: string;
  signalType: "approve" | "correction" | "do_not_say" | "suggested_answer";
  publicSafe: boolean;
  note: string | null;
  suggestedText: string | null;
  createdAt: string;
};

type TrainingSuggestion = {
  id: string;
  suggestionType:
    | "faq_update"
    | "policy_update"
    | "material_update"
    | "tone_rule"
    | "skill_recommendation"
    | "knowledge_gap";
  status: "pending" | "approved" | "rejected" | "private" | "published";
  title: string;
  rationale: string;
  draftPayload: unknown;
  riskLevel: string;
  createdAt: string;
};

type TrainingVersion = {
  id: string;
  title: string;
  status: "published" | "rolled_back";
  publishedBy: string | null;
  publishedAt: string;
};

type TrainingSnapshot = {
  sources: TrainingSource[];
  feedbackSignals: FeedbackSignal[];
  suggestions: TrainingSuggestion[];
  versions: TrainingVersion[];
};

export function DashboardTraining({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [snapshot, setSnapshot] = useState<TrainingSnapshot | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceKind, setSourceKind] = useState<TrainingSource["kind"]>("url");
  const [sourceLocator, setSourceLocator] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileInputResetKey, setFileInputResetKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void refreshTraining(representativeSlug, setSnapshot, setError).catch((nextError: unknown) => {
      setError(nextError instanceof Error ? nextError.message : t.loadingError);
    });
  }, [representativeSlug]);

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyKey("source:create");
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const uploads = selectedFiles.length
          ? await Promise.all(selectedFiles.map((file) => buildFileSourcePayload(file, sourceTitle)))
          : [
              buildManualSourcePayload({
                kind: sourceKind,
                title: sourceTitle,
                locator: sourceLocator,
                contentText: sourceText,
              }),
            ];

        for (const body of uploads) {
          const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/training/sources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            throw new Error(await extractError(response));
          }
        }

        setSourceTitle("");
        setSourceLocator("");
        setSourceText("");
        setSelectedFiles([]);
        setFileInputResetKey((value) => value + 1);
        await refreshTraining(representativeSlug, setSnapshot, setError);
        setMessage(selectedFiles.length ? t.filesCreated(selectedFiles.length) : t.sourceCreated);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.sourceError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  function buildSuggestions() {
    setBusyKey("suggestions:build");
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/training/workflows`, {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshTraining(representativeSlug, setSnapshot, setError);
        setMessage(t.suggestionsQueued);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.suggestionError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  function reviewSuggestion(suggestionId: string, action: "approve" | "reject" | "private") {
    setBusyKey(`review:${suggestionId}:${action}`);
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/training/suggestions/${suggestionId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, reviewedBy: "owner-dashboard" }),
          },
        );
        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshTraining(representativeSlug, setSnapshot, setError);
        setMessage(action === "approve" ? t.suggestionApproved : t.suggestionReviewed);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.reviewError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  function rollbackVersion(versionId: string) {
    setBusyKey(`rollback:${versionId}`);
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/training/versions/${versionId}/rollback`,
          {
            method: "POST",
          },
        );
        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshTraining(representativeSlug, setSnapshot, setError);
        setMessage(t.versionRolledBack);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.rollbackError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  if (!snapshot) {
    return (
      <section className="section">
        <article className="dashboard-highlight-card">
          <p className="panel-title">{t.loadingTitle}</p>
          <h3>{t.loadingHeadline}</h3>
          <p>{t.loadingCopy}</p>
          {error ? <div className="status-banner status-error">{error}</div> : null}
        </article>
      </section>
    );
  }

  return (
    <DashboardPanelFrame eyebrow={t.panelEyebrow} summary={t.panelSummary} title={t.panelTitle}>
      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.heroKicker}</p>
          <h3>{t.heroTitle}</h3>
          <p>{t.heroCopy}</p>
          <div className="chip-row">
            <span className="chip chip-safe">{t.humanReviewChip}</span>
            <span className="chip">{representativeSlug}</span>
          </div>
        </article>

        <DashboardSignalStrip
          cards={[
            {
              label: t.sourcesLabel,
              value: `${snapshot.sources.length}`,
              detail: t.sourcesDetail,
              tone: "accent" as const,
            },
            {
              label: t.feedbackLabel,
              value: `${snapshot.feedbackSignals.length}`,
              detail: t.feedbackDetail,
            },
            {
              label: t.suggestionsLabel,
              value: `${snapshot.suggestions.length}`,
              detail: t.suggestionsDetail,
              tone: snapshot.suggestions.length ? ("safe" as const) : "default",
            },
            {
              label: t.versionsLabel,
              value: `${snapshot.versions.length}`,
              detail: t.versionsDetail,
            },
          ]}
        />
      </div>

      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <div className="dashboard-action-bar">
        <button
          className="button-primary"
          disabled={isPending || busyKey === "suggestions:build"}
          onClick={buildSuggestions}
          type="button"
        >
          {busyKey === "suggestions:build" ? t.building : t.buildSuggestions}
        </button>
      </div>

      <DashboardSurfaceGrid>
        <DashboardSurface eyebrow={t.sourceEyebrow} title={t.sourceTitle}>
          <p className="section-copy">{t.sourceSummary}</p>
          <form className="setup-stack" onSubmit={submitSource}>
            <label className="field-stack">
              <span>{t.sourceTitleLabel}</span>
              <input
                className="text-input"
                onChange={(event) => setSourceTitle(event.target.value)}
                placeholder={t.sourceTitlePlaceholder}
                value={sourceTitle}
              />
            </label>
            <div className="setup-grid compact-grid">
              <label className="field-stack">
                <span>{t.sourceKindLabel}</span>
                <select
                  className="text-input"
                  onChange={(event) => setSourceKind(event.target.value as TrainingSource["kind"])}
                  value={sourceKind}
                >
                  {["url", "pdf", "text", "notion", "drive", "website"].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>{t.sourceLocatorLabel}</span>
                <input
                  className="text-input"
                  onChange={(event) => setSourceLocator(event.target.value)}
                  placeholder={t.sourceLocatorPlaceholder}
                  value={sourceLocator}
                />
              </label>
            </div>
            <label className="field-stack">
              <span>{t.sourceTextLabel}</span>
              <textarea
                className="text-input text-area"
                onChange={(event) => setSourceText(event.target.value)}
                placeholder={t.sourceTextPlaceholder}
                rows={3}
                value={sourceText}
              />
            </label>
            <label className="field-stack">
              <span>{t.sourceFileLabel}</span>
              <input
                className="text-input"
                key={fileInputResetKey}
                multiple
                onChange={(event) => setSelectedFiles(Array.from(event.currentTarget.files ?? []))}
                type="file"
                accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/csv,application/json,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              />
              {selectedFiles.length ? (
                <>
                  <div className="chip-row" aria-live="polite">
                    {selectedFiles.map((file) => (
                      <span className="chip" key={`${file.name}:${file.size}`}>
                        {file.name} · {formatFileSize(file.size)}
                      </span>
                    ))}
                  </div>
                  <span className="footer-note">{t.selectedFiles(selectedFiles.length)}</span>
                </>
              ) : (
                <span className="footer-note">{t.sourceFileHint}</span>
              )}
            </label>
            <button
              className="button-secondary"
              disabled={isPending || busyKey === "source:create" || (!sourceTitle.trim() && selectedFiles.length === 0)}
              type="submit"
            >
              {busyKey === "source:create" ? t.creatingSource : t.createSource}
            </button>
          </form>
        </DashboardSurface>

        <DashboardSurface eyebrow={t.pendingEyebrow} title={t.pendingTitle}>
          <p className="section-copy">{t.pendingSummary}</p>
          <div className="setup-stack">
            {snapshot.suggestions.length ? (
              snapshot.suggestions.map((suggestion) => (
                <article className="panel" key={suggestion.id}>
                  <div className="setup-section-header">
                    <div>
                      <p className="panel-title">{suggestion.suggestionType}</p>
                      <h3>{suggestion.title}</h3>
                      <p>{suggestion.rationale}</p>
                    </div>
                    <span className={suggestion.riskLevel === "high" ? "chip chip-danger" : "chip"}>
                      {suggestion.riskLevel}
                    </span>
                  </div>
                  <pre className="code-block">{formatPayload(suggestion.draftPayload)}</pre>
                  <div className="button-row">
                    <button
                      className="button-primary"
                      disabled={isPending}
                      onClick={() => reviewSuggestion(suggestion.id, "approve")}
                      type="button"
                    >
                      {t.approve}
                    </button>
                    <button
                      className="button-secondary"
                      disabled={isPending}
                      onClick={() => reviewSuggestion(suggestion.id, "reject")}
                      type="button"
                    >
                      {t.reject}
                    </button>
                    <button
                      className="button-secondary"
                      disabled={isPending}
                      onClick={() => reviewSuggestion(suggestion.id, "private")}
                      type="button"
                    >
                      {t.keepPrivate}
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p className="footer-note">{t.noSuggestions}</p>
            )}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>

      <DashboardSurfaceGrid>
        <DashboardSurface eyebrow={t.inventoryEyebrow} title={t.inventoryTitle}>
          <p className="section-copy">{t.inventorySummary}</p>
          <div className="setup-stack">
            {snapshot.sources.length ? (
              snapshot.sources.map((source) => (
                <article className="skill-row" key={source.id}>
                  <div>
                    <strong>{source.title}</strong>
                    <p>{source.locator ?? source.contentText ?? t.noLocator}</p>
                    <div className="chip-row">
                      <span className="chip">{source.kind}</span>
                      <span className={source.status === "active" ? "chip chip-safe" : "chip"}>{source.status}</span>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <p className="footer-note">{t.noSources}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface eyebrow={t.versionEyebrow} title={t.versionTitle}>
          <p className="section-copy">{t.versionSummary}</p>
          <div className="setup-stack">
            {snapshot.versions.length ? (
              snapshot.versions.map((version) => (
                <article className="skill-row" key={version.id}>
                  <div>
                    <strong>{version.title}</strong>
                    <p>
                      {version.status} · {new Date(version.publishedAt).toLocaleString()}
                    </p>
                    {version.publishedBy ? <span className="chip">{version.publishedBy}</span> : null}
                  </div>
                  {version.status === "published" ? (
                    <button
                      className="button-secondary"
                      disabled={isPending || busyKey === `rollback:${version.id}`}
                      onClick={() => rollbackVersion(version.id)}
                      type="button"
                    >
                      {busyKey === `rollback:${version.id}` ? t.rollingBack : t.rollback}
                    </button>
                  ) : null}
                </article>
              ))
            ) : (
              <p className="footer-note">{t.noVersions}</p>
            )}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>
    </DashboardPanelFrame>
  );
}

async function refreshTraining(
  representativeSlug: string,
  setSnapshot: (snapshot: TrainingSnapshot) => void,
  setError: (error: string | null) => void,
) {
  const [sourcesResponse, feedbackResponse, suggestionsResponse, versionsResponse] = await Promise.all([
    fetch(`/api/dashboard/representatives/${representativeSlug}/training/sources`, { cache: "no-store" }),
    fetch(`/api/dashboard/representatives/${representativeSlug}/training/feedback?status=new`, {
      cache: "no-store",
    }),
    fetch(`/api/dashboard/representatives/${representativeSlug}/training/suggestions?status=pending`, {
      cache: "no-store",
    }),
    fetch(`/api/dashboard/representatives/${representativeSlug}/training/versions`, { cache: "no-store" }),
  ]);

  for (const response of [sourcesResponse, feedbackResponse, suggestionsResponse, versionsResponse]) {
    if (!response.ok) {
      throw new Error(await extractError(response));
    }
  }

  const sourcesPayload = (await sourcesResponse.json()) as { sources: TrainingSource[] };
  const feedbackPayload = (await feedbackResponse.json()) as { feedbackSignals: FeedbackSignal[] };
  const suggestionsPayload = (await suggestionsResponse.json()) as { suggestions: TrainingSuggestion[] };
  const versionsPayload = (await versionsResponse.json()) as { versions: TrainingVersion[] };

  setError(null);
  setSnapshot({
    sources: sourcesPayload.sources,
    feedbackSignals: feedbackPayload.feedbackSignals,
    suggestions: suggestionsPayload.suggestions,
    versions: versionsPayload.versions,
  });
}

async function extractError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

function formatPayload(value: unknown) {
  return JSON.stringify(formatPayloadForReview(value), null, 2);
}

function formatPayloadForReview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_REVIEW_STRING_LENGTH
      ? `${value.slice(0, MAX_REVIEW_STRING_LENGTH)}... [truncated for review display]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatPayloadForReview(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 6) {
      return "[nested payload truncated for review display]";
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, formatPayloadForReview(item, depth + 1)]),
    );
  }
  return value;
}

function buildManualSourcePayload(input: {
  kind: TrainingSource["kind"];
  title: string;
  locator: string;
  contentText: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    title: input.title,
  };
  if (input.locator.trim()) {
    body.locator = input.locator.trim();
  }
  if (input.contentText.trim()) {
    body.contentText = input.contentText.trim();
  }
  return body;
}

async function buildFileSourcePayload(file: File, titlePrefix: string): Promise<Record<string, unknown>> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = detectFileSourceKind(extension);
  const title = titlePrefix.trim() ? `${titlePrefix.trim()} - ${file.name}` : file.name;
  const extracted = await extractFileText(file, extension);
  const text = normalizeFileText({
    value: extracted.text,
    fileName: file.name,
    mimeType: file.type,
    warning: extracted.warning,
  });

  return {
    kind,
    title,
    locator: `upload:${file.name}`,
    contentText: text,
    metadata: {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      extension,
      extractedBy: extracted.extractedBy,
      ...(extracted.warning ? { extractionWarning: extracted.warning } : {}),
      truncated: extracted.text.length > MAX_FILE_TEXT_LENGTH,
    },
  };
}

function detectFileSourceKind(extension: string): TrainingSource["kind"] {
  if (extension === "pdf") {
    return "pdf";
  }
  if (extension === "html" || extension === "htm") {
    return "website";
  }
  return "text";
}

const MAX_FILE_TEXT_LENGTH = 24_000;
const MAX_REVIEW_STRING_LENGTH = 720;

async function extractFileText(
  file: File,
  extension: string,
): Promise<{ text: string; extractedBy: string; warning?: string }> {
  if (extension === "docx") {
    return extractDocxText(file);
  }

  const rawText = await file.text();
  if (extension === "html" || extension === "htm" || file.type === "text/html") {
    return {
      text: extractHtmlText(rawText),
      extractedBy: "browser_html_text",
    };
  }
  if (extension === "json" || file.type === "application/json") {
    return {
      text: extractJsonText(rawText),
      extractedBy: "browser_json_text",
    };
  }
  if (extension === "pdf" || file.type === "application/pdf") {
    const pdfText = extractPdfVisibleText(rawText);
    return {
      text: pdfText.text,
      extractedBy: "browser_pdf_best_effort",
      ...(pdfText.warning ? { warning: pdfText.warning } : {}),
    };
  }

  return {
    text: rawText,
    extractedBy: "browser_file_text",
  };
}

async function extractDocxText(file: File): Promise<{ text: string; extractedBy: string; warning?: string }> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const documentXml = await zip.file("word/document.xml")?.async("text");
    if (!documentXml) {
      return {
        text: tFallbackBinarySummary(file.name),
        extractedBy: "browser_docx_best_effort",
        warning: "DOCX text was not readable; please paste a short summary for best results.",
      };
    }

    const text = [...documentXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXmlText(match[1] ?? ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      text: text || tFallbackBinarySummary(file.name),
      extractedBy: "browser_docx_text",
      ...(text
        ? {}
        : { warning: "DOCX did not contain readable body text; please paste a short summary." }),
    };
  } catch {
    return {
      text: tFallbackBinarySummary(file.name),
      extractedBy: "browser_docx_best_effort",
      warning: "DOCX text extraction failed; please paste a short summary for best results.",
    };
  }
}

function extractHtmlText(value: string) {
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(value, "text/html");
    return (document.body.textContent ?? value).replace(/\s+/g, " ").trim();
  }
  return value.replace(/<[^>]+>/g, " ");
}

function extractJsonText(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function extractPdfVisibleText(value: string): { text: string; warning?: string } {
  const streamMatches = [...value.matchAll(/stream([\s\S]*?)endstream/g)].map((match) => match[1] ?? "");
  const source = streamMatches.length ? streamMatches.join(" ") : value;
  const text = source
    .replace(/%PDF-\S+/g, " ")
    .replace(/\bendobj\b|\bobj\b|\bstream\b|\bendstream\b|\bxref\b|\btrailer\b|\bstartxref\b/g, " ")
    .replace(/<<|>>|\/[A-Za-z0-9#]+|\d+\s+\d+\s+R/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || readableCharacterRatio(text) < 0.65) {
    return {
      text: "PDF file registered, but readable text could not be extracted in the browser. Paste a short public summary before publishing.",
      warning: "PDF readable text was limited; paste a summary for best results.",
    };
  }
  return { text };
}

function normalizeFileText(input: {
  value: string;
  fileName: string;
  mimeType: string;
  warning?: string | undefined;
}) {
  const normalized = input.value.replace(/\s+/g, " ").trim();
  const body = normalized.length > MAX_FILE_TEXT_LENGTH
    ? normalized.slice(0, MAX_FILE_TEXT_LENGTH)
    : normalized;
  return [
    `Uploaded file: ${input.fileName}`,
    input.mimeType ? `MIME type: ${input.mimeType}` : null,
    input.warning ? `Extraction note: ${input.warning}` : null,
    "Extracted text:",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function readableCharacterRatio(value: string) {
  if (!value.length) {
    return 0;
  }
  const readable = value.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, "").length;
  return readable / value.length;
}

function tFallbackBinarySummary(fileName: string) {
  return `File ${fileName} was registered, but readable body text was not extracted in the browser. Paste a short public summary before approving this source.`;
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

const copy = {
  zh: {
    loadingTitle: "正在加载养成驾驶舱",
    loadingHeadline: "读取资料源、反馈、建议和版本",
    loadingCopy: "如果一直停在这里，请检查 dashboard API 和数据库迁移是否已部署。",
    loadingError: "加载养成驾驶舱失败。",
    panelEyebrow: "Training loop",
    panelTitle: "养 Delegate 驾驶舱",
    panelSummary: "把资料、反馈、建议和发布版本收束成 creator 可审批的养成闭环。",
    heroKicker: "Creator-in-the-loop",
    heroTitle: "Delegate 可以主动建议学习，但正式知识必须由 creator 审批。",
    heroCopy: "这里不会自动把用户对话写进公开知识。系统只生成草稿，creator 决定接受、拒绝或保留为私有。",
    humanReviewChip: "human review required",
    sourcesLabel: "资料源",
    sourcesDetail: "已登记的上传、链接或外部来源。",
    feedbackLabel: "反馈",
    feedbackDetail: "待处理 creator 纠错和禁用话术。",
    suggestionsLabel: "建议",
    suggestionsDetail: "等待审批的训练草稿。",
    versionsLabel: "版本",
    versionsDetail: "已发布的训练版本。",
    sourceEyebrow: "Source registry",
    sourceTitle: "登记新的养成资料源",
    sourceSummary: "先登记 URL/PDF/text/Notion/Drive 占位源，同步和解析可以后续异步做。",
    sourceTitleLabel: "标题",
    sourceTitlePlaceholder: "例如：退款政策 / 课程 FAQ",
    sourceKindLabel: "类型",
    sourceLocatorLabel: "链接或外部定位",
    sourceLocatorPlaceholder: "https://...",
    sourceTextLabel: "文本内容",
    sourceTextPlaceholder: "可直接粘贴一段公开资料",
    sourceFileLabel: "上传资料文件",
    sourceFileHint: "支持 txt、md、csv、json、html、docx；PDF 会登记并尽力读取可见文本，复杂 PDF 仍建议粘贴摘要。",
    selectedFiles: (count: number) => `已选择 ${count} 个文件。上传后先生成建议，审批通过才会进入公开代表知识。`,
    createSource: "新增资料源",
    creatingSource: "正在新增...",
    sourceCreated: "资料源已创建。",
    filesCreated: (count: number) => `${count} 个资料文件已创建。`,
    sourceError: "创建资料源失败。",
    buildSuggestions: "生成训练建议",
    building: "正在生成...",
    suggestionsQueued: "训练建议 workflow 已加入队列。",
    suggestionError: "生成训练建议失败。",
    pendingEyebrow: "Review queue",
    pendingTitle: "待审批训练建议",
    pendingSummary: "只有点击通过的建议才会进入正式 KnowledgePack。",
    approve: "通过并发布",
    reject: "拒绝",
    keepPrivate: "设为私有",
    suggestionApproved: "建议已发布。",
    suggestionReviewed: "建议已处理。",
    reviewError: "处理建议失败。",
    noSuggestions: "当前没有待审批建议。可以先登记资料源，或从反馈/unknown 问题生成建议。",
    inventoryEyebrow: "Inventory",
    inventoryTitle: "资料源库存",
    inventorySummary: "Creator 给 Delegate 的原始学习输入。",
    noSources: "还没有资料源。",
    noLocator: "没有链接或文本预览。",
    versionEyebrow: "Versions",
    versionTitle: "发布版本",
    versionSummary: "每次发布都会保存 before/after snapshot，后续可回滚。",
    rollback: "回滚",
    rollingBack: "正在回滚...",
    versionRolledBack: "训练版本已回滚。",
    rollbackError: "回滚训练版本失败。",
    noVersions: "还没有发布版本。",
  },
  en: {
    loadingTitle: "Loading training cockpit",
    loadingHeadline: "Reading sources, feedback, suggestions, and versions",
    loadingCopy: "If this keeps loading, check that the dashboard APIs and database migration are deployed.",
    loadingError: "Failed to load training cockpit.",
    panelEyebrow: "Training loop",
    panelTitle: "Train your Delegate",
    panelSummary: "Turn sources, feedback, suggestions, and release versions into a creator-reviewed loop.",
    heroKicker: "Creator-in-the-loop",
    heroTitle: "Delegate can suggest what to learn, but creator approval publishes it.",
    heroCopy: "User conversations are not automatically promoted into public knowledge. The system drafts; the creator approves, rejects, or keeps private.",
    humanReviewChip: "human review required",
    sourcesLabel: "Sources",
    sourcesDetail: "Registered uploads, links, or external placeholders.",
    feedbackLabel: "Feedback",
    feedbackDetail: "Creator corrections and do-not-say notes awaiting review.",
    suggestionsLabel: "Suggestions",
    suggestionsDetail: "Training drafts waiting for approval.",
    versionsLabel: "Versions",
    versionsDetail: "Published training versions.",
    sourceEyebrow: "Source registry",
    sourceTitle: "Register a new training source",
    sourceSummary: "Register URL/PDF/text/Notion/Drive placeholders now; sync and parsing can run later.",
    sourceTitleLabel: "Title",
    sourceTitlePlaceholder: "For example: refund policy / course FAQ",
    sourceKindLabel: "Kind",
    sourceLocatorLabel: "Link or external locator",
    sourceLocatorPlaceholder: "https://...",
    sourceTextLabel: "Text content",
    sourceTextPlaceholder: "Paste public material directly",
    sourceFileLabel: "Upload training files",
    sourceFileHint: "Supports txt, md, csv, json, html, docx; PDF is registered with best-effort visible text, but complex PDFs still need a pasted summary.",
    selectedFiles: (count: number) => `${count} files selected. Uploads become suggestions first; only approval publishes them to the public representative.`,
    createSource: "Add source",
    creatingSource: "Adding...",
    sourceCreated: "Source created.",
    filesCreated: (count: number) => `${count} training files created.`,
    sourceError: "Failed to create source.",
    buildSuggestions: "Build suggestions",
    building: "Building...",
    suggestionsQueued: "Training suggestion workflow queued.",
    suggestionError: "Failed to build training suggestions.",
    pendingEyebrow: "Review queue",
    pendingTitle: "Pending training suggestions",
    pendingSummary: "Only approved suggestions enter the official KnowledgePack.",
    approve: "Approve and publish",
    reject: "Reject",
    keepPrivate: "Keep private",
    suggestionApproved: "Suggestion published.",
    suggestionReviewed: "Suggestion reviewed.",
    reviewError: "Failed to review suggestion.",
    noSuggestions: "No pending suggestions yet. Register a source or build suggestions from feedback/unknown questions.",
    inventoryEyebrow: "Inventory",
    inventoryTitle: "Source inventory",
    inventorySummary: "Raw learning inputs the creator gave to Delegate.",
    noSources: "No sources yet.",
    noLocator: "No link or text preview.",
    versionEyebrow: "Versions",
    versionTitle: "Release versions",
    versionSummary: "Each publish stores a before/after snapshot so rollback can be supported.",
    rollback: "Roll back",
    rollingBack: "Rolling back...",
    versionRolledBack: "Training version rolled back.",
    rollbackError: "Failed to roll back training version.",
    noVersions: "No published versions yet.",
  },
} as const;
