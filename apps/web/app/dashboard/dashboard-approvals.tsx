"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const [message, setMessage] = useState<string | null>(null);
  const [pollingHealthy, setPollingHealthy] = useState(true);
  const [loading, setLoading] = useState(true);
  const [settledSlug, setSettledSlug] = useState<string | null>(null);
  const activeSlugRef = useRef(activeSlug);
  const requestSequenceRef = useRef(0);
  activeSlugRef.current = activeSlug;

  const refresh = useCallback(async (silent = false, signal?: AbortSignal) => {
    const requestId = ++requestSequenceRef.current;
    const requestedSlug = activeSlug;
    if (!silent) setError(null);
    if (!silent) setLoading(true);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(requestedSlug)}/compute/approvals`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      const payload = (await response.json().catch(() => ({}))) as RepresentativeComputeApprovalSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to load approvals.");
      if (
        signal?.aborted
        || activeSlugRef.current !== requestedSlug
        || requestSequenceRef.current !== requestId
      ) return;
      setError(null);
      setSnapshot(payload);
      setSettledSlug(requestedSlug);
      setPollingHealthy(true);
      setSelectedId((current) => current && payload.approvals.some((approval) => approval.id === current)
        ? current
        : payload.approvals[0]?.id ?? null);
    } catch (caught) {
      if (
        signal?.aborted
        || activeSlugRef.current !== requestedSlug
        || requestSequenceRef.current !== requestId
      ) return;
      throw caught;
    } finally {
      if (
        activeSlugRef.current === requestedSlug
        && requestSequenceRef.current === requestId
      ) setLoading(false);
    }
  }, [activeSlug]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setSelectedId(null);
    setMessage(null);
    void refresh(false, controller.signal).catch((caught) => {
      if (!controller.signal.aborted && activeSlugRef.current === activeSlug) {
        setSettledSlug(activeSlug);
        setError(caught instanceof Error ? caught.message : "Failed to load approvals.");
      }
    });
    const timer = window.setInterval(() => {
      void refresh(true).catch(() => setPollingHealthy(false));
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  const initialLoading = settledSlug !== activeSlug;

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
  useEffect(() => {
    setDecisionNote(selected?.decisionNote ?? "");
  }, [selected?.id, selected?.decisionNote]);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const highRisk = pending.filter((approval) => approval.riskScore >= 70);
  const expiringSoon = pending.filter((approval) => {
    const expiresAt = approval.expiresAt || approval.workflowScheduledAt;
    return expiresAt ? new Date(expiresAt).getTime() - Date.now() <= 30 * 60 * 1000 : false;
  });
  const resolved = approvals.filter((approval) => approval.status !== "pending");

  function selectApproval(approval: Approval) {
    setSelectedId(approval.id);
  }

  async function resolveApproval(resolution: "approved" | "rejected") {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(selected.representative.slug)}/compute/approvals/${encodeURIComponent(selected.id)}`,
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
      setMessage(resolution === "approved"
        ? (zh ? "审批已批准并记录。" : "Approval accepted and recorded.")
        : (zh ? "审批已拒绝并记录。" : "Approval rejected and recorded."));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to resolve approval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="dashboard-v2-page-header approvals-page-header">
        <div>
          <p>Approvals / Decisions</p>
          <h1>{zh ? "在执行或升级前看清风险，在决定后保留完整证据。" : "Understand risk before execution or adoption, then preserve the decision trail."}</h1>
          <span>{zh ? "Compute 请求与工作区技能候选版本共用决策队列；批准后的实际动作仍由各自的治理边界执行。" : "Compute requests and workspace skill candidates share one queue while each domain keeps its own execution boundary."}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button className="dashboard-v2-button-secondary" disabled={initialLoading || loading || busy} onClick={() => void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "Refresh failed."))} type="button">
            {loading && !initialLoading ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新" : "Refresh")}
          </button>
        </div>
      </header>

      <div aria-busy={initialLoading || loading || busy} className="dashboard-module-content">
      {error && !initialLoading ? <div className="dashboard-approval-alert" role="alert">{error}</div> : null}
      {message ? <div className="skills-banner is-success" role="status">{message}</div> : null}

      {initialLoading ? (
        <section aria-live="polite" className="dashboard-v2-panel skills-loading" role="status">
          <p>{zh ? "正在读取工作区审批队列…" : "Loading workspace approvals…"}</p>
        </section>
      ) : (
        <>
      <section className="dashboard-v2-metric-grid approvals-metrics">
        <ApprovalMetric label={zh ? "待审批" : "Pending"} value={pending.length} detail={zh ? "等待所有者决定" : "Awaiting owner decision"} tone="warning" />
        <ApprovalMetric label={zh ? "高风险" : "High risk"} value={highRisk.length} detail={zh ? "风险分 ≥ 70" : "Risk score ≥ 70"} />
        <ApprovalMetric label={zh ? "即将过期" : "Expiring soon"} value={expiringSoon.length} detail={zh ? "30 分钟内关闭" : "Closes within 30 min"} tone="indigo" />
        <ApprovalMetric label={zh ? "已解决" : "Resolved"} value={resolved.length} detail={zh ? "当前结果窗口" : "Current result window"} tone="teal" />
      </section>

      <div className="dashboard-approval-layout">
        <section className="dashboard-v2-panel">
          <header>
            <div><p>{zh ? "决策队列" : "Decision queue"}</p><h2>{zh ? "工作区审批记录" : "Workspace approval records"}</h2></div>
            <span className={`dashboard-approval-live${pollingHealthy ? "" : " is-stale"}`}>
              <i />{pollingHealthy ? (zh ? "每 5 秒同步" : "Syncs every 5s") : (zh ? "同步中断，请刷新" : "Sync interrupted; refresh")}
            </span>
          </header>
          <div className="dashboard-v2-toolbar">
            <div><span aria-hidden="true">⌕</span><input aria-label={zh ? "搜索审批" : "Search approvals"} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索操作、风险或联系人" : "Search action, risk, or contact"} value={query} /></div>
            <button aria-pressed={filter === "pending"} className={filter === "pending" ? "is-active" : undefined} onClick={() => setFilter("pending")} type="button">{zh ? "待审批" : "Pending"}</button>
            <button onClick={() => setFilter(filter === "all" ? "resolved" : "all")} type="button">{filter === "all" ? (zh ? "已解决" : "Resolved") : (zh ? "全部" : "All")}</button>
          </div>
          <div className="dashboard-v2-table-scroll">
            <table className="dashboard-v2-table dashboard-approval-table">
              <thead><tr><th>{zh ? "操作" : "Action"}</th><th>{zh ? "状态" : "Status"}</th><th>{zh ? "风险" : "Risk"}</th><th>{zh ? "请求时间" : "Requested"}</th></tr></thead>
              <tbody>
                {filtered.map((approval) => (
                  <tr
                    aria-selected={approval.id === selected?.id}
                    className={approval.id === selected?.id ? "is-selected" : undefined}
                    key={approval.id}
                    onClick={() => selectApproval(approval)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectApproval(approval);
                      }
                    }}
                    tabIndex={0}
                  >
                    <td><div className="dashboard-v2-row-primary"><i>{approval.kind === "skill_update" ? "SKILL" : approval.action?.capability?.toUpperCase() || "ACT"}</i><strong>{approval.requestedActionSummary}</strong></div><small>{approval.representative.displayName}</small></td>
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
                <div><dt>{zh ? "决策类型" : "Decision type"}</dt><dd>{selected.kind === "skill_update" ? (zh ? "技能版本升级" : "Skill release update") : (zh ? "Compute 执行" : "Compute execution")}</dd></div>
                <div><dt>{zh ? "数字代表" : "Representative"}</dt><dd>{selected.representative.displayName}</dd></div>
                <div><dt>{zh ? "委托任务 / 技能" : "Task / skill"}</dt><dd>{selected.skillRelease?.displayName || selected.task?.title || "—"}</dd></div>
                <div><dt>{zh ? "能力" : "Capability"}</dt><dd>{selected.action?.capability || selected.subagentId || "—"}</dd></div>
                <div><dt>{zh ? "联系人 / 来源" : "Contact / source"}</dt><dd>{selected.skillRelease?.source || selected.contact?.displayName || selected.customerAccount.displayName}</dd></div>
                <div><dt>{zh ? "风险分" : "Risk score"}</dt><dd>{selected.riskScore} / 100</dd></div>
                <div><dt>{zh ? "过期" : "Expires"}</dt><dd>{formatDate(selected.expiresAt || selected.workflowScheduledAt, locale)}</dd></div>
              </dl>
              {selected.skillRelease ? (
                <dl className="dashboard-approval-facts dashboard-skill-approval-facts">
                  <div><dt>{zh ? "版本变化" : "Version change"}</dt><dd>{selected.skillRelease.installedVersion ?? "—"} → {selected.skillRelease.candidateVersion}</dd></div>
                  <div><dt>{zh ? "签名状态" : "Signature"}</dt><dd>{signatureLabel(selected.skillRelease.signatureStatus, locale)}</dd></div>
                  <div>
                    <dt>{zh ? "Registry 信任" : "Registry trust"}</dt>
                    <dd>{approvalRegistryTrustLabel(selected.skillRelease.registryTrust, locale)}</dd>
                  </div>
                  <div><dt>{zh ? "新增权限" : "Added requirements"}</dt><dd>{selected.skillRelease.addedRequirements.join(", ") || (zh ? "无" : "None")}</dd></div>
                  <div><dt>{zh ? "启用绑定" : "Enabled bindings"}</dt><dd>{selected.skillRelease.enabledBindings}</dd></div>
                </dl>
              ) : null}
              {selected.skillRelease?.provenanceDigest ? (
                <DetailBlock
                  label={zh ? "版本证据摘要" : "Release evidence digest"}
                  mono
                  value={selected.skillRelease.provenanceDigest}
                />
              ) : null}
              {selected.skillRelease?.registryTrust?.reasons.length ? (
                <DetailBlock
                  label={zh ? "Registry 验证依据" : "Registry verification evidence"}
                  value={selected.skillRelease.registryTrust.reasons.join(", ")}
                />
              ) : null}
              {selected.skillRelease?.runtimeRequirementDiff.changed ? (
                <DetailBlock
                  label={zh ? "Manifest 运行要求差异" : "Manifest runtime requirement diff"}
                  value={[
                    ...(selected.skillRelease.runtimeRequirementDiff.added.length
                      ? [`${zh ? "新增" : "Added"}: ${selected.skillRelease.runtimeRequirementDiff.added.join(", ")}`]
                      : []),
                    ...(selected.skillRelease.runtimeRequirementDiff.removed.length
                      ? [`${zh ? "移除" : "Removed"}: ${selected.skillRelease.runtimeRequirementDiff.removed.join(", ")}`]
                      : []),
                  ].join("\n")}
                />
              ) : null}
              {selected.skillRelease?.sbomUrl || selected.skillRelease?.attestationUrl ? (
                <div className="skills-release-evidence">
                  {selected.skillRelease.sbomUrl ? <a href={selected.skillRelease.sbomUrl} rel="noreferrer" target="_blank">SBOM ↗</a> : null}
                  {selected.skillRelease.attestationUrl ? <a href={selected.skillRelease.attestationUrl} rel="noreferrer" target="_blank">Attestation ↗</a> : null}
                </div>
              ) : null}
              <DetailBlock label={zh ? "策略原因" : "Policy reason"} value={selected.reason} />
              <DetailBlock label={zh ? "确定性判定依据" : "Deterministic decision basis"} value={formatPolicyExplanation(selected, locale)} />
              <DetailBlock label={zh ? "匹配规则与请求指纹" : "Matched rule & request fingerprint"} value={`${selected.policy.matchedRuleId || "profile-default"}\n${selected.policy.requestFingerprint || "—"}`} mono />
              <DetailBlock label={zh ? "风险说明" : "Risk summary"} value={selected.riskSummary} />
              <DetailBlock label={zh ? "请求目标" : "Requested target"} value={selected.action?.requestedPath || selected.action?.requestedCommand || "—"} mono />
              {selected.status === "pending" ? (
                <div className="dashboard-approval-decision">
                  <label htmlFor="approval-note">{zh ? "审批备注（可选）" : "Decision note (optional)"}</label>
                  <textarea id="approval-note" maxLength={1000} onChange={(event) => setDecisionNote(event.target.value)} placeholder={zh ? "记录允许或拒绝的原因" : "Record why this is allowed or rejected"} value={decisionNote} />
                  <div><button className="dashboard-v2-button-secondary" disabled={busy} onClick={() => void resolveApproval("rejected")} type="button">{busy ? "…" : (zh ? "拒绝" : "Reject")}</button><button className="dashboard-v2-button-primary" disabled={busy} onClick={() => void resolveApproval("approved")} type="button">{busy ? "…" : selected.kind === "skill_update" ? (zh ? "批准并采纳版本" : "Approve & adopt") : (zh ? "批准并入队" : "Approve & queue")}</button></div>
                </div>
              ) : <DetailBlock label={zh ? "决策记录" : "Decision record"} value={[selected.resolvedBy, selected.decisionNote].filter(Boolean).join(" · ") || "—"} />}
            </>
          ) : <p className="dashboard-approval-empty">{zh ? "从左侧队列选择一条记录查看完整上下文。" : "Select a record from the queue to inspect its context."}</p>}
        </aside>
      </div>
        </>
      )}
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

function approvalRegistryTrustLabel(
  trust: NonNullable<Approval["skillRelease"]>["registryTrust"],
  locale: Locale,
) {
  if (!trust) return locale === "zh" ? "无官方验证记录" : "No official verification";
  if (trust.autoUpdateEligible) {
    return locale === "zh" ? "精确版本与 Manifest 已验证" : "Exact version and manifest verified";
  }
  if (trust.verified) {
    return locale === "zh" ? "身份已验证，证据不完整" : "Identity verified; evidence incomplete";
  }
  return locale === "zh" ? "未通过或证据不完整" : "Failed or incomplete";
}

function DetailBlock({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <section className="dashboard-approval-block"><span>{label}</span><p className={mono ? "is-mono" : undefined}>{value}</p></section>;
}

function riskTone(score: number) { return score >= 70 ? "high" : score >= 40 ? "medium" : "low"; }
function formatPolicyExplanation(approval: Approval, locale: Locale) {
  if (locale !== "zh") return approval.policy.explanation;
  if (approval.kind === "skill_update") return "候选版本必须通过可信签名或官方 Registry 精确版本验证、权限与 Manifest 运行要求差异、工作区更新策略检查，才可采纳为当前安装版本。";
  const reason = approval.policy.explanation.includes("human_approval_required")
    ? "该操作要求所有者明确批准。"
    : approval.policy.explanation.split(". ").at(-1)?.replaceAll("_", " ") || "策略要求人工审批。";
  return approval.policy.matchedRuleId
    ? `确定性策略规则“${approval.policy.matchedRuleId}”返回 ASK。${reason}`
    : `当前生效的默认策略或托管覆盖规则返回 ASK。${reason}`;
}

function signatureLabel(status: string, locale: Locale) {
  const labels = locale === "zh"
    ? { verified: "签名已验证", unverified: "有签名，密钥未受信", unavailable: "来源未提供签名", invalid: "签名无效" }
    : { verified: "Verified", unverified: "Signature present, key not trusted", unavailable: "No signature provided", invalid: "Invalid signature" };
  return labels[status as keyof typeof labels] ?? status;
}
function formatDate(value: string | undefined, locale: Locale) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
