"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { RepresentativeComputeApprovalSnapshot } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type Approval = RepresentativeComputeApprovalSnapshot["approvals"][number];

export function DashboardApprovals({ activeSlug, locale }: { activeSlug: string; locale: Locale }) {
  const zh = locale === "zh";
  const [snapshot, setSnapshot] = useState<RepresentativeComputeApprovalSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "resolved">("pending");
  const [query, setQuery] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    const response = await fetch(
      `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/compute/approvals`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => ({}))) as RepresentativeComputeApprovalSnapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Failed to load approvals.");
    setSnapshot(payload);
    setSelectedId((current) => current && payload.approvals.some((approval) => approval.id === current)
      ? current
      : payload.approvals[0]?.id ?? null);
  }, [activeSlug]);

  useEffect(() => {
    void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load approvals."));
    const timer = window.setInterval(() => {
      void refresh(true).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const approvals = snapshot?.approvals ?? [];
  const filtered = useMemo(() => approvals.filter((approval) => {
    if (filter === "pending" && approval.status !== "pending") return false;
    if (filter === "resolved" && approval.status === "pending") return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [approval.requestedActionSummary, approval.riskSummary, approval.action?.capability, approval.contact?.displayName, approval.task?.title]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(needle));
  }), [approvals, filter, query]);
  const selected = filtered.find((approval) => approval.id === selectedId) ?? filtered[0] ?? null;
  const pending = approvals.filter((approval) => approval.status === "pending");
  const highRisk = pending.filter((approval) => approval.riskScore >= 70);
  const expiringSoon = pending.filter((approval) => {
    const expiresAt = approval.expiresAt || approval.workflowScheduledAt;
    return expiresAt ? new Date(expiresAt).getTime() - Date.now() <= 30 * 60 * 1000 : false;
  });
  const resolved = approvals.filter((approval) => approval.status !== "pending");

  async function resolveApproval(resolution: "approved" | "rejected") {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/compute/approvals/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution, ...(decisionNote.trim() ? { decisionNote: decisionNote.trim() } : {}) }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to resolve approval.");
      setDecisionNote("");
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to resolve approval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="dashboard-v2-page-header">
        <div>
          <p>Approvals / Compute</p>
          <h1>{zh ? "在执行前看清风险，在决定后保留完整证据。" : "Understand the risk before execution and preserve the decision trail."}</h1>
          <span>{zh ? "公开聊天触发的 Compute 请求会在这里等待审批；通过后异步执行，并自动把结果返回原会话。" : "Compute requests from public chat wait here. Approved work runs asynchronously and reports back to the original conversation."}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button className="dashboard-v2-button-secondary" onClick={() => void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "Refresh failed."))} type="button">
            {zh ? "刷新" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="dashboard-v2-metric-grid">
        <ApprovalMetric label={zh ? "待审批" : "Pending"} value={pending.length} detail={zh ? "等待所有者决定" : "Awaiting owner decision"} tone="warning" />
        <ApprovalMetric label={zh ? "高风险" : "High risk"} value={highRisk.length} detail={zh ? "风险分 ≥ 70" : "Risk score ≥ 70"} />
        <ApprovalMetric label={zh ? "即将过期" : "Expiring soon"} value={expiringSoon.length} detail={zh ? "30 分钟内关闭" : "Closes within 30 min"} tone="indigo" />
        <ApprovalMetric label={zh ? "已解决" : "Resolved"} value={resolved.length} detail={zh ? "当前结果窗口" : "Current result window"} tone="teal" />
      </section>

      {error ? <div className="dashboard-approval-alert" role="alert">{error}</div> : null}

      <div className="dashboard-approval-layout">
        <section className="dashboard-v2-panel">
          <header>
            <div><p>{zh ? "决策队列" : "Decision queue"}</p><h2>{zh ? "Compute 审批记录" : "Compute approval records"}</h2></div>
            <span className="dashboard-approval-live"><i />{zh ? "每 5 秒同步" : "Syncs every 5s"}</span>
          </header>
          <div className="dashboard-v2-toolbar">
            <div><span>⌕</span><input aria-label={zh ? "搜索审批" : "Search approvals"} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索操作、风险或联系人" : "Search action, risk, or contact"} value={query} /></div>
            <button className={filter === "pending" ? "is-active" : undefined} onClick={() => setFilter("pending")} type="button">{zh ? "待审批" : "Pending"}</button>
            <button onClick={() => setFilter(filter === "all" ? "resolved" : "all")} type="button">{filter === "all" ? (zh ? "已解决" : "Resolved") : (zh ? "全部" : "All")}</button>
          </div>
          <div className="dashboard-v2-table-scroll">
            <table className="dashboard-v2-table dashboard-approval-table">
              <thead><tr><th>{zh ? "操作" : "Action"}</th><th>{zh ? "状态" : "Status"}</th><th>{zh ? "风险" : "Risk"}</th><th>{zh ? "请求时间" : "Requested"}</th></tr></thead>
              <tbody>
                {filtered.map((approval) => (
                  <tr className={approval.id === selected?.id ? "is-selected" : undefined} key={approval.id} onClick={() => { setSelectedId(approval.id); setDecisionNote(approval.decisionNote ?? ""); }}>
                    <td><div className="dashboard-v2-row-primary"><i>{approval.action?.capability?.toUpperCase() || "ACT"}</i><strong>{approval.requestedActionSummary}</strong></div></td>
                    <td><ApprovalStatus status={approval.status} zh={zh} /></td>
                    <td><span className={`dashboard-approval-risk is-${riskTone(approval.riskScore)}`}>{approval.riskScore}</span></td>
                    <td>{formatDate(approval.requestedAt, locale)}</td>
                  </tr>
                ))}
                {!filtered.length ? <tr><td className="dashboard-approval-empty" colSpan={4}>{zh ? "当前筛选下没有审批记录。" : "No approvals match the current filter."}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="dashboard-v2-panel dashboard-approval-detail">
          <header><div><p>{zh ? "审批详情" : "Approval detail"}</p><h2>{selected?.requestedActionSummary || (zh ? "选择一条审批" : "Select an approval")}</h2></div>{selected ? <ApprovalStatus status={selected.status} zh={zh} /> : null}</header>
          {selected ? (
            <>
              <dl className="dashboard-approval-facts">
                <div><dt>{zh ? "委托任务" : "Task"}</dt><dd>{selected.task?.title || "—"}</dd></div>
                <div><dt>{zh ? "能力" : "Capability"}</dt><dd>{selected.action?.capability || selected.subagentId || "—"}</dd></div>
                <div><dt>{zh ? "联系人" : "Contact"}</dt><dd>{selected.contact?.displayName || selected.customerAccount.displayName}</dd></div>
                <div><dt>{zh ? "风险分" : "Risk score"}</dt><dd>{selected.riskScore} / 100</dd></div>
                <div><dt>{zh ? "过期" : "Expires"}</dt><dd>{formatDate(selected.expiresAt || selected.workflowScheduledAt, locale)}</dd></div>
              </dl>
              <DetailBlock label={zh ? "策略原因" : "Policy reason"} value={selected.reason} />
              <DetailBlock label={zh ? "确定性判定依据" : "Deterministic decision basis"} value={formatPolicyExplanation(selected.policy, locale)} />
              <DetailBlock label={zh ? "匹配规则与请求指纹" : "Matched rule & request fingerprint"} value={`${selected.policy.matchedRuleId || "profile-default"}\n${selected.policy.requestFingerprint || "—"}`} mono />
              <DetailBlock label={zh ? "风险说明" : "Risk summary"} value={selected.riskSummary} />
              <DetailBlock label={zh ? "请求目标" : "Requested target"} value={selected.action?.requestedPath || selected.action?.requestedCommand || "—"} mono />
              {selected.status === "pending" ? (
                <div className="dashboard-approval-decision">
                  <label htmlFor="approval-note">{zh ? "审批备注（可选）" : "Decision note (optional)"}</label>
                  <textarea id="approval-note" maxLength={1000} onChange={(event) => setDecisionNote(event.target.value)} placeholder={zh ? "记录允许或拒绝的原因" : "Record why this is allowed or rejected"} value={decisionNote} />
                  <div><button className="dashboard-v2-button-secondary" disabled={busy} onClick={() => void resolveApproval("rejected")} type="button">{busy ? "…" : (zh ? "拒绝" : "Reject")}</button><button className="dashboard-v2-button-primary" disabled={busy} onClick={() => void resolveApproval("approved")} type="button">{busy ? "…" : (zh ? "批准并入队" : "Approve & queue")}</button></div>
                </div>
              ) : <DetailBlock label={zh ? "决策记录" : "Decision record"} value={[selected.resolvedBy, selected.decisionNote].filter(Boolean).join(" · ") || "—"} />}
            </>
          ) : <p className="dashboard-approval-empty">{zh ? "从左侧队列选择一条记录查看完整上下文。" : "Select a record from the queue to inspect its context."}</p>}
        </aside>
      </div>
    </>
  );
}

function ApprovalMetric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: string }) {
  return <article className={`dashboard-v2-metric-card${tone ? ` is-${tone}` : ""}`}><div><span>{label}</span><i /></div><strong>{String(value).padStart(2, "0")}</strong><p>{detail}</p></article>;
}

function ApprovalStatus({ status, zh }: { status: string; zh: boolean }) {
  const labels: Record<string, string> = zh
    ? { pending: "待审批", approved: "已批准", rejected: "已拒绝", expired: "已过期" }
    : { pending: "Pending", approved: "Approved", rejected: "Rejected", expired: "Expired" };
  return <span className={`dashboard-approval-status is-${status}`}>{labels[status] || status}</span>;
}

function DetailBlock({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <section className="dashboard-approval-block"><span>{label}</span><p className={mono ? "is-mono" : undefined}>{value}</p></section>;
}

function riskTone(score: number) { return score >= 70 ? "high" : score >= 40 ? "medium" : "low"; }
function formatPolicyExplanation(policy: Approval["policy"], locale: Locale) {
  if (locale !== "zh") return policy.explanation;
  const reason = policy.explanation.includes("human_approval_required")
    ? "该操作要求所有者明确批准。"
    : policy.explanation.split(". ").at(-1)?.replaceAll("_", " ") || "策略要求人工审批。";
  return policy.matchedRuleId
    ? `确定性策略规则“${policy.matchedRuleId}”返回 ASK。${reason}`
    : `当前生效的默认策略或托管覆盖规则返回 ASK。${reason}`;
}
function formatDate(value: string | undefined, locale: Locale) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
