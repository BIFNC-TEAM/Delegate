"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Locale } from "@delegate/web-ui";

import { getGovernedContextSyncPresentation } from "./dashboard-governed-context-status";

type MemoryServiceStatus = "available" | "unavailable" | "disabled";
type GovernedMemoryStatus =
  | "ACTIVE"
  | "SUPPRESSED"
  | "DELETE_PENDING"
  | "DELETED"
  | "DELETE_FAILED";

type RecentSyncJob = {
  status: string;
  itemCount: number;
  startedAt: string;
  finishedAt?: string;
};

type GovernedContextSettings = {
  representativeSlug: string;
  enabled: boolean;
  autoRecall: boolean;
  autoCapture: false;
  recallLimit: number;
  recallScoreThreshold: number;
  serviceStatus: MemoryServiceStatus;
  publicKnowledgeSyncAvailable: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
  recentSyncJobs: RecentSyncJob[];
};

type GovernedMemory = {
  id: string;
  contactDisplayLabel: string;
  summary: string;
  status: GovernedMemoryStatus;
  createdAt: string;
  lastActionAttemptAt?: string;
  actionAttemptCount: number;
};

type RecallUsage = {
  today: number;
  total: number;
};

type MemorySnapshot = {
  settings: GovernedContextSettings;
  memories: GovernedMemory[];
  usage: RecallUsage;
};

type MemoryAction = "suppress" | "delete" | "retry";

const copy = {
  zh: {
    eyebrow: "MEMORY SYSTEM / 07",
    title: "安全、真实、可撤回的记忆系统。",
    summary: "这里只管理当前代表已有的受治理联系人记忆，并如实展示检索和发布知识同步状态。公开知识仍在知识库中管理。",
    refresh: "刷新",
    refreshing: "刷新中…",
    knowledge: "打开知识库",
    settings: "代表记忆设置",
    boundaryTitle: "长期记忆边界",
    boundaryRaw: "原始聊天、Owner 私有备注和 Compute 原始产物不会直接进入长期记忆。",
    boundarySensitive: "凭据、支付金额、余额与权益事实不会进入长期记忆，也不能依据记忆授权。",
    boundaryKnowledge: "公开知识只来自已生效的发布版本；草稿继续留在知识库，不参与线上检索。",
    loadingTitle: "正在读取记忆系统",
    loadingDetail: "读取受治理记忆、检索记录和同步状态。",
    unavailableTitle: "记忆数据暂时不可用",
    unavailableDetail: "当前页面不会用示例数字代替真实数据。请稍后重试，公开知识仍可在知识库中管理。",
    retry: "重试",
    activeMemories: "有效记忆",
    activeMemoriesDetail: "当前可参与安全检索",
    inactiveMemories: "非活动记录",
    inactiveMemoriesDetail: "已停用、清理中或已清理",
    todaySearchRecords: "今日检索记录",
    todaySearchRecordsDetail: "仅表示检索与授权记录",
    cleanupErrors: "清理异常",
    cleanupErrorsDetail: "需要重试的物理清理",
    recordsEyebrow: "GOVERNED MEMORIES",
    recordsTitle: "联系人记忆",
    recordsDescription: "当前接口只提供已受治理的联系人记忆。候选审核、代表经验和完整筛选能力尚未接入时，不会显示伪造队列。",
    recordsEmptyTitle: "还没有受治理记忆",
    recordsEmptyDetail: "原始会话不会自动生成长期记忆。只有经过治理流程的结构化内容才会出现在这里。",
    serviceEyebrow: "SERVICE STATUS",
    serviceTitle: "服务与策略状态",
    serviceDescription: "这里只展示只读状态；策略修改仍在数字代表配置中完成。",
    service: "记忆服务",
    projection: "长期记忆",
    recall: "自动召回",
    capture: "自动提取",
    channels: "渠道能力",
    channelsUnavailable: "当前接口尚未提供 Web、Matrix、Telegram 的逐渠道召回/提取矩阵。",
    enabled: "已启用",
    disabled: "已关闭",
    available: "可用",
    unavailable: "不可用",
    lastUpdated: "本页更新时间",
    usageEyebrow: "USAGE SUMMARY",
    usageTitle: "使用记录概览",
    usageDescription: "当前仅提供安全检索记录汇总，尚未提供逐条提问、候选筛选、模型注入和最终引用明细。",
    today: "今日记录",
    total: "全部记录",
    usageTruth: "检索记录表示候选内容通过授权后被检索到；不等于内容实际注入模型、用于回答或展示为来源。",
    syncEyebrow: "PUBLISHED KNOWLEDGE SYNC",
    syncTitle: "发布知识同步",
    syncDescription: "同步只处理当前代表已生效的发布版本。公开知识条目仍由知识库负责管理。",
    syncUnavailable: "当前发布知识同步不可用。页面不会把未发布草稿标记为已同步。",
    lastSync: "最近同步",
    syncedItems: "已发布项数",
    syncHistory: "最近同步任务",
    syncHistoryEmptyTitle: "暂无同步任务记录",
    syncHistoryEmptyDetail: "完成一次真实同步后，任务状态会显示在这里。",
    never: "尚未完成",
    itemUnit: "项",
    suppress: "停用",
    suppressing: "停用中…",
    delete: "删除",
    deleting: "删除中…",
    retryDelete: "重试清理",
    retryingDelete: "重试中…",
    suppressConfirmation: "停用后，这条记忆将立即停止参与召回。确认继续吗？",
    deleteConfirmation: "删除会立即停止召回，并开始异步物理清理。确认继续吗？",
    memorySuppressed: "记忆已停用，不再参与召回。",
    memoryDeletionStarted: "记忆已停止召回，物理清理已开始。",
    memoryRetryStarted: "已重新提交物理清理任务。",
    memoryActionError: "记忆状态更新失败，请稍后重试。",
    attemptCount: (count: number) => `已尝试清理 ${count} 次`,
  },
  en: {
    eyebrow: "MEMORY SYSTEM / 07",
    title: "A safe, truthful, and reversible memory system.",
    summary: "This page manages governed contact memories for the current representative and reports retrieval and published-knowledge sync honestly. Public knowledge remains in the Knowledge Library.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    knowledge: "Open Knowledge Library",
    settings: "Representative memory settings",
    boundaryTitle: "Long-term memory boundary",
    boundaryRaw: "Raw chats, private Owner notes, and raw Compute outputs never enter long-term memory directly.",
    boundarySensitive: "Credentials, payment amounts, balances, and entitlement facts never enter long-term memory or authorize access.",
    boundaryKnowledge: "Public knowledge comes only from an effective release. Drafts stay in the Knowledge Library and never participate in live retrieval.",
    loadingTitle: "Loading the memory system",
    loadingDetail: "Reading governed memories, retrieval records, and sync state.",
    unavailableTitle: "Memory data is temporarily unavailable",
    unavailableDetail: "This page never substitutes sample numbers for real data. Try again later; public knowledge is still managed in the Knowledge Library.",
    retry: "Retry",
    activeMemories: "Active memories",
    activeMemoriesDetail: "Eligible for safe retrieval",
    inactiveMemories: "Inactive records",
    inactiveMemoriesDetail: "Disabled, being cleaned, or cleared",
    todaySearchRecords: "Retrieval records today",
    todaySearchRecordsDetail: "Retrieval and authorization records only",
    cleanupErrors: "Cleanup errors",
    cleanupErrorsDetail: "Physical cleanup needs a retry",
    recordsEyebrow: "GOVERNED MEMORIES",
    recordsTitle: "Contact memories",
    recordsDescription: "The current API exposes governed contact memories only. Until candidate review, representative experience, and full filtering are connected, this page will not show a fabricated queue.",
    recordsEmptyTitle: "No governed memories yet",
    recordsEmptyDetail: "Raw conversations do not automatically create long-term memory. Only structured content that passes governance appears here.",
    serviceEyebrow: "SERVICE STATUS",
    serviceTitle: "Service and policy status",
    serviceDescription: "Status is read-only here. Change policies in Digital Representative configuration.",
    service: "Memory service",
    projection: "Long-term memory",
    recall: "Automatic recall",
    capture: "Automatic extraction",
    channels: "Channel capability",
    channelsUnavailable: "The current API does not yet expose a Web, Matrix, and Telegram recall/extraction matrix.",
    enabled: "On",
    disabled: "Off",
    available: "Available",
    unavailable: "Unavailable",
    lastUpdated: "Page updated",
    usageEyebrow: "USAGE SUMMARY",
    usageTitle: "Usage summary",
    usageDescription: "Only aggregate safe-retrieval records are available today. Per-question candidates, filtering, model injection, and final citations are not yet exposed.",
    today: "Today",
    total: "All time",
    usageTruth: "A retrieval record means authorized context was found. It does not prove that content was injected into the model, used in the answer, or shown as a source.",
    syncEyebrow: "PUBLISHED KNOWLEDGE SYNC",
    syncTitle: "Published knowledge sync",
    syncDescription: "Sync only processes the current effective release. Public knowledge records remain managed in the Knowledge Library.",
    syncUnavailable: "Published-knowledge sync is currently unavailable. Unreleased drafts are never reported as synced.",
    lastSync: "Latest sync",
    syncedItems: "Released items",
    syncHistory: "Recent sync jobs",
    syncHistoryEmptyTitle: "No sync jobs yet",
    syncHistoryEmptyDetail: "A real job will appear here after a sync runs.",
    never: "Not completed",
    itemUnit: "items",
    suppress: "Disable",
    suppressing: "Disabling…",
    delete: "Delete",
    deleting: "Deleting…",
    retryDelete: "Retry cleanup",
    retryingDelete: "Retrying…",
    suppressConfirmation: "This memory will stop participating in recall immediately. Continue?",
    deleteConfirmation: "Deletion stops recall immediately and starts asynchronous physical cleanup. Continue?",
    memorySuppressed: "Memory disabled and removed from recall.",
    memoryDeletionStarted: "Memory removed from recall; physical cleanup has started.",
    memoryRetryStarted: "Physical cleanup has been submitted again.",
    memoryActionError: "Memory state could not be updated. Try again later.",
    attemptCount: (count: number) => `${count} cleanup attempt${count === 1 ? "" : "s"}`,
  },
} as const;

export function DashboardMemory({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = copy[locale];
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const refresh = useCallback(async (showRefreshState = true) => {
    if (showRefreshState) setRefreshing(true);
    try {
      const nextSnapshot = await fetchMemorySnapshot(representativeSlug);
      setSnapshot(nextSnapshot);
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch {
      setError(t.unavailableDetail);
    } finally {
      setInitialLoading(false);
      if (showRefreshState) setRefreshing(false);
    }
  }, [representativeSlug, t.unavailableDetail]);

  useEffect(() => {
    setSnapshot(null);
    setInitialLoading(true);
    setRefreshing(false);
    setBusyKey(null);
    setError(null);
    setNotice(null);
    setLoadedAt(null);
    void refresh(false);
  }, [refresh]);

  const metrics = useMemo(() => {
    if (!snapshot) return null;
    const active = snapshot.memories.filter((memory) => memory.status === "ACTIVE").length;
    const cleanupErrors = snapshot.memories.filter(
      (memory) => memory.status === "DELETE_FAILED",
    ).length;
    return {
      active,
      inactive: snapshot.memories.length - active,
      today: snapshot.usage.today,
      cleanupErrors,
    };
  }, [snapshot]);

  const knowledgeHref = buildDashboardHref("knowledge", representativeSlug, locale);
  const settingsHref = buildDashboardHref("representatives", representativeSlug, locale);

  async function manageMemory(memory: GovernedMemory, action: MemoryAction) {
    if (action === "suppress" && !window.confirm(t.suppressConfirmation)) return;
    if (action === "delete" && !window.confirm(t.deleteConfirmation)) return;

    const key = `memory:${memory.id}:${action}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/openviking/memories/${memory.id}`,
        action === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action }),
            },
      );
      if (!response.ok) throw new Error(await extractError(response));
      await refresh(false);
      setNotice(
        action === "suppress"
          ? t.memorySuppressed
          : action === "retry"
            ? t.memoryRetryStarted
            : t.memoryDeletionStarted,
      );
    } catch {
      setError(t.memoryActionError);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="memory-system-page">
      <header className="dashboard-v2-page-header memory-system-header">
        <div>
          <p>{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <span>{t.summary}</span>
        </div>
        <div className="memory-system-header-actions" aria-label={locale === "zh" ? "页面操作" : "Page actions"}>
          <button
            className="dashboard-v2-button-secondary"
            disabled={refreshing || busyKey !== null}
            onClick={() => void refresh(true)}
            type="button"
          >
            {refreshing ? t.refreshing : t.refresh}
          </button>
          <Link className="dashboard-v2-button-primary" href={knowledgeHref}>
            {t.knowledge}
          </Link>
        </div>
      </header>

      <section aria-labelledby="memory-system-boundary-title" className="memory-system-boundary">
        <div>
          <span aria-hidden="true">✓</span>
          <strong id="memory-system-boundary-title">{t.boundaryTitle}</strong>
        </div>
        <ul>
          <li>{t.boundaryRaw}</li>
          <li>{t.boundarySensitive}</li>
          <li>{t.boundaryKnowledge}</li>
        </ul>
      </section>

      {notice ? <p className="memory-system-notice" role="status">{notice}</p> : null}
      {error && snapshot ? <p className="memory-system-error" role="alert">{error}</p> : null}

      {initialLoading && !snapshot ? (
        <section className="dashboard-v2-panel memory-system-loading" role="status" aria-live="polite">
          <span className="memory-system-spinner" aria-hidden="true" />
          <div>
            <strong>{t.loadingTitle}</strong>
            <p>{t.loadingDetail}</p>
          </div>
        </section>
      ) : !snapshot ? (
        <section className="dashboard-v2-panel memory-system-unavailable" role="alert">
          <div>
            <strong>{t.unavailableTitle}</strong>
            <p>{error ?? t.unavailableDetail}</p>
          </div>
          <div>
            <button className="dashboard-v2-button-secondary" onClick={() => void refresh(true)} type="button">
              {t.retry}
            </button>
            <Link className="dashboard-v2-button-primary" href={knowledgeHref}>{t.knowledge}</Link>
          </div>
        </section>
      ) : (
        <>
          <section className="dashboard-v2-metric-grid memory-system-metrics" aria-label={locale === "zh" ? "记忆系统指标" : "Memory system metrics"}>
            <MetricCard detail={t.activeMemoriesDetail} label={t.activeMemories} tone="teal" value={metrics?.active ?? 0} />
            <MetricCard detail={t.inactiveMemoriesDetail} label={t.inactiveMemories} tone="default" value={metrics?.inactive ?? 0} />
            <MetricCard detail={t.todaySearchRecordsDetail} label={t.todaySearchRecords} tone="indigo" value={metrics?.today ?? 0} />
            <MetricCard detail={t.cleanupErrorsDetail} label={t.cleanupErrors} tone={metrics?.cleanupErrors ? "warning" : "default"} value={metrics?.cleanupErrors ?? 0} />
          </section>

          <div className="memory-system-primary-grid">
            <section aria-labelledby="memory-system-records-title" className="dashboard-v2-panel memory-system-panel memory-system-records">
              <PanelHeader
                description={t.recordsDescription}
                eyebrow={t.recordsEyebrow}
                id="memory-system-records-title"
                title={t.recordsTitle}
              >
                <span className="memory-system-count">{snapshot.memories.length}</span>
              </PanelHeader>

              {snapshot.memories.length ? (
                <div className="memory-system-record-list">
                  {snapshot.memories.map((memory) => {
                    const suppressKey = `memory:${memory.id}:suppress`;
                    const deleteKey = `memory:${memory.id}:delete`;
                    const retryKey = `memory:${memory.id}:retry`;
                    return (
                      <article key={memory.id}>
                        <div className="memory-system-record-copy">
                          <div>
                            <strong>{normalizeContactName(memory.contactDisplayLabel, locale)}</strong>
                            <span className={`memory-system-status is-${memory.status.toLowerCase()}`}>
                              {memoryStatusLabel(memory.status, locale)}
                            </span>
                          </div>
                          <p>{memory.summary || memoryEmptySummary(memory.status, locale)}</p>
                          <small>
                            {formatDate(memory.createdAt, locale)}
                            {memory.status === "DELETE_FAILED" && memory.actionAttemptCount > 0
                              ? ` · ${t.attemptCount(memory.actionAttemptCount)}`
                              : ""}
                          </small>
                        </div>
                        <div className="memory-system-record-actions">
                          {memory.status === "ACTIVE" ? (
                            <button
                              className="dashboard-v2-button-secondary"
                              disabled={busyKey !== null}
                              onClick={() => void manageMemory(memory, "suppress")}
                              type="button"
                            >
                              {busyKey === suppressKey ? t.suppressing : t.suppress}
                            </button>
                          ) : null}
                          {memory.status === "ACTIVE" || memory.status === "SUPPRESSED" ? (
                            <button
                              className="dashboard-v2-button-secondary memory-system-delete-button"
                              disabled={busyKey !== null}
                              onClick={() => void manageMemory(memory, "delete")}
                              type="button"
                            >
                              {busyKey === deleteKey ? t.deleting : t.delete}
                            </button>
                          ) : null}
                          {memory.status === "DELETE_FAILED" ? (
                            <button
                              className="dashboard-v2-button-secondary"
                              disabled={busyKey !== null}
                              onClick={() => void manageMemory(memory, "retry")}
                              type="button"
                            >
                              {busyKey === retryKey ? t.retryingDelete : t.retryDelete}
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyState detail={t.recordsEmptyDetail} title={t.recordsEmptyTitle} />
              )}
            </section>

            <section aria-labelledby="memory-system-service-title" className="dashboard-v2-panel memory-system-panel">
              <PanelHeader
                description={t.serviceDescription}
                eyebrow={t.serviceEyebrow}
                id="memory-system-service-title"
                title={t.serviceTitle}
              />
              <dl className="memory-system-status-list">
                <StatusRow
                  label={t.service}
                  tone={snapshot.settings.serviceStatus === "available" ? "success" : "muted"}
                  value={serviceStatusLabel(snapshot.settings.serviceStatus, locale)}
                />
                <StatusRow label={t.projection} tone={snapshot.settings.enabled ? "success" : "muted"} value={snapshot.settings.enabled ? t.enabled : t.disabled} />
                <StatusRow label={t.recall} tone={snapshot.settings.autoRecall ? "success" : "muted"} value={snapshot.settings.autoRecall ? t.enabled : t.disabled} />
                <StatusRow label={t.capture} tone="muted" value={snapshot.settings.autoCapture ? t.enabled : t.disabled} />
                <StatusRow label={t.channels} tone="warning" value={t.unavailable} />
                <StatusRow label={t.lastUpdated} tone="muted" value={loadedAt ? formatDate(loadedAt, locale) : t.never} />
              </dl>
              <p className="memory-system-honesty-note">{t.channelsUnavailable}</p>
              <Link className="dashboard-v2-button-secondary memory-system-settings-link" href={settingsHref}>
                {t.settings}
              </Link>
            </section>
          </div>

          <div className="memory-system-secondary-grid">
            <section aria-labelledby="memory-system-usage-title" className="dashboard-v2-panel memory-system-panel">
              <PanelHeader
                description={t.usageDescription}
                eyebrow={t.usageEyebrow}
                id="memory-system-usage-title"
                title={t.usageTitle}
              />
              <dl className="memory-system-usage-values">
                <div><dt>{t.today}</dt><dd>{formatCount(snapshot.usage.today)}</dd></div>
                <div><dt>{t.total}</dt><dd>{formatCount(snapshot.usage.total)}</dd></div>
              </dl>
              <p className="memory-system-honesty-note is-indigo">{t.usageTruth}</p>
            </section>

            <section aria-labelledby="memory-system-sync-title" className="dashboard-v2-panel memory-system-panel">
              <PanelHeader
                description={t.syncDescription}
                eyebrow={t.syncEyebrow}
                id="memory-system-sync-title"
                title={t.syncTitle}
              >
                <Link className="dashboard-v2-button-secondary" href={knowledgeHref}>
                  {t.knowledge}
                </Link>
              </PanelHeader>

              <dl className="memory-system-sync-summary">
                <StatusRow
                  label={t.lastSync}
                  tone={syncTone(snapshot.settings.lastSyncStatus)}
                  value={getGovernedContextSyncPresentation(snapshot.settings.lastSyncStatus, locale).label}
                />
                <StatusRow label={t.syncedItems} tone="muted" value={`${formatCount(snapshot.settings.lastSyncItemCount)} ${t.itemUnit}`} />
                <StatusRow label={t.lastUpdated} tone="muted" value={snapshot.settings.lastSyncAt ? formatDate(snapshot.settings.lastSyncAt, locale) : t.never} />
              </dl>

              {!snapshot.settings.publicKnowledgeSyncAvailable ? (
                <p className="memory-system-honesty-note is-warning">{t.syncUnavailable}</p>
              ) : null}

              <div className="memory-system-sync-history">
                <strong>{t.syncHistory}</strong>
                {snapshot.settings.recentSyncJobs.length ? (
                  <ul>
                    {snapshot.settings.recentSyncJobs.slice(0, 6).map((job, index) => {
                      const presentation = getGovernedContextSyncPresentation(job.status, locale);
                      return (
                        <li key={`${job.startedAt}:${index}`}>
                          <div>
                            <span className={`memory-system-status is-${syncTone(job.status)}`}>{presentation.label}</span>
                            <small>{formatDate(job.startedAt, locale)}</small>
                          </div>
                          <strong>{formatCount(job.itemCount)} {t.itemUnit}</strong>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState detail={t.syncHistoryEmptyDetail} title={t.syncHistoryEmptyTitle} />
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({
  detail,
  label,
  tone,
  value,
}: {
  detail: string;
  label: string;
  tone: "default" | "teal" | "indigo" | "warning";
  value: number;
}) {
  return (
    <article className={`dashboard-v2-metric-card is-${tone}`}>
      <div><span>{label}</span><i /></div>
      <strong>{formatCount(value)}</strong>
      <p>{detail}</p>
    </article>
  );
}

function PanelHeader({
  children,
  description,
  eyebrow,
  id,
  title,
}: {
  children?: ReactNode;
  description: string;
  eyebrow: string;
  id: string;
  title: string;
}) {
  return (
    <header className="memory-system-panel-header">
      <div>
        <p>{eyebrow}</p>
        <h2 id={id}>{title}</h2>
        <span>{description}</span>
      </div>
      {children}
    </header>
  );
}

function StatusRow({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "success" | "warning" | "muted";
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`is-${tone}`}>{value}</dd>
    </div>
  );
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="memory-system-empty">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

async function fetchMemorySnapshot(representativeSlug: string): Promise<MemorySnapshot> {
  const root = `/api/dashboard/representatives/${representativeSlug}/openviking`;
  const [settingsResponse, memoriesResponse, usageResponse] = await Promise.all([
    fetch(root, { cache: "no-store" }),
    fetch(`${root}/memories`, { cache: "no-store" }),
    fetch(`${root}/recall-traces`, { cache: "no-store" }),
  ]);
  if (!settingsResponse.ok || !memoriesResponse.ok || !usageResponse.ok) {
    throw new Error("Memory data is unavailable.");
  }

  const settings = await settingsResponse.json() as GovernedContextSettings;
  const memoryBody = await memoriesResponse.json() as { memories?: GovernedMemory[] };
  const usageBody = await usageResponse.json() as { usage?: Partial<RecallUsage> };
  return {
    settings: {
      ...settings,
      recentSyncJobs: Array.isArray(settings.recentSyncJobs) ? settings.recentSyncJobs : [],
    },
    memories: Array.isArray(memoryBody.memories) ? memoryBody.memories : [],
    usage: {
      today: normalizeCount(usageBody.usage?.today),
      total: normalizeCount(usageBody.usage?.total),
    },
  };
}

async function extractError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

function buildDashboardHref(view: "knowledge" | "representatives", slug: string, locale: Locale) {
  const query = new URLSearchParams({ view, rep: slug, lang: locale });
  return `/dashboard?${query.toString()}`;
}

function normalizeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(Math.max(0, value));
}

function normalizeContactName(value: string, locale: Locale) {
  const normalized = value.trim();
  if (/^web visitor$/i.test(normalized) || /^unknown audience$/i.test(normalized)) {
    return locale === "zh" ? "匿名访客" : "Anonymous visitor";
  }
  return normalized || (locale === "zh" ? "匿名访客" : "Anonymous visitor");
}

function formatDate(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function memoryStatusLabel(status: GovernedMemoryStatus, locale: Locale) {
  const labels = locale === "zh"
    ? {
        ACTIVE: "有效",
        SUPPRESSED: "已停用",
        DELETE_PENDING: "清理中",
        DELETED: "已清理",
        DELETE_FAILED: "清理异常",
      }
    : {
        ACTIVE: "Active",
        SUPPRESSED: "Disabled",
        DELETE_PENDING: "Cleaning",
        DELETED: "Cleared",
        DELETE_FAILED: "Cleanup failed",
      };
  return labels[status];
}

function memoryEmptySummary(status: GovernedMemoryStatus, locale: Locale) {
  if (status === "DELETE_PENDING" || status === "DELETE_FAILED" || status === "DELETED") {
    return locale === "zh"
      ? "正文已从控制台清除，不再参与召回。"
      : "Content has been cleared from the console and no longer participates in recall.";
  }
  return locale === "zh" ? "没有可显示的安全摘要。" : "No safe summary is available.";
}

function serviceStatusLabel(status: MemoryServiceStatus, locale: Locale) {
  if (locale === "zh") {
    return status === "available" ? "可用" : status === "disabled" ? "已关闭" : "不可用";
  }
  return status === "available" ? "Available" : status === "disabled" ? "Off" : "Unavailable";
}

function syncTone(status: string): "success" | "warning" | "muted" {
  const outcome = getGovernedContextSyncPresentation(status, "en").outcome;
  if (outcome === "success") return "success";
  if (outcome === "failed" || outcome === "attention_required" || outcome.startsWith("blocked_")) {
    return "warning";
  }
  return "muted";
}
