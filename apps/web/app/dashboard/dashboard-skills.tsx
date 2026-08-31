"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import type { WorkspaceSkillSnapshot } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type Skill = WorkspaceSkillSnapshot["skills"][number];
type SkillRelease = Skill["releases"][number];
type Tab = "installed" | "registry" | "connections" | "policy";
type RegistrySkill = {
  slug: string;
  displayName: string;
  summary: string;
  version?: string;
  sourceUrl?: string;
  capabilityTags: string[];
};
type ManagedMcpBinding = {
  id: string;
  updatedAt: string;
  representativeSkillPackLinkId: string | null;
  slug: string;
  displayName: string;
  description: string | null;
  serverUrl: string;
  transportKind: "streamable_http" | "sse";
  allowedToolNames: string[];
  defaultToolName: string | null;
  enabled: boolean;
  approvalRequired: boolean;
  estimatedTokensPerCall: number;
  maxRetries: number;
  retryBackoffMs: number;
};
type McpBindingForm = {
  bindingId: string | null;
  expectedUpdatedAt: string | null;
  representativeSkillPackLinkId: string;
  slug: string;
  displayName: string;
  description: string;
  serverUrl: string;
  transportKind: "streamable_http" | "sse";
  allowedToolNames: string;
  defaultToolName: string;
  enabled: boolean;
  approvalRequired: boolean;
};

const emptyMcpBindingForm: McpBindingForm = {
  bindingId: null,
  expectedUpdatedAt: null,
  representativeSkillPackLinkId: "",
  slug: "",
  displayName: "",
  description: "",
  serverUrl: "",
  transportKind: "streamable_http",
  allowedToolNames: "",
  defaultToolName: "",
  enabled: true,
  approvalRequired: true,
};

export function DashboardSkills({ activeSlug, locale }: { activeSlug: string; locale: Locale }) {
  const zh = locale === "zh";
  const [snapshot, setSnapshot] = useState<WorkspaceSkillSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("installed");
  const [selectedInstallId, setSelectedInstallId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryResults, setRegistryResults] = useState<RegistrySkill[]>([]);
  const [registrySearched, setRegistrySearched] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const activeSlugRef = useRef(activeSlug);
  const snapshotRequestSequenceRef = useRef(0);
  const registryRequestSequenceRef = useRef(0);
  activeSlugRef.current = activeSlug;

  useEffect(() => {
    const controller = new AbortController();
    registryRequestSequenceRef.current += 1;
    void refreshSnapshot(activeSlug, controller.signal);
    return () => controller.abort();
  }, [activeSlug]);

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!snapshot || !normalized) return snapshot?.skills ?? [];
    return snapshot.skills.filter((skill) =>
      [skill.displayName, skill.slug, skill.summary, skill.source, ...skill.capabilityTags]
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [query, snapshot]);
  const selectedSkill = visibleSkills.find((skill) => skill.installId === selectedInstallId)
    ?? visibleSkills[0]
    ?? null;

  async function refreshSnapshot(representativeSlug = activeSlug, signal?: AbortSignal) {
    const requestId = ++snapshotRequestSequenceRef.current;
    setError(null);
    try {
      const response = await fetch(`/api/dashboard/skills?rep=${encodeURIComponent(representativeSlug)}`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await extractError(response));
      const nextSnapshot = (await response.json()) as WorkspaceSkillSnapshot;
      if (
        signal?.aborted
        || activeSlugRef.current !== representativeSlug
        || snapshotRequestSequenceRef.current !== requestId
      ) return;
      setSnapshot(nextSnapshot);
      setSelectedInstallId((current) => current && nextSnapshot.skills.some((skill) => skill.installId === current)
        ? current
        : nextSnapshot.skills[0]?.installId ?? null);
    } catch (nextError) {
      if (
        signal?.aborted
        || activeSlugRef.current !== representativeSlug
        || snapshotRequestSequenceRef.current !== requestId
      ) return;
      setError(nextError instanceof Error ? nextError.message : (zh ? "技能数据加载失败。" : "Failed to load skills."));
    }
  }

  function searchRegistry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedSlug = activeSlug;
    const requestId = ++registryRequestSequenceRef.current;
    const requestedQuery = registryQuery.trim();
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const params = new URLSearchParams({ limit: "12" });
        if (requestedQuery) params.set("query", requestedQuery);
        const response = await fetch(`/api/registry/clawhub/skills?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await extractError(response));
        const payload = (await response.json()) as { results?: RegistrySkill[] };
        if (
          activeSlugRef.current !== requestedSlug
          || registryRequestSequenceRef.current !== requestId
        ) return;
        setRegistryResults(payload.results ?? []);
        setRegistrySearched(true);
      } catch (nextError) {
        if (
          activeSlugRef.current !== requestedSlug
          || registryRequestSequenceRef.current !== requestId
        ) return;
        setError(nextError instanceof Error ? nextError.message : (zh ? "技能市场搜索失败。" : "Registry search failed."));
      }
    });
  }

  function syncRegistrySkill(skill: RegistrySkill, alreadyInstalled = false) {
    setBusyKey(`install:${skill.slug}`);
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/dashboard/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeSlug: activeSlug, skillPackSlug: skill.slug }),
        });
        if (!response.ok) throw new Error(await extractError(response));
        const payload = (await response.json()) as {
          install?: { status?: "installed" | "update_available" };
        };
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        setActiveTab("installed");
        setMessage(alreadyInstalled
          ? payload.install?.status === "update_available"
            ? (zh
                ? `${skill.displayName} 已发现新版本，候选版本已进入审批。当前已安装版本继续可用。`
                : `${skill.displayName} has a new candidate release awaiting review. The installed version remains usable.`)
            : (zh
                ? `${skill.displayName} 已检查，当前没有新的可审核版本。`
                : `${skill.displayName} is up to date; no new reviewable release was found.`)
          : (zh
              ? `${skill.displayName} 已安装到工作区；尚未绑定代表，也未新增任何运行权限。`
              : `${skill.displayName} is installed in the workspace, without a representative binding or new runtime authority.`));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "安装失败。" : "Installation failed."));
      } finally {
        setBusyKey(null);
      }
    });
  }

  function checkInstalledSkill(skill: Skill) {
    syncRegistrySkill({
      slug: skill.slug,
      displayName: skill.displayName,
      summary: skill.summary,
      ...(skill.latestVersion ? { version: skill.latestVersion } : {}),
      ...(skill.sourceUrl ? { sourceUrl: skill.sourceUrl } : {}),
      capabilityTags: skill.capabilityTags,
    }, true);
  }

  function checkAllUpdates() {
    const registrySkills = snapshot?.skills.filter(
      (skill) => skill.source === "clawhub" && skill.status !== "archived",
    ) ?? [];
    if (!registrySkills.length) {
      setMessage(zh ? "当前没有可检查更新的 ClawHub 技能。" : "There are no active ClawHub skills to check.");
      return;
    }
    setBusyKey("check-all");
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const results = await Promise.allSettled(registrySkills.map(async (skill) => {
        const response = await fetch("/api/dashboard/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeSlug: activeSlug, skillPackSlug: skill.slug }),
        });
        if (!response.ok) throw new Error(`${skill.displayName}: ${await extractError(response)}`);
        return (await response.json()) as { install?: { status?: string } };
      }));
      try {
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        const failures = results.flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : [],
        );
        const updates = results.filter(
          (result) => result.status === "fulfilled" && result.value.install?.status === "update_available",
        ).length;
        if (failures.length) {
          setError(zh
            ? `已完成部分检查；${failures.length} 项失败：${failures.join("；")}`
            : `Update check completed with ${failures.length} failure(s): ${failures.join("; ")}`);
        }
        setMessage(zh
          ? `已检查 ${registrySkills.length} 个技能，发现 ${updates} 个待审核更新。`
          : `Checked ${registrySkills.length} skill(s); ${updates} update(s) require review.`);
      } finally {
        setBusyKey(null);
      }
    });
  }

  function updateBinding(skill: Skill, representativeSlug: string, enabled: boolean) {
    const key = `binding:${skill.installId}:${representativeSlug}`;
    setBusyKey(key);
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/dashboard/skills/${encodeURIComponent(skill.installId)}/bindings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeSlug, enabled }),
        });
        if (!response.ok) throw new Error(await extractError(response));
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        setMessage(zh
          ? `${enabled ? "已绑定" : "已停用"} ${skill.displayName}；变更已进入代表草稿，发布新版本后才影响公开运行时。`
          : `${skill.displayName} ${enabled ? "bound" : "disabled"}. The draft change reaches the public runtime only after publishing a new version.`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "绑定更新失败。" : "Binding update failed."));
      } finally {
        setBusyKey(null);
      }
    });
  }

  function reviewRelease(skill: Skill, release: SkillRelease, action: "adopt" | "reject" | "rollback") {
    const key = `release:${release.id}:${action}`;
    setBusyKey(key);
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/dashboard/skills/${encodeURIComponent(skill.installId)}/releases/${encodeURIComponent(release.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ representativeSlug: activeSlug, action }),
          },
        );
        if (!response.ok) throw new Error(await extractError(response));
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        const actionLabel = zh
          ? { adopt: "已采纳", reject: "已拒绝", rollback: "已回滚到" }[action]
          : { adopt: "Adopted", reject: "Rejected", rollback: "Rolled back to" }[action];
        setMessage(`${actionLabel} ${skill.displayName} v${release.version}。${zh ? "已绑定代表仍需重新发布版本才会影响公开运行时。" : "Bound representatives still require a new publish before the public runtime changes."}`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "版本操作失败。" : "Release action failed."));
      } finally {
        setBusyKey(null);
      }
    });
  }

  function updateArchived(skill: Skill, archived: boolean) {
    const key = `archive:${skill.installId}`;
    setBusyKey(key);
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/dashboard/skills/${encodeURIComponent(skill.installId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeSlug: activeSlug, archived }),
        });
        if (!response.ok) throw new Error(await extractError(response));
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        setMessage(archived
          ? (zh ? `${skill.displayName} 已归档，可随时恢复。` : `${skill.displayName} was archived and can be restored.`)
          : (zh ? `${skill.displayName} 已恢复到工作区。` : `${skill.displayName} was restored to the workspace.`));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "归档操作失败。" : "Archive action failed."));
      } finally {
        setBusyKey(null);
      }
    });
  }

  function updatePolicy(skill: Skill, updatePolicy: Skill["updatePolicy"]) {
    const key = `policy:${skill.installId}`;
    setBusyKey(key);
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/dashboard/skills/${encodeURIComponent(skill.installId)}/policy`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representativeSlug: activeSlug, updatePolicy }),
        });
        if (!response.ok) throw new Error(await extractError(response));
        await refreshSnapshot(activeSlug);
        if (activeSlugRef.current !== activeSlug) return;
        setMessage(zh
          ? `${skill.displayName} 的更新策略已保存。自动补丁更新仍要求可信 Ed25519 签名或官方 Registry 精确版本验证，且权限与 Manifest 运行要求不能变化。`
          : `${skill.displayName} update policy saved. Automatic patches still require a trusted Ed25519 signature or exact-version official Registry verification, with no permission or manifest requirement changes.`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "更新策略保存失败。" : "Failed to save update policy."));
      } finally {
        setBusyKey(null);
      }
    });
  }

  if (!snapshot) {
    return (
      <section className="dashboard-v2-panel skills-loading" aria-live="polite">
        <p>{zh ? "正在读取工作区技能、连接与策略…" : "Loading workspace skills, connections, and policy…"}</p>
        {error ? <div className="skills-banner is-error">{error}</div> : null}
        {error ? (
          <button className="dashboard-v2-button-secondary" onClick={() => void refreshSnapshot()} type="button">
            {zh ? "重试" : "Retry"}
          </button>
        ) : null}
      </section>
    );
  }

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "installed", label: zh ? "已安装技能" : "Installed", count: snapshot.metrics.installed },
    { id: "registry", label: zh ? "技能市场" : "Registry" },
    { id: "connections", label: "MCP / Compute", count: snapshot.connections.length },
    { id: "policy", label: zh ? "权限策略" : "Policy" },
  ];

  return (
    <>
      <header className="dashboard-v2-page-header skills-page-header">
        <div>
          <p>SKILLS &amp; TOOLS / 05</p>
          <h1>{zh ? "扩展能力，但不扩大代表的默认权限。" : "Extend capability without expanding default authority."}</h1>
          <span>{zh
            ? "先安装到工作区，再绑定到代表草稿；技能声明、MCP 连接、Compute 策略与发布版本保持独立治理。"
            : "Install to the workspace, then bind to a representative draft. Skill declarations, MCP connections, compute policy, and published versions remain independently governed."}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button className="dashboard-v2-button-secondary" disabled={isPending} onClick={() => void refreshSnapshot()} type="button">
            {zh ? "刷新状态" : "Refresh"}
          </button>
          <button className="dashboard-v2-button-secondary" disabled={isPending || busyKey === "check-all"} onClick={checkAllUpdates} type="button">
            {busyKey === "check-all" ? (zh ? "检查中…" : "Checking…") : (zh ? "检查全部更新" : "Check all updates")}
          </button>
          <button className="dashboard-v2-button-primary" onClick={() => setActiveTab("registry")} type="button">
            + {zh ? "浏览技能市场" : "Browse registry"}
          </button>
        </div>
      </header>

      <div className="skills-trust-note">
        <strong>{zh ? "信任边界" : "Trust boundary"}</strong>
        <span>{zh
          ? "第三方技能在当前阶段只导入声明与来源元数据；不会执行第三方代码，也不会绕过审批、网络或文件系统策略。"
          : "Third-party skills currently import declarations and provenance only. They do not execute third-party code or bypass approval, network, or filesystem policy."}</span>
      </div>

      {message ? <div className="skills-banner is-success" role="status">{message}</div> : null}
      {error ? <div className="skills-banner is-error" role="alert">{error}</div> : null}

      <nav className="dashboard-v2-subnav" aria-label={zh ? "技能与工具视图" : "Skills and tools views"}>
        {tabs.map((tab) => (
          <button aria-current={activeTab === tab.id ? "page" : undefined} className={activeTab === tab.id ? "is-active" : undefined} key={tab.id} onClick={() => setActiveTab(tab.id)} type="button">
            {tab.label}{typeof tab.count === "number" ? ` ${String(tab.count).padStart(2, "0")}` : ""}
          </button>
        ))}
      </nav>

      <section className="dashboard-v2-metric-grid skills-metrics">
        <SkillMetric detail={zh ? "工作区可治理技能" : "Workspace-governed skills"} label={zh ? "已安装" : "Installed"} value={snapshot.metrics.installed} tone="teal" />
        <SkillMetric detail={zh ? "跨全部对外代理" : "Across all representatives"} label={zh ? "已启用绑定" : "Enabled bindings"} value={snapshot.metrics.enabledBindings} />
        <SkillMetric detail={zh ? "能力策略为 Ask" : "Capabilities in Ask mode"} label={zh ? "审批保护" : "Approval protected"} value={snapshot.metrics.approvalProtected} tone="warning" />
        <SkillMetric detail={zh ? "需审核后才能启用" : "Review before enabling"} label={zh ? "更新可用" : "Updates"} value={snapshot.metrics.updates} tone="indigo" />
      </section>

      {activeTab === "installed" ? (
        <InstalledSkills
          busyKey={busyKey}
          locale={locale}
          onArchiveChange={updateArchived}
          onBindingChange={updateBinding}
          onCheckUpdate={checkInstalledSkill}
          onQueryChange={setQuery}
          onPolicyChange={updatePolicy}
          onReleaseAction={reviewRelease}
          onSelect={setSelectedInstallId}
          query={query}
          selectedSkill={selectedSkill}
          skills={visibleSkills}
          snapshot={snapshot}
        />
      ) : activeTab === "registry" ? (
        <RegistryPanel
          busyKey={busyKey}
          installedSlugs={new Set(snapshot.skills.map((skill) => skill.slug))}
          isPending={isPending}
          locale={locale}
          onInstall={syncRegistrySkill}
          onQueryChange={setRegistryQuery}
          onSubmit={searchRegistry}
          query={registryQuery}
          searched={registrySearched}
          results={registryResults}
        />
      ) : activeTab === "connections" ? (
        <ConnectionsPanel
          activeSlug={activeSlug}
          locale={locale}
          onRefresh={() => refreshSnapshot(activeSlug)}
          snapshot={snapshot}
        />
      ) : (
        <PolicyPanel activeSlug={activeSlug} locale={locale} snapshot={snapshot} />
      )}
    </>
  );
}

function InstalledSkills({
  busyKey,
  locale,
  onArchiveChange,
  onBindingChange,
  onCheckUpdate,
  onQueryChange,
  onPolicyChange,
  onReleaseAction,
  onSelect,
  query,
  selectedSkill,
  skills,
  snapshot,
}: {
  busyKey: string | null;
  locale: Locale;
  onArchiveChange: (skill: Skill, archived: boolean) => void;
  onBindingChange: (skill: Skill, representativeSlug: string, enabled: boolean) => void;
  onCheckUpdate: (skill: Skill) => void;
  onQueryChange: (value: string) => void;
  onPolicyChange: (skill: Skill, updatePolicy: Skill["updatePolicy"]) => void;
  onReleaseAction: (skill: Skill, release: SkillRelease, action: "adopt" | "reject" | "rollback") => void;
  onSelect: (installId: string) => void;
  query: string;
  selectedSkill: Skill | null;
  skills: Skill[];
  snapshot: WorkspaceSkillSnapshot;
}) {
  const zh = locale === "zh";
  return (
    <div className="skills-installed-layout">
      <section className="dashboard-v2-panel skills-list-panel">
        <header>
          <div><p>SKILLS &amp; TOOLS</p><h2>{zh ? "工作区安装清单" : "Workspace installations"}</h2></div>
          <span>{skills.length} / {snapshot.skills.length}</span>
        </header>
        <label className="skills-search">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">{zh ? "搜索已安装技能" : "Search installed skills"}</span>
          <input onChange={(event) => onQueryChange(event.target.value)} placeholder={zh ? "搜索名称、来源或能力标签" : "Search name, source, or capability"} value={query} />
        </label>
        <div className="dashboard-v2-table-scroll">
          <table className="dashboard-v2-table skills-table">
            <thead><tr><th>{zh ? "技能" : "Skill"}</th><th>{zh ? "来源 / 版本" : "Source / version"}</th><th>{zh ? "状态" : "Status"}</th><th>{zh ? "风险" : "Risk"}</th><th>{zh ? "代表绑定" : "Bindings"}</th></tr></thead>
            <tbody>
              {skills.map((skill, index) => (
                <tr
                  aria-selected={selectedSkill?.installId === skill.installId}
                  className={selectedSkill?.installId === skill.installId ? "is-selected" : undefined}
                  key={skill.installId}
                  onClick={() => onSelect(skill.installId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(skill.installId);
                    }
                  }}
                  tabIndex={0}
                >
                  <td><div className="dashboard-v2-row-primary"><i>{String(index + 1).padStart(2, "0")}</i><strong>{skill.displayName}</strong></div><small>{skill.slug}</small></td>
                  <td><strong>{sourceLabel(skill.source)}</strong><small>{skill.installedVersion ? `v${skill.installedVersion}` : "—"}</small></td>
                  <td>
                    <StatusPill status={skill.readiness} locale={locale} />
                    {skill.status === "update_available" ? (
                      <small className="skills-update-available">{zh ? "有更新待审核" : "Update awaiting review"}</small>
                    ) : null}
                  </td>
                  <td><span className={`skills-risk is-${skill.risk}`}>{riskLabel(skill.risk, locale)}</span></td>
                  <td>{skill.bindings.filter((binding) => binding.enabled).length} / {snapshot.representatives.length}</td>
                </tr>
              ))}
              {!skills.length ? <tr><td className="skills-empty-cell" colSpan={5}>{zh ? "没有匹配的已安装技能。" : "No installed skills match this search."}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="dashboard-v2-panel skills-detail-panel">
        {selectedSkill ? (
          <>
            <header><div><p>01 / SKILL DETAIL</p><h2>{selectedSkill.displayName}</h2></div><StatusPill status={selectedSkill.readiness} locale={locale} /></header>
            <p className="skills-detail-summary">{selectedSkill.summary}</p>
            <dl className="skills-detail-facts">
              <div><dt>{zh ? "安装版本" : "Installed version"}</dt><dd>{selectedSkill.installedVersion ?? "—"}</dd></div>
              <div><dt>{zh ? "最新版本" : "Latest version"}</dt><dd>{selectedSkill.latestVersion ?? "—"}</dd></div>
              <div><dt>{zh ? "审核状态" : "Review"}</dt><dd>{reviewLabel(selectedSkill.reviewStatus, locale)}</dd></div>
              <div><dt>{zh ? "代码执行" : "Code execution"}</dt><dd>{selectedSkill.executesCode ? (zh ? "已阻止" : "Blocked") : (zh ? "不执行" : "Not executed")}</dd></div>
            </dl>
            <section className="skills-detail-section skills-update-policy">
              <h3>{zh ? "更新策略" : "Update policy"}</h3>
              <p>{zh ? "更新检查与采纳策略彼此独立；自动补丁仍要求可信来源、语义版本仅增加 patch，且没有新增受治理能力。" : "Discovery and adoption are separate. Automatic patches still require a trusted source, a patch-only semantic version increase, and no new governed capability."}</p>
              <select
                aria-label={zh ? "技能更新策略" : "Skill update policy"}
                disabled={busyKey === `policy:${selectedSkill.installId}`}
                onChange={(event) => onPolicyChange(selectedSkill, event.target.value as Skill["updatePolicy"])}
                value={selectedSkill.updatePolicy}
              >
                <option value="manual">{zh ? "发现后手动采纳" : "Manual adoption"}</option>
                <option value="review_required">{zh ? "发现后进入审批" : "Approval required"}</option>
                <option value="patch_auto">{zh ? "可信补丁自动采纳" : "Auto-adopt trusted patches"}</option>
              </select>
              {selectedSkill.source === "clawhub" && selectedSkill.status !== "archived" ? (
                <button
                  className="dashboard-v2-button-secondary skills-check-update"
                  disabled={busyKey === `install:${selectedSkill.slug}`}
                  onClick={() => onCheckUpdate(selectedSkill)}
                  type="button"
                >
                  {busyKey === `install:${selectedSkill.slug}`
                    ? (zh ? "检查中…" : "Checking…")
                    : (zh ? "立即检查更新" : "Check for updates")}
                </button>
              ) : null}
            </section>
            <SkillReleaseGovernance
              busyKey={busyKey}
              locale={locale}
              onAction={onReleaseAction}
              skill={selectedSkill}
            />
            <section className="skills-detail-section">
              <h3>{zh ? "声明的能力要求" : "Declared requirements"}</h3>
              <div className="skills-tag-row">
                {(selectedSkill.requirements.length ? selectedSkill.requirements : [zh ? "无额外能力" : "none"]).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
              <p>{selectedSkill.readinessReason}</p>
            </section>
            <section className="skills-detail-section">
              <h3>{zh ? "绑定到代表草稿" : "Bind to representative drafts"}</h3>
              <p>{zh ? "绑定只声明代表可使用该技能；实际工具调用仍经过 Compute、MCP 与审批策略。" : "Binding declares availability. Actual tool calls still pass compute, MCP, and approval policy."}</p>
              <div className="skills-binding-list">
                {snapshot.representatives.map((representative) => {
                  const binding = selectedSkill.bindings.find((item) => item.representativeSlug === representative.slug);
                  const enabled = Boolean(binding?.enabled);
                  const key = `binding:${selectedSkill.installId}:${representative.slug}`;
                  return (
                    <label key={representative.id}>
                      <span><strong>{representative.displayName}</strong><small>{binding?.issue ?? representative.slug}</small></span>
                      <input
                        checked={enabled}
                        disabled={busyKey === key || (
                          selectedSkill.reviewStatus !== "approved"
                          && selectedSkill.status !== "update_available"
                          && !enabled
                        )}
                        onChange={(event) => onBindingChange(selectedSkill, representative.slug, event.target.checked)}
                        type="checkbox"
                      />
                    </label>
                  );
                })}
              </div>
              <a
                className="skills-source-link"
                href={`/dashboard?rep=${encodeURIComponent(snapshot.activeRepresentative.slug)}&view=representatives&repSection=operations&lang=${locale}`}
              >
                {zh ? "检查草稿并发布当前代表" : "Review draft and publish active representative"} →
              </a>
            </section>
            <section className="skills-detail-section">
              <h3>{zh ? "最近调用记录" : "Recent call history"}</h3>
              <p>{zh
                ? "仅显示与该技能绑定的 MCP 调用元数据；参数、命令正文和凭据不会在此披露。"
                : "Only MCP call metadata linked to this skill is shown; arguments, command bodies, and credentials stay hidden."}</p>
              {selectedSkill.recentCalls.length ? (
                <div className="skills-call-list">
                  {selectedSkill.recentCalls.slice(0, 5).map((call) => (
                    <div key={call.id}>
                      <span>
                        <strong>{call.toolName ?? call.capability}</strong>
                        <small>{call.representativeName} · {call.durationMs === null ? "—" : `${call.durationMs} ms`}</small>
                      </span>
                      <span>
                        <StatusText locale={locale} value={call.status} />
                        <time dateTime={call.createdAt}>{new Date(call.createdAt).toLocaleString(zh ? "zh-CN" : "en-US")}</time>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="skills-empty-cell">{zh ? "暂无可归属到此技能的调用记录。" : "No calls are currently attributable to this skill."}</p>
              )}
            </section>
            <section className="skills-detail-section skills-archive-section">
              <h3>{zh ? "归档与影响范围" : "Archive and impact"}</h3>
              <p>{selectedSkill.impact.enabledBindings
                ? (zh
                    ? `仍有 ${selectedSkill.impact.enabledBindings} 个启用绑定；全部停用后才能归档。`
                    : `${selectedSkill.impact.enabledBindings} enabled binding(s) must be disabled before archiving.`)
                : selectedSkill.impact.publishedRepresentatives.length
                  ? (zh ? "仍有公开版本引用；请发布一个不含此技能的新版本后再归档。" : "An active published version still references this skill. Publish a new version without it before archiving.")
                  : (zh ? "当前没有启用绑定或公开引用，归档不会删除版本历史或审计记录。" : "No enabled bindings or published references. Archiving preserves release history and audit records.")}</p>
              {selectedSkill.impact.publishedRepresentatives.length ? (
                <div className="skills-impact-list">
                  {selectedSkill.impact.publishedRepresentatives.map((representative) => (
                    <span key={`${representative.slug}:${representative.versionNumber}`}>
                      {representative.displayName} · v{representative.versionNumber} {zh ? "仍引用已发布快照" : "still references a published snapshot"}
                    </span>
                  ))}
                </div>
              ) : null}
              <button
                className="dashboard-v2-button-secondary skills-archive-button"
                disabled={busyKey === `archive:${selectedSkill.installId}` || (selectedSkill.status !== "archived" && (selectedSkill.impact.enabledBindings > 0 || selectedSkill.impact.publishedRepresentatives.length > 0))}
                onClick={() => onArchiveChange(selectedSkill, selectedSkill.status !== "archived")}
                type="button"
              >
                {busyKey === `archive:${selectedSkill.installId}`
                  ? (zh ? "处理中…" : "Working…")
                  : selectedSkill.status === "archived"
                    ? (zh ? "恢复技能" : "Restore skill")
                    : (zh ? "归档技能" : "Archive skill")}
              </button>
            </section>
            {selectedSkill.sourceUrl ? <a className="skills-source-link" href={selectedSkill.sourceUrl} rel="noreferrer" target="_blank">{zh ? "查看来源与版本说明" : "View source and version notes"} ↗</a> : null}
          </>
        ) : <p className="skills-empty-cell">{zh ? "选择一个技能查看详情。" : "Select a skill to inspect it."}</p>}
      </aside>
    </div>
  );
}

function SkillReleaseGovernance({ busyKey, locale, onAction, skill }: {
  busyKey: string | null;
  locale: Locale;
  onAction: (skill: Skill, release: SkillRelease, action: "adopt" | "reject" | "rollback") => void;
  skill: Skill;
}) {
  const zh = locale === "zh";
  const installed = skill.releases.find((release) => release.status === "installed");
  const ordered = [...skill.releases].sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt));

  return (
    <section className="skills-detail-section skills-release-section">
      <h3>{zh ? "版本治理" : "Release governance"}</h3>
      <p>{zh
        ? "候选版本不会覆盖已安装元数据；采纳或回滚后，代表仍需重新发布才会公开生效。"
        : "Candidates never overwrite installed metadata. After adoption or rollback, representatives still require republishing."}</p>
      <div className="skills-release-list">
        {ordered.map((release) => {
          const changedSummary = Boolean(installed && release.status === "candidate" && installed.summary !== release.summary);
          const addedTags = release.status === "candidate"
            ? release.capabilityTags.filter((tag) => !installed?.capabilityTags.includes(tag))
            : [];
          return (
            <article className={`is-${release.status}`} key={release.id}>
              <div className="skills-release-heading">
                <span><strong>v{release.version}</strong><small>{releaseStatusLabel(release.status, locale)}</small></span>
                <time dateTime={release.discoveredAt}>{new Date(release.discoveredAt).toLocaleDateString(zh ? "zh-CN" : "en-US")}</time>
              </div>
              {release.status === "candidate" ? (
                <div className="skills-release-diff">
                  <span>{changedSummary ? (zh ? "摘要已变化" : "Summary changed") : (zh ? "摘要未变化" : "Summary unchanged")}</span>
                  <span>{addedTags.length
                    ? `${zh ? "新增能力标签" : "Added capability tags"}: ${addedTags.join(", ")}`
                    : (zh ? "未新增能力标签" : "No added capability tags")}</span>
                  <span>
                    {zh ? "Registry 信任" : "Registry trust"}: {registryTrustLabel(release.registryTrust, locale)}
                  </span>
                  {release.signatureStatus !== "unavailable" ? (
                    <span>{zh ? "发布者签名" : "Publisher signature"}: {releaseSignatureLabel(release.signatureStatus, locale)}</span>
                  ) : null}
                  <span>{release.permissionDiff.added.length
                    ? `${zh ? "新增权限" : "Added requirements"}: ${release.permissionDiff.added.join(", ")}`
                    : (zh ? "未新增受治理权限" : "No added governed requirements")}</span>
                  <span>{release.permissionDiff.removed.length
                    ? `${zh ? "移除权限" : "Removed requirements"}: ${release.permissionDiff.removed.join(", ")}`
                    : (zh ? "未移除受治理权限" : "No removed governed requirements")}</span>
                  <span>{release.runtimeRequirementDiff.changed
                    ? (zh ? "Manifest 运行要求已变化" : "Manifest runtime requirements changed")
                    : (zh ? "Manifest 运行要求未变化" : "Manifest runtime requirements unchanged")}</span>
                  {release.runtimeRequirementDiff.added.length ? (
                    <span>{zh ? "新增 Manifest 要求" : "Added manifest requirements"}: {release.runtimeRequirementDiff.added.join(", ")}</span>
                  ) : null}
                  {release.runtimeRequirementDiff.removed.length ? (
                    <span>{zh ? "移除 Manifest 要求" : "Removed manifest requirements"}: {release.runtimeRequirementDiff.removed.join(", ")}</span>
                  ) : null}
                  {release.signatureKeyId ? <span>{zh ? "签名密钥" : "Signature key"}: {release.signatureKeyId}</span> : null}
                  {release.registryTrust?.reasons.length ? (
                    <span>
                      {zh ? "信任证据" : "Trust evidence"}: {release.registryTrust.reasons.join(", ")}
                    </span>
                  ) : null}
                  <span>{zh ? "自动更新判定" : "Auto-update decision"}: {release.autoUpdate.reason}</span>
                </div>
              ) : null}
              <p>{release.summary}</p>
              {release.status !== "candidate" && release.registryTrust ? (
                <div className="skills-release-evidence">
                  <span>{zh ? "Registry 信任" : "Registry trust"}: {registryTrustLabel(release.registryTrust, locale)}</span>
                  {release.registryTrust.reasons.length ? (
                    <span>{zh ? "信任证据" : "Trust evidence"}: {release.registryTrust.reasons.join(", ")}</span>
                  ) : null}
                </div>
              ) : null}
              {release.runtimeRequirements ? (
                <div className="skills-release-evidence">
                  {release.runtimeRequirements.requiredBins.length ? (
                    <span>{zh ? "依赖命令" : "Required binaries"}: {release.runtimeRequirements.requiredBins.join(", ")}</span>
                  ) : null}
                  {release.runtimeRequirements.requiredEnv.length ? (
                    <span>{zh ? "必需环境变量" : "Required environment"}: {release.runtimeRequirements.requiredEnv.join(", ")}</span>
                  ) : null}
                  {release.runtimeRequirements.operatingSystems.length ? (
                    <span>{zh ? "运行系统" : "Operating systems"}: {release.runtimeRequirements.operatingSystems.join(", ")}</span>
                  ) : null}
                </div>
              ) : null}
              {release.provenanceDigest ? <code title={release.provenanceDigest}>{release.provenanceDigest.slice(0, 22)}…</code> : null}
              {release.sbomUrl || release.attestationUrl ? <div className="skills-release-evidence">
                {release.sbomUrl ? <a href={release.sbomUrl} rel="noreferrer" target="_blank">SBOM ↗</a> : null}
                {release.attestationUrl ? <a href={release.attestationUrl} rel="noreferrer" target="_blank">Attestation ↗</a> : null}
              </div> : null}
              {release.status === "candidate" ? (
                <div className="skills-release-actions">
                  <button
                    className="dashboard-v2-button-primary"
                    disabled={Boolean(busyKey)}
                    onClick={() => onAction(skill, release, "adopt")}
                    type="button"
                  >{busyKey === `release:${release.id}:adopt` ? (zh ? "采纳中…" : "Adopting…") : (zh ? "采纳版本" : "Adopt")}</button>
                  <button
                    className="dashboard-v2-button-secondary"
                    disabled={Boolean(busyKey)}
                    onClick={() => onAction(skill, release, "reject")}
                    type="button"
                  >{busyKey === `release:${release.id}:reject` ? (zh ? "拒绝中…" : "Rejecting…") : (zh ? "拒绝" : "Reject")}</button>
                </div>
              ) : release.status === "superseded" ? (
                <button
                  className="skills-release-rollback"
                  disabled={Boolean(busyKey)}
                  onClick={() => onAction(skill, release, "rollback")}
                  type="button"
                >{busyKey === `release:${release.id}:rollback` ? (zh ? "回滚中…" : "Rolling back…") : (zh ? "回滚到此版本" : "Roll back to this version")}</button>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RegistryPanel({ busyKey, installedSlugs, isPending, locale, onInstall, onQueryChange, onSubmit, query, results, searched }: {
  busyKey: string | null;
  installedSlugs: Set<string>;
  isPending: boolean;
  locale: Locale;
  onInstall: (skill: RegistrySkill, alreadyInstalled?: boolean) => void;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  query: string;
  results: RegistrySkill[];
  searched: boolean;
}) {
  const zh = locale === "zh";
  return (
    <section className="dashboard-v2-panel skills-registry-panel">
      <header><div><p>REGISTRY / CLAWHUB</p><h2>{zh ? "发现技能声明，不直接安装可执行代码" : "Discover skill declarations, not executable packages"}</h2></div></header>
      <p className="dashboard-v2-panel-description">{zh ? "搜索结果来自 ClawHub。Delegate 保存来源、版本与能力标签；安装后仍需在详情中绑定代表。" : "Results come from ClawHub. Delegate stores provenance, version, and capability tags; representative binding remains a separate step."}</p>
      <form className="skills-registry-search" onSubmit={onSubmit}>
        <input aria-label={zh ? "搜索 ClawHub 技能" : "Search ClawHub skills"} onChange={(event) => onQueryChange(event.target.value)} placeholder={zh ? "例如：research、calendar、crm" : "Try research, calendar, or crm"} value={query} />
        <button className="dashboard-v2-button-primary" disabled={isPending} type="submit">{isPending ? (zh ? "搜索中…" : "Searching…") : (zh ? "搜索" : "Search")}</button>
      </form>
      <div className="skills-registry-grid">
        {results.map((skill) => {
          const installed = installedSlugs.has(skill.slug);
          return (
            <article key={skill.slug}>
              <div><span>CH</span><small>{skill.version ? `v${skill.version}` : (zh ? "版本未知" : "Version unknown")}</small></div>
              <h3>{skill.displayName}</h3>
              <p>{skill.summary}</p>
              <div className="skills-tag-row">{skill.capabilityTags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
              <button disabled={busyKey === `install:${skill.slug}`} onClick={() => onInstall(skill, installed)} type="button">
                {busyKey === `install:${skill.slug}`
                  ? installed ? (zh ? "检查中…" : "Checking…") : (zh ? "安装中…" : "Installing…")
                  : installed ? (zh ? "检查更新" : "Check update") : (zh ? "安装到工作区" : "Install to workspace")}
              </button>
            </article>
          );
        })}
        {!results.length ? (
          <div className="skills-registry-empty">
            <strong>{searched ? (zh ? "没有匹配结果" : "No matching skills") : (zh ? "先搜索技能市场" : "Search the registry")}</strong>
            <p>{searched
              ? (zh ? "尝试更短的关键词，或清空搜索后浏览最新技能。" : "Try a shorter query or clear the search to browse current skills.")
              : (zh ? "安装不会自动绑定代表，也不会增加默认权限。" : "Installation does not bind a representative or add default authority.")}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionsPanel({
  activeSlug,
  locale,
  onRefresh,
  snapshot,
}: {
  activeSlug: string;
  locale: Locale;
  onRefresh: () => Promise<void>;
  snapshot: WorkspaceSkillSnapshot;
}) {
  const zh = locale === "zh";
  const [bindings, setBindings] = useState<ManagedMcpBinding[]>([]);
  const [form, setForm] = useState<McpBindingForm>(emptyMcpBindingForm);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bindingsLoading, setBindingsLoading] = useState(true);
  const [bindingsLoadError, setBindingsLoadError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const activeSlugRef = useRef(activeSlug);
  const bindingRequestSequenceRef = useRef(0);
  activeSlugRef.current = activeSlug;

  const skillLinks = snapshot.skills.flatMap((skill) => {
    const binding = skill.bindings.find((candidate) => candidate.representativeSlug === activeSlug);
    return binding
      ? [{ linkId: binding.linkId, label: `${skill.displayName} · ${skill.installedVersion ?? "unversioned"}` }]
      : [];
  });

  async function loadBindings(signal?: AbortSignal) {
    const requestedSlug = activeSlug;
    const requestId = ++bindingRequestSequenceRef.current;
    setBindingsLoading(true);
    setBindingsLoadError(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(requestedSlug)}/compute/mcp`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      if (!response.ok) throw new Error(await extractError(response));
      const payload = (await response.json()) as { bindings?: ManagedMcpBinding[] };
      if (
        signal?.aborted
        || activeSlugRef.current !== requestedSlug
        || bindingRequestSequenceRef.current !== requestId
      ) return;
      setBindings(payload.bindings ?? []);
    } catch (nextError) {
      if (
        signal?.aborted
        || activeSlugRef.current !== requestedSlug
        || bindingRequestSequenceRef.current !== requestId
      ) return;
      throw nextError;
    } finally {
      if (
        activeSlugRef.current === requestedSlug
        && bindingRequestSequenceRef.current === requestId
      ) setBindingsLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setBindings([]);
    setBindingsLoading(true);
    setBindingsLoadError(null);
    setSaving(false);
    setForm(emptyMcpBindingForm);
    setFormOpen(false);
    setConnectionError(null);
    setConnectionMessage(null);
    void loadBindings(controller.signal).catch((nextError: unknown) => {
      if (!controller.signal.aborted && activeSlugRef.current === activeSlug) {
        setBindingsLoadError(nextError instanceof Error ? nextError.message : (zh ? "MCP 连接加载失败。" : "Failed to load MCP connections."));
      }
    });
    return () => controller.abort();
  }, [activeSlug]);

  function retryBindings() {
    void loadBindings().catch((nextError: unknown) => {
      if (activeSlugRef.current === activeSlug) {
        setBindingsLoadError(nextError instanceof Error ? nextError.message : (zh ? "MCP 连接加载失败。" : "Failed to load MCP connections."));
      }
    });
  }

  function editBinding(binding: ManagedMcpBinding) {
    setConnectionError(null);
    setConnectionMessage(null);
    setForm({
      bindingId: binding.id,
      expectedUpdatedAt: binding.updatedAt,
      representativeSkillPackLinkId: binding.representativeSkillPackLinkId ?? "",
      slug: binding.slug,
      displayName: binding.displayName,
      description: binding.description ?? "",
      serverUrl: binding.serverUrl,
      transportKind: binding.transportKind,
      allowedToolNames: binding.allowedToolNames.join("\n"),
      defaultToolName: binding.defaultToolName ?? "",
      enabled: binding.enabled,
      approvalRequired: binding.approvalRequired,
    });
    setFormOpen(true);
  }

  function createBinding() {
    setConnectionError(null);
    setConnectionMessage(null);
    setForm(emptyMcpBindingForm);
    setFormOpen(true);
  }

  async function saveBinding() {
    const requestedSlug = activeSlug;
    const allowedToolNames = [...new Set(
      form.allowedToolNames
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    )];
    if (!form.displayName.trim() || !form.serverUrl.trim() || !allowedToolNames.length) {
      setConnectionError(zh
        ? "连接名称、Server URL 和至少一个允许工具为必填项。"
        : "Display name, server URL, and at least one allowed tool are required.");
      return;
    }
    const slug = form.slug.trim() || form.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      setConnectionError(zh ? "请输入有效的连接标识。" : "Enter a valid connection slug.");
      return;
    }
    setSaving(true);
    setConnectionError(null);
    setConnectionMessage(null);
    try {
      const endpoint = form.bindingId
        ? `/api/dashboard/representatives/${encodeURIComponent(requestedSlug)}/compute/mcp/${encodeURIComponent(form.bindingId)}`
        : `/api/dashboard/representatives/${encodeURIComponent(requestedSlug)}/compute/mcp`;
      const response = await fetch(endpoint, {
        method: form.bindingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(form.bindingId && form.expectedUpdatedAt
            ? { expectedUpdatedAt: form.expectedUpdatedAt }
            : {}),
          ...(form.representativeSkillPackLinkId
            ? { representativeSkillPackLinkId: form.representativeSkillPackLinkId }
            : {}),
          slug,
          displayName: form.displayName.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          serverUrl: form.serverUrl.trim(),
          transportKind: form.transportKind,
          allowedToolNames,
          ...(form.defaultToolName.trim() ? { defaultToolName: form.defaultToolName.trim() } : {}),
          enabled: form.enabled,
          approvalRequired: form.approvalRequired,
          estimatedTokensPerCall: 0,
          maxRetries: 0,
          retryBackoffMs: 1000,
        }),
      });
      if (!response.ok) throw new Error(await extractError(response));
      if (activeSlugRef.current !== requestedSlug) return;
      await Promise.all([loadBindings(), onRefresh()]);
      if (activeSlugRef.current !== requestedSlug) return;
      setForm(emptyMcpBindingForm);
      setFormOpen(false);
      setConnectionMessage(form.bindingId
        ? (zh ? "MCP 连接已更新；扩大公开权限仍需重新发布代表版本。" : "MCP connection updated. Expanded public authority still requires republishing.")
        : (zh ? "MCP 连接已创建；请检查工具白名单和审批策略。" : "MCP connection created. Review its tool allowlist and approval policy."));
    } catch (nextError) {
      if (activeSlugRef.current === requestedSlug) {
        setConnectionError(nextError instanceof Error ? nextError.message : (zh ? "MCP 连接保存失败。" : "Failed to save MCP connection."));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-busy={bindingsLoading || saving} className="dashboard-v2-panel skills-connections-panel">
      <header>
        <div><p>MCP / COMPUTE</p><h2>{zh ? "连接健康与审批边界" : "Connection health and approval boundaries"}</h2></div>
        <button className="dashboard-v2-button-primary" onClick={createBinding} type="button">+ {zh ? "新增 MCP 连接" : "Add MCP connection"}</button>
      </header>
      <p className="dashboard-v2-panel-description">{zh ? "连接属于具体对外代理。技能只能引用已配置连接，不能自行创建凭据或扩大工具白名单。" : "Connections belong to individual representatives. Skills can reference configured connections but cannot create credentials or expand tool allowlists."}</p>
      {connectionMessage ? <div className="skills-banner is-success" role="status">{connectionMessage}</div> : null}
      {connectionError ? <div className="skills-banner is-error" role="alert">{connectionError}</div> : null}
      {bindingsLoadError ? (
        <div className="skills-banner is-error" role="alert">
          <span>{bindingsLoadError}</span>
          <button className="dashboard-v2-button-secondary" disabled={bindingsLoading} onClick={retryBindings} type="button">{zh ? "重试加载" : "Retry loading"}</button>
        </div>
      ) : null}
      {bindingsLoading ? <p aria-live="polite" className="skills-inline-status" role="status">{zh ? "正在读取可编辑的 MCP 连接…" : "Loading editable MCP connections…"}</p> : null}
      <div className="skills-connection-list">
        {snapshot.connections.filter((connection) => connection.representativeSlug === activeSlug).map((connection) => {
          const managed = bindings.find((binding) => binding.id === connection.id);
          return <article key={connection.id}>
            <span className={`is-${connection.health}`}>{connection.health === "healthy" ? "✓" : "·"}</span>
            <div><strong>{connection.displayName}</strong><small>{connection.representativeName} · {connection.transportKind} · {connection.allowedToolNames.length} {zh ? "个允许工具" : "allowed tools"}</small><p>{connection.healthDetail}</p></div>
            <div>
              <StatusText value={connection.health} locale={locale} />
              <small>{connection.approvalRequired ? (zh ? "调用需审批" : "Approval required") : (zh ? "按策略执行" : "Policy governed")}</small>
              <button
                className="skills-connection-edit"
                disabled={bindingsLoading || !managed}
                onClick={() => {
                  if (managed) editBinding(managed);
                }}
                title={!bindingsLoading && !managed ? (zh ? "连接详情不可用，请重试加载。" : "Connection details unavailable; retry loading.") : undefined}
                type="button"
              >
                {bindingsLoading ? (zh ? "加载中…" : "Loading…") : managed ? (zh ? "编辑" : "Edit") : (zh ? "暂不可用" : "Unavailable")}
              </button>
            </div>
          </article>
        })}
        {!snapshot.connections.some((connection) => connection.representativeSlug === activeSlug) ? <div className="skills-registry-empty"><strong>{zh ? "尚未配置 MCP 连接" : "No MCP connections yet"}</strong><p>{zh ? "在此新增连接，并明确绑定技能、工具白名单和审批要求。" : "Create a connection here and explicitly bind its skill, tool allowlist, and approval requirement."}</p></div> : null}
      </div>
      {formOpen ? (
        <section className="skills-mcp-editor" aria-label={zh ? "MCP 连接编辑器" : "MCP connection editor"}>
          <header><h3>{form.bindingId ? (zh ? "编辑 MCP 连接" : "Edit MCP connection") : (zh ? "新增 MCP 连接" : "Add MCP connection")}</h3></header>
          <div className="skills-mcp-form-grid">
            <label><span>{zh ? "连接名称" : "Display name"}</span><input maxLength={120} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} value={form.displayName} /></label>
            <label><span>{zh ? "连接标识" : "Slug"}</span><input maxLength={80} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} placeholder={zh ? "留空则自动生成" : "Generated when empty"} value={form.slug} /></label>
            <label className="is-wide">
              <span>Server URL</span>
              <input maxLength={2048} onChange={(event) => setForm((current) => ({ ...current, serverUrl: event.target.value }))} placeholder="https://mcp.example.com" type="url" value={form.serverUrl} />
              <small>{zh ? "仅允许无账号信息的公网 HTTPS；私网、环回、跨域重定向和 DNS rebinding 会被阻止。远程工具单次执行，不自动重试。" : "Credential-free public HTTPS only; private, loopback, cross-origin redirect, and DNS-rebinding targets are blocked. Remote tools run once with no automatic retry."}</small>
            </label>
            <label><span>{zh ? "传输方式" : "Transport"}</span><select onChange={(event) => setForm((current) => ({ ...current, transportKind: event.target.value as McpBindingForm["transportKind"] }))} value={form.transportKind}><option value="streamable_http">Streamable HTTP</option><option value="sse">SSE</option></select></label>
            <label><span>{zh ? "关联技能" : "Linked skill"}</span><select onChange={(event) => setForm((current) => ({ ...current, representativeSkillPackLinkId: event.target.value }))} value={form.representativeSkillPackLinkId}><option value="">{zh ? "通用连接（不关联技能）" : "General connection"}</option>{skillLinks.map((link) => <option key={link.linkId} value={link.linkId}>{link.label}</option>)}</select></label>
            <label className="is-wide"><span>{zh ? "允许工具（逗号或换行分隔）" : "Allowed tools (comma or newline separated)"}</span><textarea onChange={(event) => setForm((current) => ({ ...current, allowedToolNames: event.target.value }))} rows={3} value={form.allowedToolNames} /></label>
            <label><span>{zh ? "默认工具（可选）" : "Default tool (optional)"}</span><input onChange={(event) => setForm((current) => ({ ...current, defaultToolName: event.target.value }))} value={form.defaultToolName} /></label>
            <label className="is-wide"><span>{zh ? "说明（可选）" : "Description (optional)"}</span><textarea maxLength={500} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={2} value={form.description} /></label>
          </div>
          <div className="skills-mcp-toggles">
            <label><input checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} type="checkbox" />{zh ? "启用连接" : "Enable connection"}</label>
            <label><input checked={form.approvalRequired} onChange={(event) => setForm((current) => ({ ...current, approvalRequired: event.target.checked }))} type="checkbox" />{zh ? "每次调用需要审批" : "Require approval for calls"}</label>
          </div>
          <p className="dashboard-v2-panel-description">
            {zh
              ? "副作用安全模式：远程工具调用只执行一次；超时或结果未知时不会自动重试。"
              : "Side-effect safe mode: remote tool calls run once and are not retried after a timeout or unknown outcome."}
          </p>
          <footer>
            <button className="dashboard-v2-button-secondary" disabled={saving} onClick={() => { setFormOpen(false); setForm(emptyMcpBindingForm); }} type="button">{zh ? "取消" : "Cancel"}</button>
            <button className="dashboard-v2-button-primary" disabled={saving} onClick={() => void saveBinding()} type="button">{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存连接" : "Save connection")}</button>
          </footer>
        </section>
      ) : null}
    </section>
  );
}

function PolicyPanel({ activeSlug, locale, snapshot }: { activeSlug: string; locale: Locale; snapshot: WorkspaceSkillSnapshot }) {
  const zh = locale === "zh";
  const setupHref = `/dashboard?rep=${encodeURIComponent(activeSlug)}&view=representatives&lang=${locale}&repSection=setup&setupSection=compute`;
  return (
    <div className="skills-policy-layout">
      <section className="dashboard-v2-panel">
        <header><div><p>ACTIVE REPRESENTATIVE</p><h2>{snapshot.activeRepresentative.displayName}</h2></div><StatusPill status={snapshot.activeRepresentative.computeEnabled ? "ready" : "needs_setup"} locale={locale} /></header>
        <p className="dashboard-v2-panel-description">{zh ? "当前代表的能力策略决定工具调用是允许、询问还是拒绝。技能绑定不会改写这些值。" : "The active representative policy decides whether a tool call is allowed, asks for approval, or is denied. Skill bindings never rewrite these values."}</p>
        <div className="skills-policy-grid">
          {Object.entries(snapshot.policy.capabilityModes).map(([capability, mode]) => <article key={capability}><strong>{capability}</strong><StatusText value={mode} locale={locale} /></article>)}
        </div>
      </section>
      <aside className="dashboard-v2-panel is-indigo">
        <header><div><p>EXECUTION BOUNDARY</p><h2>{zh ? "运行时护栏" : "Runtime guardrails"}</h2></div></header>
        <dl className="skills-policy-facts">
          <div><dt>{zh ? "默认决策" : "Default decision"}</dt><dd>{snapshot.policy.defaultDecision}</dd></div>
          <div><dt>{zh ? "网络" : "Network"}</dt><dd>{snapshot.policy.networkMode}</dd></div>
          <div><dt>{zh ? "文件系统" : "Filesystem"}</dt><dd>{snapshot.policy.filesystemMode}</dd></div>
          <div><dt>{zh ? "公开生效" : "Public activation"}</dt><dd>{zh ? "发布新版本后" : "After publishing"}</dd></div>
        </dl>
        <a className="dashboard-v2-button-secondary" href={setupHref}>{zh ? "编辑 Compute 策略" : "Edit compute policy"} →</a>
      </aside>
    </div>
  );
}

function SkillMetric({ detail, label, tone = "neutral", value }: { detail: string; label: string; tone?: "neutral" | "teal" | "warning" | "indigo"; value: number }) {
  return <article className={`dashboard-v2-metric-card is-${tone}`}><div><span>{label}</span><i /></div><strong>{String(value).padStart(2, "0")}</strong><p>{detail}</p></article>;
}

function StatusPill({ locale, status }: { locale: Locale; status: "ready" | "needs_setup" | "blocked" }) {
  const labels = locale === "zh" ? { ready: "就绪", needs_setup: "需配置", blocked: "已阻止" } : { ready: "Ready", needs_setup: "Needs setup", blocked: "Blocked" };
  return <span className={`skills-status is-${status}`}>{labels[status]}</span>;
}

function StatusText({ locale, value }: { locale: Locale; value: string }) {
  const zhLabels: Record<string, string> = {
    healthy: "健康",
    degraded: "异常",
    unverified: "待验证",
    disabled: "已停用",
    allow: "允许",
    ask: "询问",
    deny: "拒绝",
    queued: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    blocked: "已阻止",
    canceled: "已取消",
  };
  return <span className={`skills-status-text is-${value}`}>{locale === "zh" ? zhLabels[value] ?? value : value.replaceAll("_", " ")}</span>;
}

function sourceLabel(source: Skill["source"]) {
  return source === "clawhub" ? "ClawHub" : source === "owner_upload" ? "Owner" : "Built-in";
}

function riskLabel(risk: Skill["risk"], locale: Locale) {
  const labels = locale === "zh" ? { low: "低", medium: "中", high: "高" } : { low: "Low", medium: "Medium", high: "High" };
  return labels[risk];
}

function reviewLabel(review: Skill["reviewStatus"], locale: Locale) {
  const labels = locale === "zh" ? { approved: "已批准", needs_review: "需审核", rejected: "已拒绝" } : { approved: "Approved", needs_review: "Needs review", rejected: "Rejected" };
  return labels[review];
}

function releaseStatusLabel(status: SkillRelease["status"], locale: Locale) {
  const labels = locale === "zh"
    ? { installed: "当前安装", candidate: "候选更新", superseded: "历史版本", rejected: "已拒绝" }
    : { installed: "Installed", candidate: "Candidate", superseded: "History", rejected: "Rejected" };
  return labels[status];
}

function releaseSignatureLabel(status: SkillRelease["signatureStatus"], locale: Locale) {
  const labels = locale === "zh"
    ? { verified: "已验证", unverified: "密钥未受信", unavailable: "未提供", invalid: "无效" }
    : { verified: "Verified", unverified: "Untrusted key", unavailable: "Unavailable", invalid: "Invalid" };
  return labels[status];
}

function registryTrustLabel(
  trust: SkillRelease["registryTrust"],
  locale: Locale,
) {
  if (!trust) return locale === "zh" ? "无官方验证记录" : "No official verification";
  if (trust.autoUpdateEligible) {
    return locale === "zh" ? "精确版本已验证，可参与自动更新判定" : "Exact version verified; eligible for auto-update evaluation";
  }
  if (trust.verified) {
    return locale === "zh" ? "身份已验证，Manifest 证据不完整" : "Identity verified; manifest evidence incomplete";
  }
  return locale === "zh" ? "未通过或证据不完整" : "Failed or incomplete evidence";
}

async function extractError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}
