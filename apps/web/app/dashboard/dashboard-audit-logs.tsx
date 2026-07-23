"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceAuditSnapshot } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

import { auditEventLabel } from "./dashboard-audit-labels";

type AuditEvent = WorkspaceAuditSnapshot["events"][number];
const auditPageSize = 50;

export function DashboardAuditLogs({ activeSlug, locale }: { activeSlug: string; locale: Locale }) {
  const zh = locale === "zh";
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [snapshot, setSnapshot] = useState<WorkspaceAuditSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [eventType, setEventType] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settledFilterKey, setSettledFilterKey] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const filterKey = `${activeSlug}\u0000${eventType}\u0000${debouncedQuery}`;
  const activeFilterKeyRef = useRef(filterKey);
  activeFilterKeyRef.current = filterKey;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const loadAudit = useCallback(async (
    mode: "replace" | "append",
    cursor?: string | null,
    signal?: AbortSignal,
  ) => {
    const requestId = ++requestSequenceRef.current;
    const requestedSlug = activeSlug;
    const requestedFilterKey = `${requestedSlug}\u0000${eventType}\u0000${debouncedQuery}`;
    setError(null);
    if (mode === "replace") setLoading(true);
    else setLoadingMore(true);
    try {
      const parameters = new URLSearchParams({
        rep: requestedSlug,
        category: eventType,
        limit: String(auditPageSize),
      });
      if (debouncedQuery) parameters.set("query", debouncedQuery);
      if (cursor) parameters.set("cursor", cursor);
      const response = await fetch(`/api/dashboard/audit?${parameters.toString()}`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await extractError(response));
      const nextSnapshot = (await response.json()) as WorkspaceAuditSnapshot;
      if (
        signal?.aborted
        || activeFilterKeyRef.current !== requestedFilterKey
        || requestSequenceRef.current !== requestId
      ) return;
      setError(null);
      setSnapshot(nextSnapshot);
      setEvents((current) => {
        if (mode === "replace") return nextSnapshot.events;
        const merged = new Map(current.map((event) => [event.id, event]));
        for (const event of nextSnapshot.events) merged.set(event.id, event);
        return [...merged.values()];
      });
      setSettledFilterKey(requestedFilterKey);
      setSelectedId((current) =>
        mode === "append"
          ? current ?? nextSnapshot.events[0]?.id ?? null
          : current && nextSnapshot.events.some((event) => event.id === current)
          ? current
          : nextSnapshot.events[0]?.id ?? null,
      );
    } catch (nextError) {
      if (
        signal?.aborted
        || activeFilterKeyRef.current !== requestedFilterKey
        || requestSequenceRef.current !== requestId
      ) return;
      throw nextError;
    } finally {
      if (
        activeFilterKeyRef.current === requestedFilterKey
        && requestSequenceRef.current === requestId
      ) {
        if (mode === "replace") setLoading(false);
        else setLoadingMore(false);
      }
    }
  }, [activeSlug, debouncedQuery, eventType]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setEvents([]);
    setSelectedId(null);
    setLoadingMore(false);
    void loadAudit("replace", null, controller.signal).catch((nextError: unknown) => {
        if (controller.signal.aborted || activeFilterKeyRef.current !== filterKey) return;
        setSettledFilterKey(filterKey);
        setError(nextError instanceof Error ? nextError.message : (zh ? "审计事件加载失败。" : "Failed to load audit events."));
      });
    return () => controller.abort();
  }, [filterKey, loadAudit, zh]);
  const initialLoading = settledFilterKey !== filterKey;

  const types = useMemo(() => snapshot?.categories.filter((category) => category.count > 0) ?? [], [snapshot]);
  const selected = events.find((event) => event.id === selectedId) ?? events[0] ?? null;

  function exportCsv() {
    const parameters = new URLSearchParams({
      rep: activeSlug,
      category: eventType,
      format: "csv",
    });
    const currentQuery = query.trim();
    if (currentQuery) parameters.set("query", currentQuery);
    const anchor = document.createElement("a");
    anchor.href = `/api/dashboard/audit?${parameters.toString()}`;
    anchor.download = "";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  return (
    <>
      <header className="dashboard-v2-page-header audit-page-header">
        <div>
          <p>AUDIT LOGS / 10</p>
          <h1>{zh ? "从业务决策到运行轨迹，都使用同一条审计时间线。" : "One audit timeline from business decisions to runtime traces."}</h1>
          <span>{zh ? "统一查看技能、发布、审批、钱包、工具、工作流与会话事件；敏感 payload 不会直接暴露在界面或导出中。" : "Review skill, publishing, approval, wallet, tool, workflow, and conversation events together without exposing sensitive payloads."}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button className="dashboard-v2-button-secondary" disabled={initialLoading || loading || loadingMore} onClick={() => void loadAudit("replace").catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : "Refresh failed."))} type="button">{loading && !initialLoading ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新" : "Refresh")}</button>
          <button className="dashboard-v2-button-secondary" disabled={initialLoading || loading || loadingMore || !(snapshot?.page.filteredTotal)} onClick={exportCsv} type="button">{zh ? "导出全部匹配结果" : "Export all matches"}</button>
        </div>
      </header>

      <div aria-busy={initialLoading || loading || loadingMore} className="dashboard-module-content">
        {error && !initialLoading ? (
          <div className="skills-banner is-error" role="alert">
            <span>{error}</span>
            <button className="dashboard-v2-button-secondary" disabled={loading || loadingMore} onClick={() => void loadAudit("replace").catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : "Retry failed."))} type="button">{zh ? "重试" : "Retry"}</button>
          </div>
        ) : null}

        {initialLoading ? (
          <section aria-live="polite" className="dashboard-v2-panel skills-loading" role="status">
            <p>{zh ? "正在读取工作区审计事件…" : "Loading workspace audit events…"}</p>
          </section>
        ) : (
          <>
      <section className="dashboard-v2-metric-grid audit-metrics">
        <AuditMetric detail={zh ? "工作区完整保留范围" : "Complete workspace retention scope"} label={zh ? "全部事件" : "All events"} tone="teal" value={snapshot?.metrics.total ?? 0} />
        <AuditMetric detail={zh ? "滚动时间窗口，不受服务器时区影响" : "Rolling window, independent of server timezone"} label={zh ? "最近 24 小时" : "Last 24 hours"} value={snapshot?.metrics.last24Hours ?? 0} />
        <AuditMetric detail={zh ? "审批、采纳与拒绝" : "Approvals, adoption, rejection"} label={zh ? "决策事件" : "Decision events"} tone="indigo" value={snapshot?.metrics.decisions ?? 0} />
        <AuditMetric detail={zh ? "失败、阻止、无效或过期" : "Failed, blocked, invalid, or expired"} label={zh ? "异常事件" : "Anomalies"} tone="warning" value={snapshot?.metrics.anomalies ?? 0} />
      </section>

      <div className="audit-skill-layout">
        <section className="dashboard-v2-panel audit-skill-table-panel">
          <header><div><p>WORKSPACE AUDIT</p><h2>{zh ? "统一事件列表" : "Unified event log"}</h2></div><span>{events.length} / {snapshot?.page.filteredTotal ?? 0}</span></header>
          <div className="audit-skill-toolbar">
            <label><span aria-hidden="true">⌕</span><input aria-label={zh ? "搜索审计事件" : "Search audit events"} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索事件、技能、操作者或代表" : "Search event, skill, actor, or representative"} value={query} /></label>
            <select aria-label={zh ? "筛选事件类型" : "Filter event type"} onChange={(event) => setEventType(event.target.value)} value={eventType}>
              <option value="all">{zh ? "全部事件" : "All events"}</option>
              {types.map((category) => <option key={category.id} value={category.id}>{categoryLabel(category.id, locale)} · {category.count}</option>)}
            </select>
          </div>
          <div className="dashboard-v2-table-scroll">
            <table className="dashboard-v2-table audit-skill-table">
              <thead><tr><th>{zh ? "时间" : "Time"}</th><th>{zh ? "事件" : "Event"}</th><th>{zh ? "资源" : "Resource"}</th><th>{zh ? "代表" : "Representative"}</th><th>{zh ? "操作者" : "Actor"}</th></tr></thead>
              <tbody>
                {events.map((event) => (
                  <tr
                    aria-selected={selected?.id === event.id}
                    className={selected?.id === event.id ? "is-selected" : undefined}
                    key={event.id}
                    onClick={() => setSelectedId(event.id)}
                    onKeyDown={(keyboardEvent) => {
                      if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                        keyboardEvent.preventDefault();
                        setSelectedId(event.id);
                      }
                    }}
                    tabIndex={0}
                  >
                    <td><time dateTime={event.createdAt}>{formatAuditTime(event.createdAt, locale)}</time></td>
                    <td><strong>{auditEventLabel(event.type, locale)}</strong><small>{categoryLabel(event.category, locale)}</small></td>
                    <td><strong>{event.resource?.kind ?? "—"}</strong><small>{event.resource?.id ?? "—"}</small></td>
                    <td>{event.representativeName}</td>
                    <td>{event.actor ?? (zh ? "系统" : "system")}</td>
                  </tr>
                ))}
                {!events.length ? <tr><td className="skills-empty-cell" colSpan={5}>{zh ? "没有匹配的工作区审计事件。" : "No matching workspace audit events."}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <footer className="dashboard-v2-table-footer">
            <span>{zh ? `已加载 ${events.length} / ${snapshot?.page.filteredTotal ?? 0}` : `Loaded ${events.length} / ${snapshot?.page.filteredTotal ?? 0}`}</span>
            <div>
              <button
                className="dashboard-v2-button-secondary"
                disabled={loading || loadingMore || !snapshot?.page.hasMore || !snapshot.page.nextCursor}
                onClick={() => void loadAudit("append", snapshot?.page.nextCursor).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : "Load more failed."))}
                type="button"
              >
                {loadingMore ? (zh ? "加载中…" : "Loading…") : (zh ? "加载更多" : "Load more")}
              </button>
            </div>
          </footer>
        </section>

        <aside className="dashboard-v2-panel audit-skill-detail">
          <header><div><p>EVENT DETAIL</p><h2>{selected ? auditEventLabel(selected.type, locale) : (zh ? "选择事件" : "Select an event")}</h2></div></header>
          {selected ? <dl className="skills-detail-facts">
            <div><dt>Event ID</dt><dd title={selected.id}>{selected.id.slice(0, 16)}…</dd></div>
            <div><dt>{zh ? "时间" : "Time"}</dt><dd>{new Date(selected.createdAt).toLocaleString(zh ? "zh-CN" : "en-US")}</dd></div>
            <div><dt>{zh ? "代表" : "Representative"}</dt><dd>{selected.representativeName}</dd></div>
            <div><dt>{zh ? "分类" : "Category"}</dt><dd>{categoryLabel(selected.category, locale)}</dd></div>
            <div><dt>{zh ? "资源" : "Resource"}</dt><dd>{selected.resource ? `${selected.resource.kind} · ${selected.resource.id}` : "—"}</dd></div>
            <div><dt>Trace ID</dt><dd>{selected.traceId ?? "—"}</dd></div>
            <div><dt>{zh ? "操作者" : "Actor"}</dt><dd>{selected.actor ?? (zh ? "系统" : "system")}</dd></div>
          </dl> : <p className="dashboard-v2-panel-description">{zh ? "从左侧列表选择一条记录。" : "Choose a record from the event list."}</p>}
          {selected ? <section className="dashboard-approval-block"><span>{zh ? "摘要" : "Summary"}</span><p>{selected.summary}</p></section> : null}
          <div className="skills-trust-note"><strong>{zh ? "披露边界" : "Disclosure boundary"}</strong><span>{zh ? "导出仅包含白名单元数据，不包含凭据、命令内容或原始敏感 payload。" : "Exports contain allowlisted metadata only, never credentials, command bodies, or raw sensitive payloads."}</span></div>
        </aside>
      </div>
          </>
        )}
      </div>
    </>
  );
}

function categoryLabel(category: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    skills: ["技能", "Skills"], publishing: ["发布", "Publishing"], approvals: ["审批", "Approvals"], wallet: ["钱包", "Wallet"], tools: ["工具", "Tools"], workflow: ["工作流", "Workflow"], conversation: ["会话", "Conversation"], security: ["安全", "Security"], other: ["其他", "Other"],
  };
  return labels[category]?.[locale === "zh" ? 0 : 1] ?? category;
}

function AuditMetric({ detail, label, tone = "neutral", value }: { detail: string; label: string; tone?: "neutral" | "teal" | "warning" | "indigo"; value: number }) {
  return <article className={`dashboard-v2-metric-card is-${tone}`}><div><span>{label}</span><i /></div><strong>{String(value).padStart(2, "0")}</strong><p>{detail}</p></article>;
}

function formatAuditTime(value: string, locale: Locale) {
  return new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function extractError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}
