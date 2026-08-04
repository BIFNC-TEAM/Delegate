"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Locale } from "@delegate/web-ui";

import {
  executeMemoryAction,
  loadMemoryEntries,
  loadMemoryOperations,
  loadMemoryOverview,
  loadMemoryReconciliation,
  loadMemoryUsage,
  type MemoryEntriesResponse,
  type MemoryEntry,
  type MemoryOperation,
  type MemoryOperationsResponse,
  type MemoryOverview,
  type MemoryReconciliationRun,
  type MemoryReconciliationResponse,
  type MemorySection,
  type MemoryUsageResponse,
  type MemoryUseRun,
} from "./dashboard-memory-api";

type LoadedSection =
  | { requestKey: string; section: "overview"; overview: MemoryOverview }
  | { requestKey: string; section: "entries"; entries: MemoryEntriesResponse }
  | { requestKey: string; section: "usage"; usage: MemoryUsageResponse }
  | {
      requestKey: string;
      section: "operations";
      operations: MemoryOperationsResponse | null;
      operationsError: boolean;
      reconciliation: MemoryReconciliationResponse | null;
      reconciliationError: boolean;
    };

export type EntryCommand =
  | "approve_candidate"
  | "reject_candidate"
  | "block_candidate"
  | "request_correction"
  | "suppress_memory"
  | "archive_memory"
  | "restore_memory"
  | "request_deletion"
  | "retry_cleanup";

type OperationRetryCommand =
  | "retry_cleanup"
  | "retry_projection"
  | "retry_extraction";

const sections: MemorySection[] = ["overview", "entries", "usage", "operations"];

const copy = {
  zh: {
    eyebrow: "MEMORY SYSTEM / 07",
    title: "记忆系统",
    summary: "管理受治理的联系人记忆与代表经验，并核对它们是否真正进入回答。",
    refresh: "刷新",
    refreshing: "刷新中…",
    knowledge: "打开知识库",
    settings: "代表记忆设置",
    sectionLabels: {
      overview: "总览",
      entries: "记忆条目",
      usage: "使用记录",
      operations: "提取与同步",
    },
    boundaryTitle: "安全边界",
    boundary: "原始聊天、Owner 私有备注、Compute / Tool 原始产物、凭据、支付金额、余额、退款与权益事实不会直接进入长期记忆。",
    loading: "正在读取真实记忆数据",
    unavailable: "记忆数据暂时不可用",
    unavailableDetail: "页面不会用示例数据替代真实结果。请稍后重试。",
    retry: "重试",
    emptyTitle: "没有符合条件的记录",
    emptyDetail: "调整筛选条件，或等待真实业务数据产生后再查看。",
    overviewTitle: "当前代表的记忆健康度",
    overviewDetail: "搜索命中、模型注入、模型引用和最终展示分别计数。",
    effective: "有效记忆",
    pending: "待审核候选",
    usedToday: "今日实际用于回答",
    injectedToday: "今日注入模型",
    citedToday: "今日模型引用",
    displayedToday: "今日最终展示",
    anomalies: "同步或清理异常",
    searchToday: "今日搜索命中",
    serviceTitle: "服务状态",
    serviceEnabled: "长期记忆",
    serviceHealth: "Provider 健康度",
    lastUpdated: "最后更新时间",
    healthy: "正常",
    attention: "需要关注",
    enabled: "已启用",
    disabled: "已关闭",
    unavailableStatus: "不可用",
    channelTitle: "渠道能力",
    channelDetail: "“支持”表示运行时具备能力；“启用”表示当前代表策略已开启。",
    recall: "召回",
    extraction: "提取",
    supportedEnabled: "支持 · 已启用",
    supportedDisabled: "支持 · 未启用",
    unsupported: "暂不支持",
    publicKnowledgeTitle: "公开知识",
    publicKnowledgeDetail: "公开知识继续由知识库创建、编辑、绑定和发布；这里仅显示线上投影健康。",
    projectedItems: "已投影发布项",
    lastProjected: "最近投影",
    noPublishedProjection: "当前没有可报告的发布知识投影。",
    entriesTitle: "联系人记忆与代表经验",
    entriesDetail: "候选和正式记忆共用一套可追溯治理视图。",
    search: "搜索安全摘要",
    type: "对象类型",
    all: "全部",
    contactMemory: "联系人记忆",
    representativeExperience: "代表经验",
    contact: "联系人 ID",
    status: "状态",
    category: "类别",
    source: "来源",
    channel: "渠道",
    from: "开始时间",
    to: "结束时间",
    applyFilters: "应用筛选",
    clearFilters: "清除筛选",
    currentRepresentative: "当前代表",
    entrySummary: "安全摘要",
    updated: "更新于",
    expires: "到期于",
    lastUsed: "最近使用",
    neverUsed: "尚未用于回答",
    detailTitle: "条目详情",
    closeDetail: "关闭详情",
    extractionReason: "提取原因",
    safetyDecision: "安全判断",
    sourceConversation: "来源会话",
    openInbox: "在 Inbox 查看",
    reviewHistory: "审核记录",
    noReview: "暂无审核记录",
    recentUseTitle: "最近用于回答",
    noRecentUse: "尚无实际注入记录",
    reviewNote: "审核说明（可选）",
    correctionTitle: "纠正并创建新版本",
    correctionField: "纠正字段",
    correctionValue: "新值",
    correctionPattern: "代表经验模式",
    submitCorrection: "提交纠正",
    advanced: "高级诊断",
    advancedDetail: "仅展示业务版本和清理状态；其余内部检索诊断与提问正文不在 Dashboard 暴露。",
    version: "业务版本",
    projection: "清理任务",
    projected: "已完成",
    notProjected: "尚无清理任务",
    approve: "批准",
    reject: "拒绝",
    block: "阻止",
    suppress: "停用",
    archive: "归档",
    restore: "恢复",
    permanentDelete: "永久删除",
    retryCleanup: "重试清理",
    actionRunning: "处理中…",
    actionSuccess: "治理动作已提交，页面已刷新。",
    actionFailed: "治理动作失败，请重新读取最新状态后再试。",
    confirmSuppress: "停用后将立即停止新召回。确认继续吗？",
    confirmArchive: "归档后将停止召回，但可以恢复。确认继续吗？",
    confirmDelete: "永久删除会立即停止召回，并异步清理物理投影。确认继续吗？",
    confirmApprove: "批准后，该候选将获得线上召回资格。确认批准吗？",
    confirmReject: "拒绝后，该候选不会进入长期记忆。确认拒绝吗？",
    confirmBlock: "阻止后，该候选会留在安全隔离记录中且不能召回。确认阻止吗？",
    confirmCorrection: "纠正会创建新版本，旧版本将立即停止召回。确认提交吗？",
    confirmRestore: "恢复后，该记忆将重新获得召回资格。确认恢复吗？",
    usageTitle: "一次提问，一条完整使用记录",
    usageDetail: "只把真正进入 Prompt 的内容计为用于回答；最终展示来源必须来自已注入集合。",
    usageStatus: "运行状态",
    sourceKind: "使用来源",
    question: "触发提问",
    questionProtected: "提问正文不在记忆控制台展示",
    searched: "搜索命中",
    scopeAllowed: "作用域通过",
    safetyAllowed: "安全检查通过",
    injected: "注入模型",
    outputSources: "回答来源",
    modelCited: "模型引用",
    publiclyDisplayed: "最终展示",
    usageSources: "来源类型",
    candidateStages: "候选阶段明细",
    passed: "通过",
    notPassed: "未通过",
    noSources: "没有内容进入回答",
    operationsTitle: "提取、投影、清理与对账",
    operationsDetail: "部分失败保留成功项；只对失败项执行幂等重试。Postgres 始终是业务真相。",
    operationsList: "提取与同步任务",
    reconciliationList: "库存对账",
    reconciliationDetail: "对账详情",
    viewDetail: "查看详情",
    operationKind: "任务类型",
    started: "开始时间",
    finished: "完成时间",
    candidates: "候选",
    accepted: "接受",
    rejectedCount: "拒绝",
    succeeded: "成功",
    failed: "失败",
    attempts: "尝试次数",
    verified: "已验证发布项",
    staging: "暂存区",
    liveRecall: "线上召回",
    operationAttention: "任务报告了可治理异常；内部错误细节不会在页面显示。",
    partialSuccessNote: "本次同步部分成功，成功项已保留，失败项可独立重试。",
    reasons: "原因",
    retryItem: "重试失败项",
    operationUnavailable: "提取与同步任务暂时不可用，但库存对账仍可继续显示。",
    reconciliationUnavailable: "库存对账暂时不可用，但提取与同步任务仍可继续显示。",
    reconcileNow: "发起对账",
    reconcileQueued: "对账任务已提交。",
    reconcileFailed: "无法发起对账，请刷新后重试。",
    partialInventory: "当前 Provider 不提供可证明完整且稳定的库存快照，因此对账只能报告已知精确投影，状态会如实标为部分覆盖。",
    checked: "已检查",
    observed: "已观察",
    matched: "一致",
    issues: "异常",
    resolved: "已解决",
    missing: "缺失",
    stale: "过期",
    firstPage: "返回第一页",
    nextPage: "下一页",
    pageAsOf: "列表快照",
  },
  en: {
    eyebrow: "MEMORY SYSTEM / 07",
    title: "Memory System",
    summary: "Manage governed Contact Memory and Representative Experience, and verify what actually entered an answer.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    knowledge: "Open Knowledge Library",
    settings: "Representative memory settings",
    sectionLabels: {
      overview: "Overview",
      entries: "Memory entries",
      usage: "Usage records",
      operations: "Extraction & sync",
    },
    boundaryTitle: "Safety boundary",
    boundary: "Raw chats, private Owner notes, raw Compute / Tool output, credentials, payment amounts, balances, refunds, and entitlement facts never enter long-term memory directly.",
    loading: "Loading live memory data",
    unavailable: "Memory data is temporarily unavailable",
    unavailableDetail: "This page never substitutes sample data for live results. Try again later.",
    retry: "Retry",
    emptyTitle: "No matching records",
    emptyDetail: "Change the filters or return after real business activity creates records.",
    overviewTitle: "Memory health for this representative",
    overviewDetail: "Search hits, model injection, model citation, and final display are counted separately.",
    effective: "Active memories",
    pending: "Pending candidates",
    usedToday: "Answers using memory today",
    injectedToday: "Injected today",
    citedToday: "Cited by model today",
    displayedToday: "Displayed today",
    anomalies: "Sync or cleanup errors",
    searchToday: "Search hits today",
    serviceTitle: "Service status",
    serviceEnabled: "Long-term memory",
    serviceHealth: "Provider health",
    lastUpdated: "Last updated",
    healthy: "Healthy",
    attention: "Needs attention",
    enabled: "Enabled",
    disabled: "Off",
    unavailableStatus: "Unavailable",
    channelTitle: "Channel capability",
    channelDetail: "“Supported” is runtime capability; “enabled” is the current representative policy.",
    recall: "Recall",
    extraction: "Extraction",
    supportedEnabled: "Supported · enabled",
    supportedDisabled: "Supported · off",
    unsupported: "Not supported",
    publicKnowledgeTitle: "Public knowledge",
    publicKnowledgeDetail: "Public knowledge remains created, edited, bound, and published in the Knowledge Library. This page only reports its live projection health.",
    projectedItems: "Published items projected",
    lastProjected: "Last projection",
    noPublishedProjection: "No published knowledge projection can currently be reported.",
    entriesTitle: "Contact Memory and Representative Experience",
    entriesDetail: "Candidates and governed memories share one traceable governance view.",
    search: "Search safe summaries",
    type: "Object type",
    all: "All",
    contactMemory: "Contact Memory",
    representativeExperience: "Representative Experience",
    contact: "Contact ID",
    status: "Status",
    category: "Category",
    source: "Source",
    channel: "Channel",
    from: "From",
    to: "To",
    applyFilters: "Apply filters",
    clearFilters: "Clear filters",
    currentRepresentative: "Current representative",
    entrySummary: "Safe summary",
    updated: "Updated",
    expires: "Expires",
    lastUsed: "Last used",
    neverUsed: "Not used in an answer yet",
    detailTitle: "Entry details",
    closeDetail: "Close details",
    extractionReason: "Extraction reason",
    safetyDecision: "Safety decision",
    sourceConversation: "Source conversation",
    openInbox: "Open in Inbox",
    reviewHistory: "Review history",
    noReview: "No review history",
    recentUseTitle: "Recent answer use",
    noRecentUse: "No actual injection record yet",
    reviewNote: "Review note (optional)",
    correctionTitle: "Correct and create a new version",
    correctionField: "Field to correct",
    correctionValue: "New value",
    correctionPattern: "Experience pattern",
    submitCorrection: "Submit correction",
    advanced: "Advanced diagnostics",
    advancedDetail: "Only business version and cleanup state are shown. Other internal retrieval diagnostics and question text are never exposed in Dashboard.",
    version: "Business version",
    projection: "Cleanup job",
    projected: "Completed",
    notProjected: "No cleanup job",
    approve: "Approve",
    reject: "Reject",
    block: "Block",
    suppress: "Disable",
    archive: "Archive",
    restore: "Restore",
    permanentDelete: "Permanently delete",
    retryCleanup: "Retry cleanup",
    actionRunning: "Working…",
    actionSuccess: "The governance action was submitted and the page refreshed.",
    actionFailed: "The action failed. Reload the latest state and try again.",
    confirmSuppress: "This immediately blocks new recall. Continue?",
    confirmArchive: "Archiving blocks recall but remains reversible. Continue?",
    confirmDelete: "Permanent deletion immediately blocks recall and asynchronously cleans the physical projection. Continue?",
    confirmApprove: "Approval makes this candidate eligible for live recall. Approve it?",
    confirmReject: "Rejection prevents this candidate from entering long-term memory. Reject it?",
    confirmBlock: "Blocking keeps this candidate in the safety record and prevents recall. Block it?",
    confirmCorrection: "Correction creates a new version and immediately stops recall of the old version. Submit it?",
    confirmRestore: "Restoring makes this memory eligible for recall again. Restore it?",
    usageTitle: "One question, one complete usage record",
    usageDetail: "Only content that actually entered the prompt counts as used. Displayed sources must be a subset of injected context.",
    usageStatus: "Run status",
    sourceKind: "Source kind",
    question: "Triggering question",
    questionProtected: "Question text is not displayed in the memory console",
    searched: "Search hits",
    scopeAllowed: "Scope allowed",
    safetyAllowed: "Safety allowed",
    injected: "Injected",
    outputSources: "Answer sources",
    modelCited: "Model cited",
    publiclyDisplayed: "Displayed",
    usageSources: "Source types",
    candidateStages: "Candidate stage details",
    passed: "Passed",
    notPassed: "Not passed",
    noSources: "No memory entered the answer",
    operationsTitle: "Extraction, projection, cleanup, and reconciliation",
    operationsDetail: "Partial failures preserve successful items and retry only failed items idempotently. Postgres remains the business truth.",
    operationsList: "Extraction and sync jobs",
    reconciliationList: "Inventory reconciliation",
    reconciliationDetail: "Reconciliation details",
    viewDetail: "View details",
    operationKind: "Job type",
    started: "Started",
    finished: "Finished",
    candidates: "Candidates",
    accepted: "Accepted",
    rejectedCount: "Rejected",
    succeeded: "Succeeded",
    failed: "Failed",
    attempts: "Attempts",
    verified: "Published items verified",
    staging: "Staging",
    liveRecall: "Live recall",
    operationAttention: "The job reported a governable exception. Internal error details are not shown here.",
    partialSuccessNote: "This sync partially succeeded. Successful items were preserved and failed items remain independently retryable.",
    reasons: "Reasons",
    retryItem: "Retry failed item",
    operationUnavailable: "Extraction and sync jobs are unavailable, but reconciliation can still be shown.",
    reconciliationUnavailable: "Inventory reconciliation is unavailable, but extraction and sync jobs can still be shown.",
    reconcileNow: "Start reconciliation",
    reconcileQueued: "Reconciliation was queued.",
    reconcileFailed: "Reconciliation could not be queued. Refresh and try again.",
    partialInventory: "The current Provider does not expose a provably complete and stable inventory snapshot, so reconciliation covers known exact projections only and reports partial coverage honestly.",
    checked: "Checked",
    observed: "Observed",
    matched: "Matched",
    issues: "Issues",
    resolved: "Resolved",
    missing: "Missing",
    stale: "Stale",
    firstPage: "Back to first page",
    nextPage: "Next page",
    pageAsOf: "List snapshot",
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const section = parseSection(searchParams.get("section"));
  const [loaded, setLoaded] = useState<LoadedSection | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams(searchKey);
    const allowed = section === "entries"
      ? ["kind", "entryId", "contactId", "scope", "category", "status", "source", "channel", "from", "to", "query", "asOf", "cursor", "limit"]
      : section === "usage"
        ? ["contactId", "conversationId", "messageId", "channel", "status", "sourceKind", "from", "to", "asOf", "cursor", "limit"]
        : section === "operations"
          ? [
              "kind", "status", "channel", "from", "to", "asOf", "cursor", "limit", "runId",
              "reconciliationCursor", "reconciliationAsOf", "reconciliationLimit",
              "reconciliationItemCursor", "reconciliationItemLimit",
            ]
          : [];
    return Object.fromEntries(allowed.flatMap((key) => {
      const value = params.get(key)?.trim();
      return value ? [[key, value]] : [];
    }));
  }, [searchKey, section]);

  const requestKey = `${representativeSlug}:${section}:${searchKey}:${refreshVersion}`;
  const currentLoaded = currentMemoryRequest(loaded, requestKey);

  const reload = useCallback(() => {
    setRefreshVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setLoading(true);
    setLoadError(null);
    const run = async () => {
      try {
        const next: LoadedSection = section === "overview"
          ? {
              requestKey,
              section,
              overview: await loadMemoryOverview(representativeSlug, controller.signal),
            }
          : section === "entries"
            ? {
                requestKey,
                section,
                entries: await loadMemoryEntries(representativeSlug, query, controller.signal),
              }
            : section === "usage"
              ? {
                  requestKey,
                  section,
                  usage: await loadMemoryUsage(representativeSlug, query, controller.signal),
                }
              : await loadOperationsSection(
                  representativeSlug,
                  query,
                  requestKey,
                  controller.signal,
                );
        if (!controller.signal.aborted) setLoaded(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoaded(null);
          setLoadError(t.unavailableDetail);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [query, requestKey, representativeSlug, section, t.unavailableDetail]);

  const refresh = () => {
    setRefreshing(true);
    setNotice(null);
    reload();
  };
  const knowledgeHref = buildDashboardHref("knowledge", representativeSlug, locale);
  const settingsHref = buildDashboardHref("representatives", representativeSlug, locale, { section: "memory" });

  return (
    <div className="memory-system-page">
      <header className="dashboard-v2-page-header memory-system-header">
        <div>
          <p>{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <span>{t.summary}</span>
        </div>
        <div className="memory-system-header-actions" aria-label={locale === "zh" ? "页面操作" : "Page actions"}>
          <button className="dashboard-v2-button-secondary" disabled={refreshing} onClick={refresh} type="button">
            {refreshing ? t.refreshing : t.refresh}
          </button>
          <Link className="dashboard-v2-button-primary" href={knowledgeHref}>{t.knowledge}</Link>
        </div>
      </header>

      <nav className="memory-system-section-nav" aria-label={locale === "zh" ? "记忆系统页面" : "Memory System pages"}>
        {sections.map((item) => (
          <Link
            aria-current={section === item ? "page" : undefined}
            href={buildMemoryHref(pathname, searchParams, { section: item, resetList: true })}
            key={item}
          >
            {t.sectionLabels[item]}
          </Link>
        ))}
      </nav>

      <aside className="memory-system-boundary" aria-labelledby="memory-system-boundary-title">
        <strong id="memory-system-boundary-title">{t.boundaryTitle}</strong>
        <p>{t.boundary}</p>
      </aside>

      {notice ? <p className="memory-system-notice" role="status">{notice}</p> : null}
      {loading || (!loadError && !currentLoaded) ? (
        <LoadingState label={t.loading} />
      ) : loadError ? (
        <UnavailableState detail={t.unavailableDetail} retry={t.retry} title={t.unavailable} onRetry={refresh} />
      ) : currentLoaded?.section === "overview" ? (
        <OverviewSection locale={locale} overview={currentLoaded.overview} settingsHref={settingsHref} />
      ) : currentLoaded?.section === "entries" ? (
        <EntriesSection
          data={currentLoaded.entries}
          locale={locale}
          pathname={pathname}
          representativeSlug={representativeSlug}
          searchParams={searchParams}
          setNotice={setNotice}
          reload={reload}
        />
      ) : currentLoaded?.section === "usage" ? (
        <UsageSection data={currentLoaded.usage} locale={locale} pathname={pathname} searchParams={searchParams} />
      ) : currentLoaded?.section === "operations" ? (
        <OperationsSection
          data={currentLoaded.operations}
          dataError={currentLoaded.operationsError}
          locale={locale}
          pathname={pathname}
          reconciliation={currentLoaded.reconciliation}
          reconciliationError={currentLoaded.reconciliationError}
          representativeSlug={representativeSlug}
          searchParams={searchParams}
          setNotice={setNotice}
          reload={reload}
        />
      ) : null}
    </div>
  );
}

function OverviewSection({
  locale,
  overview,
  settingsHref,
}: {
  locale: Locale;
  overview: MemoryOverview;
  settingsHref: string;
}) {
  const t = copy[locale];
  const today = overview.metrics.today;
  const channels = ["web", "matrix", "telegram"] as const;
  return (
    <>
      <section aria-labelledby="memory-overview-title">
        <SectionHeader description={t.overviewDetail} id="memory-overview-title" title={t.overviewTitle} />
        <div className="memory-system-metrics">
          <MetricCard label={t.effective} tone="teal" value={overview.metrics.effectiveMemories} />
          <MetricCard label={t.pending} tone="indigo" value={overview.metrics.pendingCandidates} />
          <MetricCard label={t.searchToday} tone="default" value={today.searchHits} />
          <MetricCard label={t.injectedToday} tone="teal" value={today.injectedIntoModel} />
          <MetricCard label={t.citedToday} tone="indigo" value={today.citedByModel} />
          <MetricCard label={t.displayedToday} tone="default" value={today.displayedSources} />
          <MetricCard label={t.usedToday} tone="teal" value={today.answersUsingMemory} />
          <MetricCard label={t.anomalies} tone={overview.metrics.anomalies.total > 0 ? "warning" : "default"} value={overview.metrics.anomalies.total} />
        </div>
      </section>

      <div className="memory-system-overview-grid">
        <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-service-title">
          <SectionHeader description={overview.representative.displayName} id="memory-service-title" title={t.serviceTitle} />
          <dl className="memory-system-status-list">
            <StatusRow label={t.serviceEnabled} tone={overview.service.enabled ? "success" : "muted"} value={overview.service.enabled ? t.enabled : t.disabled} />
            <StatusRow label={t.serviceHealth} tone={overview.service.requiresAttention || !["healthy", "available"].includes(overview.service.status.toLowerCase()) ? "error" : "success"} value={overview.service.requiresAttention ? t.attention : statusLabel(overview.service.status, locale)} />
            <StatusRow label={t.lastUpdated} tone="muted" value={formatDateOrUnavailable(overview.service.lastUpdatedAt, locale)} />
          </dl>
          <Link className="dashboard-v2-button-secondary memory-system-inline-link" href={settingsHref}>{t.settings}</Link>
        </section>

        <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-channel-title">
          <SectionHeader description={t.channelDetail} id="memory-channel-title" title={t.channelTitle} />
          <div className="memory-system-table-wrap">
            <table className="memory-system-channel-table">
              <thead><tr><th>{t.channel}</th><th>{t.recall}</th><th>{t.extraction}</th></tr></thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel}>
                    <th><ChannelBadge channel={channel.toUpperCase()} /></th>
                    <td>{capabilityLabel(overview.channels[channel].recallSupported, overview.channels[channel].recallEnabled, locale)}</td>
                    <td>{capabilityLabel(overview.channels[channel].extractionSupported, overview.channels[channel].extractionEnabled, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="dashboard-v2-panel memory-system-panel memory-system-knowledge-card" aria-labelledby="memory-public-knowledge-title">
        <SectionHeader description={t.publicKnowledgeDetail} id="memory-public-knowledge-title" title={t.publicKnowledgeTitle} />
        <dl>
          <div><dt>{t.projectedItems}</dt><dd>{formatCount(overview.publicKnowledge.projectedItemCount)}</dd></div>
          <div><dt>{t.lastProjected}</dt><dd>{formatDateOrUnavailable(overview.publicKnowledge.lastProjectedAt, locale)}</dd></div>
        </dl>
        {overview.publicKnowledge.projectedItemCount === 0 ? <p>{t.noPublishedProjection}</p> : null}
        <Link className="dashboard-v2-button-primary" href={overview.publicKnowledge.knowledgeLibraryHref}>{t.knowledge}</Link>
      </section>
    </>
  );
}

function EntriesSection({
  data,
  locale,
  pathname,
  representativeSlug,
  searchParams,
  setNotice,
  reload,
}: {
  data: MemoryEntriesResponse;
  locale: Locale;
  pathname: string;
  representativeSlug: string;
  searchParams: ReadonlyURLSearchParams;
  setNotice: (notice: string | null) => void;
  reload: () => void;
}) {
  const t = copy[locale];
  const selected = data.detail ?? data.items.find((item) => item.id === searchParams.get("entryId")) ?? null;
  return (
    <>
      <SectionHeader description={t.entriesDetail} id="memory-entries-title" title={t.entriesTitle} />
      <MemoryFilterForm key={`entries:${searchParams.toString()}`} locale={locale} pathname={pathname} representative={data.representative.displayName} representativeSlug={data.representative.slug} searchParams={searchParams} section="entries" />
      <div className={`memory-system-list-layout${selected ? " has-detail" : ""}`}>
        <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-entry-list-title">
          <h2 className="memory-system-visually-hidden" id="memory-entry-list-title">{t.entriesTitle}</h2>
          {data.items.length ? (
            <div className="memory-system-record-list">
              {data.items.map((entry) => (
                <EntryRow entry={entry} href={buildMemoryHref(pathname, searchParams, { entryId: entry.id })} key={entry.id} locale={locale} selected={selected?.id === entry.id} />
              ))}
            </div>
          ) : <EmptyState detail={t.emptyDetail} title={t.emptyTitle} />}
          <Pagination locale={locale} page={data.page} pathname={pathname} searchParams={searchParams} />
        </section>
        {selected ? (
          <EntryDetail
            closeHref={buildMemoryHref(pathname, searchParams, { entryId: null })}
            entry={selected}
            locale={locale}
            representativeName={data.representative.displayName}
            representativeSlug={representativeSlug}
            reload={reload}
            setNotice={setNotice}
          />
        ) : null}
      </div>
    </>
  );
}

function EntryRow({ entry, href, locale, selected }: { entry: MemoryEntry; href: string; locale: Locale; selected: boolean }) {
  const t = copy[locale];
  return (
    <article className={selected ? "is-selected" : undefined}>
      <div className="memory-system-record-heading">
        <div>
          <TypeBadge entry={entry} locale={locale} />
          <StatusBadge status={entry.status} locale={locale} />
          {entry.sourceChannel ? <ChannelBadge channel={entry.sourceChannel} /> : null}
        </div>
        <time dateTime={entry.updatedAt}>{formatDate(entry.updatedAt, locale)}</time>
      </div>
      <p>{safeSummary(entry, locale)}</p>
      <dl className="memory-system-record-meta">
        <div><dt>{t.contact}</dt><dd>{contactLabel(entry, locale)}</dd></div>
        <div><dt>{t.category}</dt><dd>{categoryLabel(entry.category, locale)}</dd></div>
        <div><dt>{t.lastUsed}</dt><dd>{entry.lastUsedAt ? formatDate(entry.lastUsedAt, locale) : t.neverUsed}</dd></div>
      </dl>
      <Link className="memory-system-row-link" href={href}>{t.detailTitle}<span aria-hidden="true"> →</span></Link>
    </article>
  );
}

export function EntryDetail({
  closeHref,
  entry,
  locale,
  representativeName,
  representativeSlug,
  reload,
  setNotice,
}: {
  closeHref: string;
  entry: MemoryEntry;
  locale: Locale;
  representativeName: string;
  representativeSlug: string;
  reload: () => void;
  setNotice: (notice: string | null) => void;
}) {
  const t = copy[locale];
  const detailRef = useRef<HTMLElement>(null);
  const closeLinkRef = useRef<HTMLAnchorElement>(null);
  const [mobileModal, setMobileModal] = useState(false);
  const [busy, setBusy] = useState<EntryCommand | null>(null);
  const [note, setNote] = useState("");
  const [correctionField, setCorrectionField] = useState(() => defaultCorrectionField(entry));
  const [correctionValue, setCorrectionValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(null);
    setNote("");
    setCorrectionField(defaultCorrectionField(entry));
    setCorrectionValue("");
    setActionError(null);
  }, [entry]);

  useEffect(() => {
    const dialog = detailRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const media = window.matchMedia("(max-width: 680px)");
    let restoreInert: (() => void) | null = null;
    const syncModalState = () => {
      setMobileModal(media.matches);
      if (media.matches && !restoreInert) {
        restoreInert = makeOutsideContentInert(dialog);
      } else if (!media.matches && restoreInert) {
        restoreInert();
        restoreInert = null;
      }
    };
    syncModalState();
    dialog.focus();
    media.addEventListener("change", syncModalState);
    return () => {
      media.removeEventListener("change", syncModalState);
      restoreInert?.();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [entry.id]);

  async function submit(command: EntryCommand) {
    const confirmation = confirmationForCommand(command, locale);
    if (confirmation && !window.confirm(confirmation)) return;
    const expectedUpdatedAt = command === "retry_cleanup"
      ? entry.cleanup?.updatedAt
      : entry.updatedAt;
    if (!expectedUpdatedAt) {
      setActionError(t.actionFailed);
      return;
    }
    setBusy(command);
    setActionError(null);
    setNotice(null);
    try {
      const payload = buildEntryActionPayload({
        command,
        correctionField,
        correctionValue,
        entry,
        note,
      });
      if (!payload) throw new Error("Memory action is missing its current revision.");
      await executeMemoryAction(representativeSlug, payload);
      setNotice(t.actionSuccess);
      reload();
    } catch {
      setActionError(t.actionFailed);
    } finally {
      setBusy(null);
    }
  }

  const commands = entryActionCommands(entry);
  const canCorrect = commands.includes("request_correction");
  return (
    <aside
      className="dashboard-v2-panel memory-system-detail"
      aria-labelledby="memory-entry-detail-title"
      aria-modal={mobileModal ? true : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeLinkRef.current?.click();
        } else if (event.key === "Tab" && mobileModal) {
          trapModalFocus(event, detailRef.current);
        }
      }}
      ref={detailRef}
      role="dialog"
      tabIndex={-1}
    >
      <header>
        <div><p>{entry.kind === "candidate" ? (locale === "zh" ? "候选" : "Candidate") : (locale === "zh" ? "正式记忆" : "Governed memory")}</p><h2 id="memory-entry-detail-title">{t.detailTitle}</h2></div>
        <Link href={closeHref} ref={closeLinkRef}>{t.closeDetail}</Link>
      </header>
      <div className="memory-system-detail-summary">
        <div><TypeBadge entry={entry} locale={locale} /><StatusBadge status={entry.status} locale={locale} /></div>
        <p>{safeSummary(entry, locale)}</p>
      </div>
      <dl className="memory-system-detail-list">
        <InfoRow label={t.currentRepresentative} value={representativeName} />
        <InfoRow label={t.contact} value={contactLabel(entry, locale)} />
        <InfoRow label={t.source} value={sourceLabel(entry.extraction?.sourceKind ?? entry.sourceKind, locale)} />
        <InfoRow label={t.extractionReason} value={reasonLabel(entry.extraction?.reasonCode ?? entry.extractionReasonCode, locale)} />
        <InfoRow label={t.safetyDecision} value={safetyLabel(entry, locale)} />
        <InfoRow label={t.updated} value={formatDate(entry.updatedAt, locale)} />
        <InfoRow label={t.expires} value={formatDateOrUnavailable(entry.lifecycle?.expiresAt ?? entry.expiresAt, locale)} />
      </dl>
      {entry.provenance?.inboxHref ? <Link className="dashboard-v2-button-secondary memory-system-inline-link" href={entry.provenance.inboxHref}>{t.openInbox}</Link> : null}

      <section className="memory-system-review-history" aria-labelledby="memory-review-history-title">
        <h3 id="memory-review-history-title">{t.reviewHistory}</h3>
        {entry.reviews?.length ? (
          <ol>{entry.reviews.map((review, index) => <li key={`${review.createdAt}:${index}`}><div><StatusBadge status={review.outcome} locale={locale} /><time dateTime={review.createdAt}>{formatDate(review.createdAt, locale)}</time></div><p>{reasonLabel(review.reasonCode, locale)}</p></li>)}</ol>
        ) : <p>{t.noReview}</p>}
      </section>

      <section className="memory-system-review-history" aria-labelledby="memory-recent-use-title">
        <h3 id="memory-recent-use-title">{t.recentUseTitle}</h3>
        {entry.recentUse?.length ? (
          <ol>{entry.recentUse.map((use, index) => <li key={`${use.injectedAt ?? "use"}:${index}`}><div><span className="memory-system-status is-success">{t.injected}</span><time dateTime={use.injectedAt ?? undefined}>{formatDateOrUnavailable(use.injectedAt, locale)}</time></div>{use.inboxHref ? <Link className="memory-system-row-link" href={use.inboxHref}>{t.openInbox}</Link> : null}</li>)}</ol>
        ) : <p>{t.noRecentUse}</p>}
      </section>

      <label className="memory-system-field"><span>{t.reviewNote}</span><textarea maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} /></label>
      <div className="memory-system-governance-actions">
        {commands.includes("approve_candidate") ? <ActionButton busy={busy} command="approve_candidate" label={t.approve} onAction={submit} /> : null}
        {commands.includes("reject_candidate") ? <ActionButton busy={busy} command="reject_candidate" label={t.reject} onAction={submit} /> : null}
        {commands.includes("block_candidate") ? <ActionButton busy={busy} command="block_candidate" label={t.block} onAction={submit} /> : null}
        {commands.includes("suppress_memory") ? <ActionButton busy={busy} command="suppress_memory" label={t.suppress} onAction={submit} /> : null}
        {commands.includes("archive_memory") ? <ActionButton busy={busy} command="archive_memory" label={t.archive} onAction={submit} /> : null}
        {commands.includes("restore_memory") ? <ActionButton busy={busy} command="restore_memory" label={t.restore} onAction={submit} /> : null}
        {commands.includes("retry_cleanup") ? <ActionButton busy={busy} command="retry_cleanup" label={t.retryCleanup} onAction={submit} /> : null}
        {commands.includes("request_deletion") ? <ActionButton busy={busy} command="request_deletion" danger label={t.permanentDelete} onAction={submit} /> : null}
      </div>

      {canCorrect ? (
        <form className="memory-system-correction" onSubmit={(event) => { event.preventDefault(); void submit("request_correction"); }}>
          <h3>{t.correctionTitle}</h3>
          <label className="memory-system-field"><span>{entry.scope === "REPRESENTATIVE" ? t.correctionPattern : t.correctionField}</span><select onChange={(event) => setCorrectionField(event.target.value)} value={correctionField}>{entry.scope === "REPRESENTATIVE" ? <><option value="response_format_preference">{locale === "zh" ? "回复格式偏好" : "Response format preference"}</option><option value="service_goal_confirmation">{locale === "zh" ? "服务目标确认" : "Service goal confirmation"}</option><option value="safety_constraint_confirmation">{locale === "zh" ? "安全约束确认" : "Safety constraint confirmation"}</option></> : <><option value="reply_language">{locale === "zh" ? "回复语言" : "Reply language"}</option><option value="reply_tone">{locale === "zh" ? "回复语气" : "Reply tone"}</option><option value="reply_format">{locale === "zh" ? "回复格式" : "Reply format"}</option><option value="reply_length">{locale === "zh" ? "回复长度" : "Reply length"}</option></>}</select></label>
          {entry.scope !== "REPRESENTATIVE" ? <label className="memory-system-field"><span>{t.correctionValue}</span><input maxLength={64} onChange={(event) => setCorrectionValue(event.target.value)} required value={correctionValue} /></label> : null}
          <button className="dashboard-v2-button-secondary" disabled={busy !== null} type="submit">{busy === "request_correction" ? t.actionRunning : t.submitCorrection}</button>
        </form>
      ) : null}
      {actionError ? <p className="memory-system-error" role="alert">{actionError}</p> : null}
      <details className="memory-system-diagnostics"><summary>{t.advanced}</summary><p>{t.advancedDetail}</p><dl><InfoRow label={t.version} value={entry.version?.number ? `v${entry.version.number}` : t.unavailableStatus} /><InfoRow label={t.projection} value={entry.cleanup?.status ? statusLabel(entry.cleanup.status, locale) : t.notProjected} /></dl></details>
    </aside>
  );
}

function UsageSection({ data, locale, pathname, searchParams }: { data: MemoryUsageResponse; locale: Locale; pathname: string; searchParams: ReadonlyURLSearchParams }) {
  const t = copy[locale];
  return (
    <>
      <SectionHeader description={t.usageDetail} id="memory-usage-title" title={t.usageTitle} />
      <MemoryFilterForm key={`usage:${searchParams.toString()}`} locale={locale} pathname={pathname} representative={data.representative.displayName} representativeSlug={data.representative.slug} searchParams={searchParams} section="usage" />
      <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-usage-list-title">
        <h2 className="memory-system-visually-hidden" id="memory-usage-list-title">{t.usageTitle}</h2>
        {data.items.length ? <div className="memory-system-usage-list">{data.items.map((run) => <UsageRunCard key={run.id} locale={locale} run={run} />)}</div> : <EmptyState detail={t.emptyDetail} title={t.emptyTitle} />}
        <Pagination locale={locale} page={data.page} pathname={pathname} searchParams={searchParams} />
      </section>
    </>
  );
}

function UsageRunCard({ locale, run }: { locale: Locale; run: MemoryUseRun }) {
  const t = copy[locale];
  const counts = run.counts;
  const sourceCounts = countInjectedSourceKinds(run);
  return (
    <article className="memory-system-usage-card">
      <header><div><ChannelBadge channel={run.sourceChannel} /><StatusBadge status={run.status} locale={locale} /></div><time dateTime={run.createdAt}>{formatDate(run.createdAt, locale)}</time></header>
      <div className="memory-system-usage-trigger"><span>{t.question}</span><strong>{t.questionProtected}</strong>{run.trigger?.inboxHref ? <Link href={run.trigger.inboxHref}>{t.openInbox}</Link> : null}</div>
      <ol className="memory-system-stage-trace" aria-label={locale === "zh" ? "记忆使用阶段" : "Memory usage stages"}>
        <Stage label={t.searched} value={counts.searchHits} />
        <Stage label={t.scopeAllowed} value={counts.scopePassed} />
        <Stage label={t.safetyAllowed} value={counts.safetyPassed} />
        <Stage label={t.injected} value={counts.injectedIntoModel} />
        <li><span>{t.outputSources}</span><strong>{formatCount(counts.citedByModel)} / {formatCount(counts.displayedSources)}</strong><small>{t.modelCited} / {t.publiclyDisplayed}</small></li>
      </ol>
      {run.sources?.length ? <SourceStageTable locale={locale} run={run} /> : null}
      <div className="memory-system-source-breakdown"><strong>{t.usageSources}</strong>{sourceCounts.length ? <ul>{sourceCounts.map((source) => <li key={source.kind}><SourceKindBadge kind={source.kind} locale={locale} /><span>{formatCount(source.count)}</span></li>)}</ul> : <p>{t.noSources}</p>}</div>
    </article>
  );
}

function OperationsSection({
  data,
  dataError,
  locale,
  pathname,
  reconciliation,
  reconciliationError,
  representativeSlug,
  searchParams,
  setNotice,
  reload,
}: {
  data: MemoryOperationsResponse | null;
  dataError: boolean;
  locale: Locale;
  pathname: string;
  reconciliation: MemoryReconciliationResponse | null;
  reconciliationError: boolean;
  representativeSlug: string;
  searchParams: ReadonlyURLSearchParams;
  setNotice: (notice: string | null) => void;
  reload: () => void;
}) {
  const t = copy[locale];
  const representative = data?.representative ?? reconciliation?.representative;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  async function submit(action: Record<string, unknown>, key: string) {
    setBusy(key);
    setNotice(null);
    setActionError(null);
    try {
      await executeMemoryAction(representativeSlug, action);
      setNotice(action.action === "enqueue_reconciliation" ? t.reconcileQueued : t.actionSuccess);
      reload();
    } catch {
      setNotice(null);
      setActionError(action.action === "enqueue_reconciliation" ? t.reconcileFailed : t.actionFailed);
    } finally { setBusy(null); }
  }
  return (
    <>
      <SectionHeader description={t.operationsDetail} id="memory-operations-title" title={t.operationsTitle} />
      <MemoryFilterForm key={`operations:${searchParams.toString()}`} locale={locale} pathname={pathname} representative={representative?.displayName ?? representativeSlug} representativeSlug={representative?.slug ?? representativeSlug} searchParams={searchParams} section="operations" />
      {actionError ? <p className="memory-system-error" role="alert">{actionError}</p> : null}
      <div className="memory-system-operations-grid">
        <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-operation-list-title">
          <SectionHeader description="" id="memory-operation-list-title" title={t.operationsList} />
          {dataError ? (
            <PartialUnavailable detail={t.operationUnavailable} onRetry={reload} retry={t.retry} />
          ) : data?.items.length ? (
            <div className="memory-system-operation-list">{data.items.map((operation) => <OperationRow busy={busy} key={operation.id} locale={locale} onRetry={submit} operation={operation} representativeSlug={representativeSlug} />)}</div>
          ) : <EmptyState detail={t.emptyDetail} title={t.emptyTitle} />}
          {data ? <Pagination locale={locale} page={data.page} pathname={pathname} searchParams={searchParams} /> : null}
        </section>
        <section className="dashboard-v2-panel memory-system-panel" aria-labelledby="memory-reconciliation-list-title">
          <SectionHeader description={t.partialInventory} id="memory-reconciliation-list-title" title={t.reconciliationList}><button className="dashboard-v2-button-secondary" disabled={busy !== null} onClick={() => void submit({ action: "enqueue_reconciliation" }, "reconcile")} type="button">{busy === "reconcile" ? t.actionRunning : t.reconcileNow}</button></SectionHeader>
          {reconciliationError ? (
            <PartialUnavailable detail={t.reconciliationUnavailable} onRetry={reload} retry={t.retry} />
          ) : (
            <>
              {reconciliation?.inventoryCapability?.inventoryStatus === "partial" ? <p className="memory-system-honesty-note is-warning">{t.partialInventory}</p> : null}
              {reconciliation?.items.length ? <div className="memory-system-reconciliation-list">{reconciliation.items.map((run) => <ReconciliationRunCard href={buildMemoryHref(pathname, searchParams, { runId: run.id })} key={run.id} locale={locale} run={run} />)}</div> : <EmptyState detail={t.emptyDetail} title={t.emptyTitle} />}
              {reconciliation?.detail ? <ReconciliationDetail closeHref={buildMemoryHref(pathname, searchParams, { runId: null })} locale={locale} pathname={pathname} run={reconciliation.detail} searchParams={searchParams} /> : null}
              {reconciliation ? <Pagination locale={locale} namespace="reconciliation" page={reconciliation.page} pathname={pathname} searchParams={searchParams} /> : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function OperationRow({ busy, locale, onRetry, operation, representativeSlug }: { busy: string | null; locale: Locale; onRetry: (action: Record<string, unknown>, key: string) => Promise<void>; operation: MemoryOperation; representativeSlug: string }) {
  const t = copy[locale];
  const entryHref = operation.kind === "cleanup" && operation.memory?.id
    ? `/dashboard?${new URLSearchParams({ view: "memory", rep: representativeSlug, lang: locale, section: "entries", entryId: operation.memory.id }).toString()}`
    : null;
  const retryAction = operationRetryAction(operation);
  const retryKey = `retry:${operation.id}`;
  const operationChannel = operation.sourceChannel ?? operation.memory?.sourceChannel;
  return (
    <article>
      <header>
        <div>
          <span className="memory-system-kind-label">{operationKindLabel(operation.kind, locale)}</span>
          <StatusBadge status={operation.status} locale={locale} />
          {operationChannel ? <ChannelBadge channel={operationChannel} /> : null}
          {operation.environment ? <span className="memory-system-status is-indigo">{operation.environment === "staging" ? t.staging : t.liveRecall}</span> : null}
        </div>
        <time dateTime={operation.createdAt}>{formatDate(operation.createdAt, locale)}</time>
      </header>
      {operation.kind === "extraction" ? (
        <dl><DataPoint label={t.candidates} value={operation.counts?.candidates} /><DataPoint label={t.accepted} value={operation.counts?.accepted} /><DataPoint label={t.rejectedCount} value={operation.counts?.rejected} /></dl>
      ) : operation.kind === "public_knowledge_sync" ? (
        <dl><DataPoint label={t.verified} value={operation.verifiedItemCount} /><DataPoint label={t.attempts} value={operation.attemptCount} /></dl>
      ) : (
        <dl><DataPoint label={t.attempts} value={operation.attemptCount} /></dl>
      )}
      <div className="memory-system-operation-times"><span>{t.started}: {formatDateOrUnavailable(operation.startedAt, locale)}</span><span>{t.finished}: {formatDateOrUnavailable(operation.finishedAt, locale)}</span></div>
      <ReasonList locale={locale} reasons={operation.reasons} />
      {operation.partialSuccess ? <p className="memory-system-honesty-note is-warning">{t.partialSuccessNote}</p> : null}
      {operation.errorCode ? <p className="memory-system-honesty-note is-error">{t.operationAttention}</p> : null}
      {operation.provenance?.inboxHref ? <Link href={operation.provenance.inboxHref}>{t.openInbox}</Link> : null}
      {operation.knowledgeLibraryHref ? <Link href={operation.knowledgeLibraryHref}>{t.knowledge}</Link> : null}
      <div className="memory-system-operation-actions">
        {entryHref ? <Link className="dashboard-v2-button-secondary" href={entryHref}>{t.viewDetail}</Link> : null}
        {retryAction ? <button className="dashboard-v2-button-secondary" disabled={busy !== null} onClick={() => void onRetry(retryAction, retryKey)} type="button">{busy === retryKey ? t.actionRunning : t.retryItem}</button> : null}
      </div>
    </article>
  );
}

function ReconciliationRunCard({ href, locale, run }: { href: string; locale: Locale; run: MemoryReconciliationRun }) {
  const t = copy[locale];
  return (
    <article>
      <header><StatusBadge status={run.status} locale={locale} />{run.inventoryStatus === "partial" ? <span>{locale === "zh" ? "部分覆盖" : "Partial coverage"}</span> : null}</header>
      <time dateTime={run.createdAt}>{formatDate(run.createdAt, locale)}</time>
      <dl><DataPoint label={t.checked} value={run.coverage.expected} /><DataPoint label={t.observed} value={run.coverage.observed} /><DataPoint label={t.matched} value={run.coverage.matched} /><DataPoint label={t.issues} value={run.coverage.issues} /><DataPoint label={t.resolved} value={run.coverage.resolved} /></dl>
      <Link className="memory-system-row-link" href={href}>{t.viewDetail}<span aria-hidden="true"> →</span></Link>
    </article>
  );
}

function ReconciliationDetail({ closeHref, locale, pathname, run, searchParams }: { closeHref: string; locale: Locale; pathname: string; run: MemoryReconciliationRun; searchParams: ReadonlyURLSearchParams }) {
  const t = copy[locale];
  return (
    <div className="memory-system-reconciliation-detail">
      <header><h3>{t.reconciliationDetail}</h3><Link href={closeHref}>{t.closeDetail}</Link></header>
      {run.issues?.length ? <ul>{run.issues.map((issue) => <li key={issue.id}><div><span>{reconciliationIssueLabel(issue.issueKind, locale)}</span><StatusBadge status={issue.status} locale={locale} /></div><p>{reasonLabel(issue.reasonCode, locale)}</p><small>{t.attempts}: {formatCount(issue.attemptCount)}</small></li>)}</ul> : <EmptyState detail={t.emptyDetail} title={t.emptyTitle} />}
      {run.issuesPage ? <ReconciliationIssuePagination locale={locale} page={run.issuesPage} pathname={pathname} searchParams={searchParams} /> : null}
    </div>
  );
}

function MemoryFilterForm({ locale, pathname, representative, representativeSlug, searchParams, section }: { locale: Locale; pathname: string; representative: string; representativeSlug: string; searchParams: ReadonlyURLSearchParams; section: Exclude<MemorySection, "overview"> }) {
  const t = copy[locale];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const [key, rawValue] of values.entries()) {
      const value = String(rawValue).trim();
      if (!value) continue;
      if (key === "from" || key === "to") {
        const date = new Date(value);
        if (Number.isFinite(date.getTime())) params.set(key, date.toISOString());
      } else {
        params.set(key, value);
      }
    }
    window.location.assign(`${pathname}?${params.toString()}`);
  };
  return (
    <form action={pathname} className="dashboard-v2-panel memory-system-filters" method="get" onSubmit={submit}>
      <input name="view" type="hidden" value="memory" /><input name="rep" type="hidden" value={representativeSlug} /><input name="lang" type="hidden" value={locale} /><input name="section" type="hidden" value={section} />
      <label><span>{t.currentRepresentative}</span><input disabled value={representative} /></label>
      {section === "entries" ? <><label><span>{t.type}</span><select defaultValue={searchParams.get("scope") ?? ""} name="scope"><option value="">{t.all}</option><option value="CONTACT_CHANNEL">{t.contactMemory}</option><option value="REPRESENTATIVE">{t.representativeExperience}</option></select></label><label><span>{t.search}</span><input defaultValue={searchParams.get("query") ?? ""} maxLength={200} name="query" type="search" /></label><label><span>{t.contact}</span><input defaultValue={searchParams.get("contactId") ?? ""} name="contactId" /></label><SelectFilter label={t.status} name="status" options={entryStatusOptions(locale)} value={searchParams.get("status")} /><SelectFilter label={t.category} name="category" options={categoryOptions(locale)} value={searchParams.get("category")} /><SelectFilter label={t.source} name="source" options={sourceOptions(locale)} value={searchParams.get("source")} /><SelectFilter label={t.channel} name="channel" options={channelOptions(locale)} value={searchParams.get("channel")} /></> : null}
      {section === "usage" ? <><label><span>{t.contact}</span><input defaultValue={searchParams.get("contactId") ?? ""} name="contactId" /></label><SelectFilter label={t.usageStatus} name="status" options={usageStatusOptions(locale)} value={searchParams.get("status")} /><SelectFilter label={t.sourceKind} name="sourceKind" options={sourceKindOptions(locale)} value={searchParams.get("sourceKind")} /><SelectFilter label={t.channel} name="channel" options={channelOptions(locale)} value={searchParams.get("channel")} /></> : null}
      {section === "operations" ? <><SelectFilter label={t.operationKind} name="kind" options={operationKindOptions(locale)} value={searchParams.get("kind")} /><label><span>{t.status}</span><input defaultValue={searchParams.get("status") ?? ""} name="status" /></label><SelectFilter label={t.channel} name="channel" options={channelOptions(locale)} value={searchParams.get("channel")} /></> : null}
      <label><span>{t.from}</span><input defaultValue={toDateTimeLocal(searchParams.get("from"))} name="from" type="datetime-local" /></label><label><span>{t.to}</span><input defaultValue={toDateTimeLocal(searchParams.get("to"))} name="to" type="datetime-local" /></label>
      <div className="memory-system-filter-actions"><button className="dashboard-v2-button-primary" type="submit">{t.applyFilters}</button><Link className="dashboard-v2-button-secondary" href={buildMemoryHref(pathname, searchParams, { section, clearFilters: true })}>{t.clearFilters}</Link></div>
    </form>
  );
}

function SelectFilter({ label, name, options, value }: { label: string; name: string; options: Array<[string, string]>; value: string | null }) { return <label><span>{label}</span><select defaultValue={value ?? ""} name={name}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>; }
function ActionButton({ busy, command, danger = false, label, onAction }: { busy: EntryCommand | null; command: EntryCommand; danger?: boolean; label: string; onAction: (command: EntryCommand) => Promise<void> }) { return <button className={`dashboard-v2-button-secondary${danger ? " memory-system-danger-button" : ""}`} disabled={busy !== null} onClick={() => void onAction(command)} type="button">{busy === command ? "…" : label}</button>; }
function SectionHeader({ children, description, id, title }: { children?: ReactNode; description: string; id: string; title: string }) { return <header className="memory-system-panel-header"><div><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div>{children}</header>; }
function MetricCard({ detail, label, tone, value }: { detail?: string; label: string; tone: "default" | "teal" | "indigo" | "warning"; value: number }) { return <article className={`dashboard-v2-metric-card is-${tone}`}><div><span>{label}</span><i /></div><strong>{formatCount(value)}</strong>{detail ? <p>{detail}</p> : null}</article>; }
function StatusRow({ label, tone, value }: { label: string; tone: "success" | "warning" | "error" | "muted"; value: string }) { return <div><dt>{label}</dt><dd className={`is-${tone}`}>{value}</dd></div>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function DataPoint({ label, value }: { label: string; value: number | undefined }) { return <div><dt>{label}</dt><dd>{typeof value === "number" ? formatCount(value) : "—"}</dd></div>; }
function Stage({ label, value }: { label: string; value: number }) { return <li><span>{label}</span><strong>{formatCount(value)}</strong></li>; }
function SourceStageTable({ locale, run }: { locale: Locale; run: MemoryUseRun }) { const t = copy[locale]; return <div className="memory-system-source-stage-table"><strong>{t.candidateStages}</strong><div><table><thead><tr><th>{t.sourceKind}</th><th>{t.searched}</th><th>{t.scopeAllowed}</th><th>{t.safetyAllowed}</th><th>{t.injected}</th><th>{t.modelCited}</th><th>{t.publiclyDisplayed}</th></tr></thead><tbody>{(run.sources ?? []).map((source) => <tr key={source.id}><th><span>{source.title?.trim() || sourceKindLabel(source.sourceKind, locale)}</span><SourceKindBadge kind={source.sourceKind} locale={locale} /></th><StageCell passed={Boolean(source.stages.searchedAt)} locale={locale} /><StageCell passed={Boolean(source.stages.scopePassedAt)} locale={locale} /><StageCell passed={Boolean(source.stages.safetyPassedAt)} locale={locale} /><StageCell passed={Boolean(source.stages.injectedAt)} locale={locale} /><StageCell passed={Boolean(source.stages.citedAt)} locale={locale} /><StageCell passed={Boolean(source.stages.displayedAt)} locale={locale} /></tr>)}</tbody></table></div></div>; }
function StageCell({ locale, passed }: { locale: Locale; passed: boolean }) { return <td><span className={`memory-system-stage-result is-${passed ? "passed" : "stopped"}`}>{passed ? copy[locale].passed : copy[locale].notPassed}</span></td>; }
function EmptyState({ detail, title }: { detail: string; title: string }) { return <div className="memory-system-empty"><span aria-hidden="true">◇</span><strong>{title}</strong><p>{detail}</p></div>; }
function LoadingState({ label }: { label: string }) { return <section className="dashboard-v2-panel memory-system-loading" role="status"><span className="memory-system-spinner" aria-hidden="true" /><strong>{label}</strong></section>; }
function UnavailableState({ detail, onRetry, retry, title }: { detail: string; onRetry: () => void; retry: string; title: string }) { return <section className="dashboard-v2-panel memory-system-unavailable" role="alert"><div><strong>{title}</strong><p>{detail}</p></div><button className="dashboard-v2-button-secondary" onClick={onRetry} type="button">{retry}</button></section>; }
function PartialUnavailable({ detail, onRetry, retry }: { detail: string; onRetry: () => void; retry: string }) { return <div className="memory-system-partial-unavailable" role="alert"><p>{detail}</p><button className="dashboard-v2-button-secondary" onClick={onRetry} type="button">{retry}</button></div>; }

function Pagination({ locale, namespace = "default", page, pathname, searchParams }: { locale: Locale; namespace?: "default" | "reconciliation"; page: MemoryEntriesResponse["page"]; pathname: string; searchParams: ReadonlyURLSearchParams }) {
  const t = copy[locale];
  const cursorKey = namespace === "reconciliation" ? "reconciliationCursor" : "cursor";
  const firstPageUpdates = namespace === "reconciliation"
    ? { resetReconciliationPagination: true }
    : { resetPagination: true };
  const nextCursor = page.nextCursor ?? "";
  const nextPageUpdates = namespace === "reconciliation"
    ? { reconciliationCursor: nextCursor, reconciliationAsOf: page.asOf }
    : { cursor: nextCursor, asOf: page.asOf };
  return <footer className="memory-system-pagination"><span>{t.pageAsOf}: {formatDate(page.asOf, locale)}</span><div>{searchParams.get(cursorKey) ? <Link className="dashboard-v2-button-secondary" href={buildMemoryHref(pathname, searchParams, firstPageUpdates)}>{t.firstPage}</Link> : null}{page.hasMore && page.nextCursor ? <Link className="dashboard-v2-button-secondary" href={buildMemoryHref(pathname, searchParams, nextPageUpdates)}>{t.nextPage}</Link> : null}</div></footer>;
}

function ReconciliationIssuePagination({ locale, page, pathname, searchParams }: { locale: Locale; page: NonNullable<MemoryReconciliationRun["issuesPage"]>; pathname: string; searchParams: ReadonlyURLSearchParams }) {
  const t = copy[locale];
  return (
    <footer className="memory-system-pagination memory-system-reconciliation-issue-pagination">
      <span>{t.pageAsOf}: {formatDate(page.asOf, locale)}</span>
      <div>
        {searchParams.get("reconciliationItemCursor") ? (
          <Link className="dashboard-v2-button-secondary" href={buildMemoryHref(pathname, searchParams, { resetReconciliationIssuePagination: true })}>{t.firstPage}</Link>
        ) : null}
        {page.hasMore && page.nextCursor ? (
          <Link className="dashboard-v2-button-secondary" href={buildMemoryHref(pathname, searchParams, { reconciliationItemCursor: page.nextCursor })}>{t.nextPage}</Link>
        ) : null}
      </div>
    </footer>
  );
}

export function nextFocusTrapIndex(
  activeIndex: number,
  length: number,
  backward: boolean,
): number | null {
  if (length <= 0) return -1;
  if (activeIndex < 0) return backward ? length - 1 : 0;
  if (backward && activeIndex === 0) return length - 1;
  if (!backward && activeIndex === length - 1) return 0;
  return null;
}

function trapModalFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => (
    element.getAttribute("aria-hidden") !== "true"
    && element.tabIndex >= 0
  ));
  const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = nextFocusTrapIndex(activeIndex, focusable.length, event.shiftKey);
  if (nextIndex === null) return;
  event.preventDefault();
  if (nextIndex < 0) dialog.focus();
  else focusable[nextIndex]?.focus();
}

function makeOutsideContentInert(dialog: HTMLElement) {
  const records: Array<{
    element: HTMLElement;
    hadInert: boolean;
    ariaHidden: string | null;
  }> = [];
  let branch: HTMLElement = dialog;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (
        sibling === branch
        || !(sibling instanceof HTMLElement)
        || ["LINK", "SCRIPT", "STYLE"].includes(sibling.tagName)
      ) continue;
      records.push({
        element: sibling,
        hadInert: sibling.hasAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    if (parent === document.body) break;
    branch = parent;
  }
  return () => {
    for (const record of records.reverse()) {
      if (!record.hadInert) record.element.removeAttribute("inert");
      if (record.ariaHidden === null) record.element.removeAttribute("aria-hidden");
      else record.element.setAttribute("aria-hidden", record.ariaHidden);
    }
  };
}
function TypeBadge({ entry, locale }: { entry: MemoryEntry; locale: Locale }) { const representative = entry.scope === "REPRESENTATIVE" || entry.memoryType === "representative_experience"; return <span className={`memory-system-type is-${representative ? "experience" : "contact"}`}>{representative ? copy[locale].representativeExperience : copy[locale].contactMemory}</span>; }
function StatusBadge({ locale, status }: { locale: Locale; status: string }) { return <span className={`memory-system-status is-${statusTone(status)}`}>{statusLabel(status, locale)}</span>; }
function ChannelBadge({ channel }: { channel: string }) { const normalized = channel.toLowerCase(); return <span className={`memory-system-channel is-${normalized}`}>{channelLabel(channel)}</span>; }
function SourceKindBadge({ kind, locale }: { kind: string; locale: Locale }) { return <span className={`memory-system-source-kind is-${kind.toLowerCase()}`}>{sourceKindLabel(kind, locale)}</span>; }
function ReasonList({ locale, reasons }: { locale: Locale; reasons: Array<{ reasonCode: string; count: number }> | undefined }) { if (!reasons?.length) return null; return <div className="memory-system-reasons"><strong>{copy[locale].reasons}</strong><ul>{reasons.map((reason) => <li key={reason.reasonCode}><span>{reasonLabel(reason.reasonCode, locale)}</span><b>{formatCount(reason.count)}</b></li>)}</ul></div>; }

function parseSection(value: string | null): MemorySection { return sections.includes(value as MemorySection) ? value as MemorySection : "overview"; }
export function buildMemoryHref(pathname: string, current: Pick<URLSearchParams, "toString">, updates: { section?: MemorySection; entryId?: string | null; runId?: string | null; cursor?: string; asOf?: string; reconciliationCursor?: string; reconciliationAsOf?: string; reconciliationItemCursor?: string; resetPagination?: boolean; resetReconciliationPagination?: boolean; resetReconciliationIssuePagination?: boolean; resetList?: boolean; clearFilters?: boolean }) { const params = new URLSearchParams(current.toString()); params.set("view", "memory"); if (updates.section) params.set("section", updates.section); if (updates.entryId === null) params.delete("entryId"); else if (updates.entryId) params.set("entryId", updates.entryId); if (updates.runId === null) { params.delete("runId"); params.delete("reconciliationItemCursor"); params.delete("reconciliationItemLimit"); } else if (updates.runId) { if (params.get("runId") !== updates.runId) params.delete("reconciliationItemCursor"); params.set("runId", updates.runId); } if (updates.resetList || updates.clearFilters) { for (const key of ["kind", "entryId", "contactId", "scope", "category", "status", "source", "sourceKind", "channel", "conversationId", "messageId", "from", "to", "query", "runId", "cursor", "asOf", "reconciliationCursor", "reconciliationAsOf", "reconciliationLimit", "reconciliationItemCursor", "reconciliationItemLimit"]) params.delete(key); } if (updates.resetPagination) { params.delete("cursor"); params.delete("asOf"); } if (updates.resetReconciliationPagination) { params.delete("reconciliationCursor"); params.delete("reconciliationAsOf"); } if (updates.resetReconciliationIssuePagination) params.delete("reconciliationItemCursor"); if (updates.cursor) params.set("cursor", updates.cursor); if (updates.asOf) params.set("asOf", updates.asOf); if (updates.reconciliationCursor) params.set("reconciliationCursor", updates.reconciliationCursor); if (updates.reconciliationAsOf) params.set("reconciliationAsOf", updates.reconciliationAsOf); if (updates.reconciliationItemCursor) params.set("reconciliationItemCursor", updates.reconciliationItemCursor); return `${pathname}?${params.toString()}`; }
function buildDashboardHref(view: "knowledge" | "representatives", slug: string, locale: Locale, extra: Record<string, string> = {}) { return `/dashboard?${new URLSearchParams({ view, rep: slug, lang: locale, ...extra }).toString()}`; }
function formatCount(value: number) { return Number.isFinite(value) ? new Intl.NumberFormat().format(Math.max(0, value)) : "—"; }
function formatDate(value: string, locale: Locale) { const date = new Date(value); if (!Number.isFinite(date.getTime())) return locale === "zh" ? "不可用" : "Unavailable"; return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatDateOrUnavailable(value: string | null | undefined, locale: Locale) { return value ? formatDate(value, locale) : locale === "zh" ? "尚无记录" : "No record"; }
function toDateTimeLocal(value: string | null) { if (!value) return ""; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ""; const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return shifted.toISOString().slice(0, 16); }
function safeSummary(entry: MemoryEntry, locale: Locale) { return entry.safeText?.trim() || entry.version?.safeText?.trim() || entry.summary?.trim() || entry.version?.summary?.trim() || (locale === "zh" ? "没有可显示的安全摘要。" : "No safe summary is available."); }
function contactLabel(entry: MemoryEntry, locale: Locale) { const value = entry.contact?.label?.trim(); if (!value || /^web visitor$/i.test(value) || /^unknown audience$/i.test(value)) return locale === "zh" ? "匿名访客" : "Anonymous visitor"; return value; }
function capabilityLabel(supported: boolean, enabled: boolean, locale: Locale) { const t = copy[locale]; return !supported ? t.unsupported : enabled ? t.supportedEnabled : t.supportedDisabled; }
function channelLabel(value: string) { const normalized = value.toUpperCase(); return normalized === "WEB" ? "Web" : normalized === "MATRIX" ? "Matrix" : normalized === "TELEGRAM" ? "Telegram" : "Unknown"; }
function statusTone(status: string) { const normalized = status.toUpperCase(); if (["ACTIVE", "APPROVED", "COMPLETED", "SUCCEEDED", "RECONCILED"].includes(normalized)) return "success"; if (["PENDING_REVIEW", "QUEUED", "RUNNING", "RETRYING", "STAGED", "PROJECTING", "DELETING", "STARTED"].includes(normalized)) return "indigo"; if (["PARTIAL", "RETRY_WAIT"].includes(normalized)) return "warning"; if (["FAILED", "DELETE_FAILED", "BLOCKED", "QUARANTINED", "DEGRADED"].includes(normalized) || normalized.startsWith("BLOCKED_")) return "error"; return "muted"; }
function statusLabel(status: string, locale: Locale) { const labels: Record<string, [string, string]> = { HEALTHY: ["正常", "Healthy"], AVAILABLE: ["可用", "Available"], UNAVAILABLE: ["不可用", "Unavailable"], DISABLED: ["已关闭", "Disabled"], UNKNOWN: ["状态不可确认", "State unavailable"], EXTRACTED: ["已提取", "Extracted"], ACTIVE: ["有效", "Active"], PENDING_REVIEW: ["待审核", "Pending review"], APPROVED: ["已批准", "Approved"], REJECTED: ["已拒绝", "Rejected"], BLOCKED: ["已阻止", "Blocked"], BLOCKED_UNPUBLISHED: ["需要先发布", "Publish required"], BLOCKED_MISSING_CREDENTIALS: ["服务配置缺失", "Service setup required"], QUARANTINED: ["已隔离", "Quarantined"], SUPPRESSED: ["已停用", "Disabled"], SUPERSEDED: ["已替代", "Superseded"], EXPIRED: ["已过期", "Expired"], ARCHIVED: ["已归档", "Archived"], DELETE_PENDING: ["待清理", "Pending cleanup"], DELETE_FAILED: ["清理失败", "Cleanup failed"], DELETING: ["清理中", "Deleting"], DELETED: ["已删除", "Deleted"], STAGED: ["已暂存", "Staged"], PROJECTING: ["投影中", "Projecting"], COMPLETED: ["已完成", "Completed"], DEGRADED: ["已降级", "Degraded"], FAILED: ["失败", "Failed"], CANCELED: ["已取消", "Canceled"], QUEUED: ["排队中", "Queued"], RUNNING: ["运行中", "Running"], RETRY_WAIT: ["等待重试", "Waiting to retry"], RETRYING: ["正在重试", "Retrying"], PARTIAL: ["部分完成", "Partial"], SUCCEEDED: ["成功", "Succeeded"] }; const pair = labels[status.toUpperCase()]; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "状态未识别" : "Unknown state"; }
function sourceKindLabel(kind: string, locale: Locale) { const labels: Record<string, [string, string]> = { PUBLIC_KNOWLEDGE: ["公开知识", "Public knowledge"], CONTACT_MEMORY: ["本人历史信息", "Own history"], REPRESENTATIVE_EXPERIENCE: ["已审核代表经验", "Approved representative experience"] }; const pair = labels[kind]; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "其他受治理来源" : "Other governed source"; }
function sourceLabel(source: string | null | undefined, locale: Locale) { const labels: Record<string, [string, string]> = { AUDIENCE_MESSAGE: ["访客消息", "Audience message"], VERIFIED_CONTACT_FIELD: ["已验证联系人字段", "Verified contact field"], OWNER_VERIFIED_CORRECTION: ["Owner 已验证纠正", "Owner-verified correction"] }; const pair = source ? labels[source] : null; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "来源信息不可用" : "Source unavailable"; }
function reasonLabel(reason: string | null | undefined, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    low_risk_structured_preference: ["低风险结构化偏好", "Low-risk structured preference"],
    requires_human_review: ["需要人工审核", "Human review required"],
    sensitive_content_blocked: ["敏感内容已阻止", "Sensitive content blocked"],
    scope_mismatch: ["作用域不匹配", "Scope mismatch"],
    safety_check_failed: ["未通过安全检查", "Safety check failed"],
    token_budget_excluded: ["受回答上下文预算限制", "Excluded by answer context budget"],
    provider_unavailable: ["外部服务暂时不可用", "External service unavailable"],
    automatic_extraction_disabled: ["自动提取未启用", "Automatic extraction is off"],
    channel_extraction_disabled: ["当前渠道未启用提取", "Extraction is off for this channel"],
    channel_trigger_contact_scope_only: ["渠道触发仅允许联系人范围", "Channel triggers allow contact scope only"],
    contact_memory_disabled: ["联系人记忆未启用", "Contact Memory is off"],
    long_term_memory_disabled: ["长期记忆未启用", "Long-term memory is off"],
    memory_policy_missing: ["尚未配置记忆策略", "Memory policy is not configured"],
    memory_source_channel_mismatch: ["来源渠道不匹配", "Source channel does not match"],
    memory_source_channel_missing: ["来源渠道缺失", "Source channel is missing"],
    memory_source_coordinates_mismatch: ["来源会话范围不匹配", "Source conversation scope does not match"],
    memory_source_edited: ["来源内容已修改", "Source content was edited"],
    source_message_edited: ["来源消息已修改", "Source message was edited"],
    memory_source_not_audience_message: ["来源不是访客消息", "Source is not an audience message"],
    memory_source_not_found: ["来源消息不存在", "Source message was not found"],
    memory_source_not_text: ["来源不是可治理文本", "Source is not governable text"],
    memory_source_redacted: ["来源消息已撤回", "Source message was withdrawn"],
    memory_storage_unavailable: ["记忆存储暂时不可用", "Memory storage is unavailable"],
    no_allowlisted_structured_fact: ["未发现白名单结构化字段", "No allowlisted structured field was found"],
    representative_experience_disabled: ["代表经验未启用", "Representative Experience is off"],
    representative_experience_trigger_not_allowed: ["当前触发不允许生成代表经验", "This trigger cannot create Representative Experience"],
    reconciliation_missing_remote: ["远端投影缺失", "Remote projection is missing"],
    reconciliation_hash_mismatch: ["内容校验不一致", "Content verification mismatch"],
    reconciliation_stale_active_pointer: ["活动版本指向过期", "Active version pointer is stale"],
  };
  const pair = reason ? labels[reason] : null;
  return pair
    ? pair[locale === "zh" ? 0 : 1]
    : locale === "zh" ? "其他受治理原因" : "Other governed reason";
}
function safetyLabel(entry: MemoryEntry, locale: Locale) { if (entry.safety?.classification || entry.safety?.reasonCode) return `${entry.safety.classification ? safetyClassLabel(entry.safety.classification, locale) : locale === "zh" ? "已检查" : "Checked"} · ${reasonLabel(entry.safety.reasonCode, locale)}`; return locale === "zh" ? "安全判断不可用" : "Safety decision unavailable"; }
function safetyClassLabel(value: string, locale: Locale) { const normalized = value.toUpperCase(); if (normalized === "LOW_RISK") return locale === "zh" ? "低风险" : "Low risk"; if (normalized === "REVIEW_REQUIRED") return locale === "zh" ? "需审核" : "Review required"; if (normalized === "BLOCKED") return locale === "zh" ? "已阻止" : "Blocked"; return locale === "zh" ? "已分类" : "Classified"; }
function categoryLabel(value: string, locale: Locale) { const labels: Record<string, [string, string]> = { CONTACT_PREFERENCE: ["联系人偏好", "Contact preference"], CONTACT_GOAL: ["联系人目标", "Contact goal"], CONTACT_CONSTRAINT: ["联系人约束", "Contact constraint"], CONTACT_CONTEXT: ["联系人上下文", "Contact context"], REPRESENTATIVE_RESPONSE_PATTERN: ["回复模式", "Response pattern"], REPRESENTATIVE_SERVICE_PATTERN: ["服务模式", "Service pattern"], REPRESENTATIVE_SAFETY_PATTERN: ["安全模式", "Safety pattern"], REPRESENTATIVE_ROUTING_PATTERN: ["路由模式", "Routing pattern"] }; const pair = labels[value]; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "其他分类" : "Other category"; }
function operationKindLabel(kind: string, locale: Locale) { const labels: Record<string, [string, string]> = { extraction: ["候选提取", "Candidate extraction"], projection: ["检索投影", "Recall projection"], cleanup: ["物理清理", "Physical cleanup"], public_knowledge_sync: ["发布知识同步", "Published knowledge sync"] }; const pair = labels[kind.toLowerCase()]; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "同步任务" : "Sync job"; }
function reconciliationIssueLabel(kind: string, locale: Locale) { const labels: Record<string, [string, string]> = { MISSING_REMOTE: ["远端投影缺失", "Remote projection missing"], HASH_MISMATCH: ["内容校验不一致", "Content verification mismatch"], STALE_ACTIVE_POINTER: ["活动版本指向过期", "Active version pointer is stale"] }; const pair = labels[kind.toUpperCase()]; return pair ? pair[locale === "zh" ? 0 : 1] : locale === "zh" ? "库存异常" : "Inventory issue"; }

export function currentMemoryRequest<T extends { requestKey: string }>(
  loaded: T | null,
  requestKey: string,
) {
  return loaded?.requestKey === requestKey ? loaded : null;
}

export function buildEntryActionPayload({
  command,
  correctionField,
  correctionValue,
  entry,
  note,
}: {
  command: EntryCommand;
  correctionField: string;
  correctionValue: string;
  entry: MemoryEntry;
  note: string;
}): Record<string, unknown> | null {
  const expectedUpdatedAt = command === "retry_cleanup"
    ? entry.cleanup?.updatedAt
    : entry.updatedAt;
  if (!expectedUpdatedAt) return null;
  const target = entry.kind === "candidate"
    ? { candidateId: entry.id }
    : { memoryId: entry.id };
  const correction = command === "request_correction"
    ? entry.scope === "REPRESENTATIVE"
      ? { representativePatternCode: correctionField }
      : {
          preferenceField: correctionField,
          preferenceValue: correctionValue.trim(),
        }
    : {};
  return {
    action: command,
    ...target,
    ...correction,
    expectedUpdatedAt,
    reasonCode: commandReasonCode(command),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
}

export function defaultCorrectionField(entry: Pick<MemoryEntry, "scope">) {
  return entry.scope === "REPRESENTATIVE"
    ? "response_format_preference"
    : "reply_language";
}

export function entryActionCommands(entry: MemoryEntry): EntryCommand[] {
  if (entry.kind === "candidate") {
    return entry.status === "PENDING_REVIEW"
      ? ["approve_candidate", "reject_candidate", "block_candidate"]
      : [];
  }
  const status = entry.status.toUpperCase();
  const commands: EntryCommand[] = [];
  if (["ACTIVE", "SUPPRESSED"].includes(status)) commands.push("request_correction");
  if (status === "ACTIVE") commands.push("suppress_memory");
  if (["ACTIVE", "SUPPRESSED", "SUPERSEDED", "EXPIRED"].includes(status)) commands.push("archive_memory");
  if (["SUPPRESSED", "ARCHIVED"].includes(status)) commands.push("restore_memory");
  if (status === "DELETE_PENDING" && entry.cleanup?.status === "FAILED" && entry.cleanup.updatedAt) {
    commands.push("retry_cleanup");
  }
  if (["SUPPRESSED", "SUPERSEDED", "EXPIRED", "ARCHIVED"].includes(status)) {
    commands.push("request_deletion");
  }
  return commands;
}

export function operationRetryAction(operation: MemoryOperation): Record<string, unknown> | null {
  const status = operation.status.toUpperCase();
  if (!operation.updatedAt) return null;
  if (operation.retry && (!operation.retry.supported || !operation.retry.available)) return null;
  const common = {
    expectedUpdatedAt: operation.updatedAt,
  };
  if (operation.kind === "projection" && status === "FAILED" && operation.environment === "recall") {
    return {
      action: "retry_projection",
      projectionItemId: operation.id,
      reasonCode: commandReasonCode("retry_projection"),
      ...common,
    };
  }
  if (operation.kind === "extraction" && status === "FAILED" && operation.sourceChannel === "WEB") {
    return {
      action: "retry_extraction",
      extractionRunId: operation.id,
      reasonCode: commandReasonCode("retry_extraction"),
      ...common,
    };
  }
  if (operation.kind === "cleanup" && status === "FAILED" && operation.memory?.id) {
    return {
      action: "retry_cleanup",
      memoryId: operation.memory.id,
      reasonCode: commandReasonCode("retry_cleanup"),
      ...common,
    };
  }
  return null;
}

function confirmationForCommand(command: EntryCommand, locale: Locale) {
  const t = copy[locale];
  const confirmations: Partial<Record<EntryCommand, string>> = {
    approve_candidate: t.confirmApprove,
    reject_candidate: t.confirmReject,
    block_candidate: t.confirmBlock,
    request_correction: t.confirmCorrection,
    suppress_memory: t.confirmSuppress,
    archive_memory: t.confirmArchive,
    restore_memory: t.confirmRestore,
    request_deletion: t.confirmDelete,
  };
  return confirmations[command] ?? null;
}

function commandReasonCode(command: EntryCommand | OperationRetryCommand) { return `owner_dashboard_${command}`; }
function entryStatusOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["EXTRACTED", "QUARANTINED", "BLOCKED", "PENDING_REVIEW", "APPROVED", "REJECTED", "EXPIRED", "ACTIVE", "SUPPRESSED", "SUPERSEDED", "ARCHIVED", "DELETE_PENDING", "DELETED"].map((value) => [value, statusLabel(value, locale)] as [string, string])]; }
function categoryOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["CONTACT_PREFERENCE", "CONTACT_GOAL", "CONTACT_CONSTRAINT", "CONTACT_CONTEXT", "REPRESENTATIVE_RESPONSE_PATTERN", "REPRESENTATIVE_SERVICE_PATTERN", "REPRESENTATIVE_SAFETY_PATTERN", "REPRESENTATIVE_ROUTING_PATTERN"].map((value) => [value, categoryLabel(value, locale)] as [string, string])]; }
function sourceOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["AUDIENCE_MESSAGE", "VERIFIED_CONTACT_FIELD", "OWNER_VERIFIED_CORRECTION"].map((value) => [value, sourceLabel(value, locale)] as [string, string])]; }
function channelOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ["WEB", "Web"], ["MATRIX", "Matrix"], ["TELEGRAM", "Telegram"]]; }
function usageStatusOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["STARTED", "COMPLETED", "DEGRADED", "FAILED", "CANCELED"].map((value) => [value, statusLabel(value, locale)] as [string, string])]; }
function sourceKindOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["PUBLIC_KNOWLEDGE", "CONTACT_MEMORY", "REPRESENTATIVE_EXPERIENCE"].map((value) => [value, sourceKindLabel(value, locale)] as [string, string])]; }
function operationKindOptions(locale: Locale): Array<[string, string]> { return [["", copy[locale].all], ...["extraction", "projection", "cleanup", "public_knowledge_sync"].map((value) => [value, operationKindLabel(value, locale)] as [string, string])]; }

function countInjectedSourceKinds(run: MemoryUseRun) {
  const counts = new Map<string, number>();
  for (const source of run.sources ?? []) {
    if (!source.stages.injectedAt) continue;
    counts.set(source.sourceKind, (counts.get(source.sourceKind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

function pickQuery(
  query: Record<string, string>,
  keys: string[],
) {
  return Object.fromEntries(keys.flatMap((key) => (
    query[key] ? [[key, query[key]]] : []
  )));
}

export async function loadOperationsSection(
  representativeSlug: string,
  query: Record<string, string>,
  requestKey: string,
  signal: AbortSignal,
): Promise<LoadedSection> {
  const [operationsResult, reconciliationResult] = await Promise.allSettled([
    loadMemoryOperations(
      representativeSlug,
      pickQuery(query, ["kind", "status", "channel", "from", "to", "asOf", "cursor", "limit"]),
      signal,
    ),
    loadMemoryReconciliation(
      representativeSlug,
      {
        ...pickQuery(query, ["runId", "from", "to"]),
        ...(query.reconciliationCursor ? { cursor: query.reconciliationCursor } : {}),
        ...(query.reconciliationAsOf ? { asOf: query.reconciliationAsOf } : {}),
        ...(query.reconciliationLimit ? { limit: query.reconciliationLimit } : {}),
        ...(query.reconciliationItemCursor ? { itemCursor: query.reconciliationItemCursor } : {}),
        ...(query.reconciliationItemLimit ? { itemLimit: query.reconciliationItemLimit } : {}),
      },
      signal,
    ),
  ]);
  return {
    requestKey,
    section: "operations",
    operations: operationsResult.status === "fulfilled" ? operationsResult.value : null,
    operationsError: operationsResult.status === "rejected",
    reconciliation: reconciliationResult.status === "fulfilled" ? reconciliationResult.value : null,
    reconciliationError: reconciliationResult.status === "rejected",
  };
}

type ReadonlyURLSearchParams = ReturnType<typeof useSearchParams>;
