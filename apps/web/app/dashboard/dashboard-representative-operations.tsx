"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type {
  RepresentativeDirectoryItem,
  RepresentativeOperationsSnapshot,
} from "@delegate/web-data";
import { buildLocalizedHref, type Locale } from "@delegate/web-ui";

import { DashboardRepresentativeDirectory } from "./dashboard-representative-directory";
import {
  DashboardRepresentativeSetup,
  type RepresentativeSetupSectionId,
} from "./dashboard-representative-setup";
import {
  commitRepresentativeSectionNavigation,
  planRepresentativeSectionNavigation,
  type RepresentativeSection,
} from "./representative-section-navigation";
import { formatVersionDateTime } from "./dashboard-time";

export function DashboardRepresentativeOperations({
  accountLabel,
  activeSlug,
  initialSnapshot,
  locale,
  representativeBaseUrl,
  representatives,
}: {
  accountLabel: string;
  activeSlug: string;
  initialSnapshot: RepresentativeOperationsSnapshot | null;
  locale: Locale;
  representativeBaseUrl: string;
  representatives: RepresentativeDirectoryItem[];
}) {
  const zh = locale === "zh";
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const completed = snapshot?.readiness.filter((item) => item.complete).length ?? 0;
  const readyToPublish = Boolean(snapshot && completed === snapshot.readiness.length);
  const requestedSection = parseRepresentativeSection(searchParams.get("repSection"));
  const activeSection: RepresentativeSection = snapshot
    ? requestedSection
    : "directory";
  const requestedSetupSection = parseSetupSection(searchParams.get("setupSection"));

  useEffect(() => {
    setSnapshot(initialSnapshot);
    setMessage(null);
    setError(null);
  }, [activeSlug, initialSnapshot]);

  function navigateSection(
    section: RepresentativeSection,
    setupSection?: RepresentativeSetupSectionId,
  ) {
    const navigation = planRepresentativeSectionNavigation({
      activeSection,
      activeSetupSection: requestedSetupSection,
      activeSlug,
      currentSearch: searchParams.toString(),
      locale,
      pathname,
      representativeSlugs: representatives.map((representative) => representative.slug),
      section,
      setupSection,
    });

    commitRepresentativeSectionNavigation(window.history, navigation);
  }

  function publishVersion() {
    if (!snapshot) return;
    setMessage(null);
    setError(null);
    if (snapshot.representative.id.startsWith("demo-")) {
      const next = (snapshot.representative.activeVersion || 0) + 1;
      setSnapshot({
        ...snapshot,
        representative: { ...snapshot.representative, lifecycleState: "published", activeVersion: next },
        versions: [
          {
            id: `version-${next}`,
            versionNumber: next,
            changeSummary: zh ? "从当前配置发布。" : "Published from current configuration.",
            publishedBy: "Neo",
            publishedAt: new Date().toISOString(),
            active: true,
          },
          ...snapshot.versions.map((version) => ({ ...version, active: false })),
        ],
      });
      setMessage(zh ? `已发布 v${next}。` : `Published v${next}.`);
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeSummary: "Published from dashboard readiness review." }),
        });
        const payload = (await response.json()) as { error?: string; version?: { versionNumber: number } };
        if (!response.ok) throw new Error(payload.error || "Failed to publish representative.");
        const refreshed = await fetch(`/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/versions`);
        const nextSnapshot = (await refreshed.json()) as RepresentativeOperationsSnapshot & { error?: string };
        if (!refreshed.ok) throw new Error(nextSnapshot.error || "Failed to refresh representative.");
        setSnapshot(nextSnapshot);
        setMessage(zh ? `已发布 v${payload.version?.versionNumber}。` : `Published v${payload.version?.versionNumber}.`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to publish representative.");
      }
    });
  }

  function activateVersion(versionId: string) {
    if (!snapshot) return;
    setMessage(null);
    setError(null);
    if (snapshot.representative.id.startsWith("demo-")) {
      const selected = snapshot.versions.find((version) => version.id === versionId);
      if (!selected) return;
      setSnapshot({
        ...snapshot,
        representative: { ...snapshot.representative, activeVersion: selected.versionNumber },
        versions: snapshot.versions.map((version) => ({ ...version, active: version.id === versionId })),
      });
      setMessage(zh ? `已重新激活 v${selected.versionNumber}。` : `Reactivated v${selected.versionNumber}.`);
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/versions/${encodeURIComponent(versionId)}/activate`,
        { method: "POST" },
        );
        const payload = (await response.json()) as { error?: string; version?: { versionNumber: number } };
        if (!response.ok) throw new Error(payload.error || "Failed to activate representative version.");
        if (!payload.version) throw new Error("Activated version response is incomplete.");
        const activeVersionNumber = payload.version.versionNumber;
        setSnapshot((current) => current ? ({
          ...current,
          representative: {
            ...current.representative,
            activeVersion: activeVersionNumber,
          },
          versions: current.versions.map((version) => ({ ...version, active: version.id === versionId })),
        }) : current);
        setMessage(zh ? `已重新激活 v${activeVersionNumber}。` : `Reactivated v${activeVersionNumber}.`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to activate representative version.");
      }
    });
  }

  const sectionNavigation = (
    <nav aria-label={zh ? "数字代表模块" : "Digital representative workspace"} className="representative-section-tabs">
      <button className={activeSection === "directory" ? "is-active" : undefined} onClick={() => navigateSection("directory")} type="button">
        {zh ? "代表列表与创建" : "Directory & create"}
      </button>
      <button className={activeSection === "setup" ? "is-active" : undefined} disabled={!snapshot} onClick={() => navigateSection("setup")} type="button">
        {zh ? "代表配置" : "Configuration"}
      </button>
      <button className={activeSection === "operations" ? "is-active" : undefined} disabled={!snapshot} onClick={() => navigateSection("operations")} type="button">
        {zh ? "发布与运行" : "Publish & operate"}
      </button>
    </nav>
  );

  return (
    <>
      {activeSection === "directory" ? (
        <RepresentativeWorkspaceHeader
          actionLabel={zh ? "配置当前代表" : "Configure active representative"}
          canAct={Boolean(snapshot)}
          onAction={() => navigateSection("setup")}
          summary={zh ? "创建多个数字代表，并为每个代表维护独立的身份、知识、价格与发布版本。" : "Create multiple representatives with independent identity, knowledge, pricing, and release history."}
          title={zh ? "管理工作区里的全部数字代表。" : "Manage every representative in this workspace."}
        />
      ) : activeSection === "setup" && snapshot ? (
        <RepresentativeWorkspaceHeader
          actionLabel={zh ? "查看发布检查" : "Review publish readiness"}
          canAct
          onAction={() => navigateSection("operations")}
          summary={zh ? "配置修改先保存在工作草稿中；公开页面和异步会话继续使用当前已发布版本。" : "Edits stay in the working draft while public pages and asynchronous conversations continue using the active published version."}
          title={zh ? `配置 ${snapshot.representative.displayName}` : `Configure ${snapshot.representative.displayName}`}
        />
      ) : snapshot ? (
        <header className="dashboard-v2-page-header representative-ops-header">
          <div>
            <p>DIGITAL REPRESENTATIVES / 02</p>
            <h1>{zh ? "从配置、边界到版本，发布一个完整的数字代表。" : "Publish a complete representative from configuration to boundaries and versions."}</h1>
            <span>{zh ? "当前页面以发布就绪度为主线，知识、渠道、人工接管和版本状态在同一处检查。" : "Use readiness as the operating spine across knowledge, channels, handoff, and versions."}</span>
          </div>
          <div className="dashboard-v2-page-actions">
            <button className="dashboard-v2-button-secondary" onClick={() => navigateSection("setup")} type="button">
              {zh ? "编辑配置" : "Edit configuration"}
            </button>
            {snapshot.representative.activeVersion ? (
              <a
                className="dashboard-v2-button-secondary"
                href={buildLocalizedHref(`${representativeBaseUrl}/reps/${activeSlug}`, locale)}
              >
                {zh ? "测试已发布版本" : "Test published version"}
              </a>
            ) : (
              <button className="dashboard-v2-button-secondary" disabled type="button">
                {zh ? "发布后可测试" : "Publish before testing"}
              </button>
            )}
            <button className="dashboard-v2-button-primary" disabled={!readyToPublish || isPending} onClick={publishVersion} type="button">{isPending ? (zh ? "发布中…" : "Publishing…") : (zh ? "发布新版本" : "Publish version")}</button>
          </div>
        </header>
      ) : null}

      {sectionNavigation}

      <div className="representative-section-panel" hidden={activeSection !== "directory"}>
        <DashboardRepresentativeDirectory
          activeSlug={activeSlug}
          initialOwnerName={representatives[0]?.ownerName || accountLabel}
          initialRepresentatives={representatives}
          locale={locale}
          representativeBaseUrl={representativeBaseUrl}
        />
      </div>

      {snapshot ? (
        <>
          <div className="representative-section-panel" hidden={activeSection !== "setup"}>
            <DashboardRepresentativeSetup
              initialSection={requestedSetupSection}
              locale={locale}
              representativeSlug={activeSlug}
            />
          </div>

          <div className="representative-section-panel" hidden={activeSection !== "operations"}>
            {message ? <div className="representative-ops-banner is-success">{message}</div> : null}
            {error ? <div className="representative-ops-banner is-error">{error}</div> : null}

            <section className="representative-hero-card">
              <div className="representative-hero-identity">
                <span>{snapshot.representative.displayName.slice(0, 1).toUpperCase()}</span>
                <div><small>{snapshot.representative.slug}</small><h2>{snapshot.representative.displayName}</h2><p>{snapshot.representative.roleSummary}</p></div>
              </div>
              <div className="representative-hero-status">
                <span className={`is-${snapshot.representative.lifecycleState}`}>{formatLifecycle(snapshot.representative.lifecycleState, locale)}</span>
                <strong>v{snapshot.representative.activeVersion || "—"}</strong>
                <small>{zh ? "当前发布版本" : "Active version"}</small>
              </div>
            </section>

            <section className="dashboard-v2-metric-grid">
              <RepresentativeMetric detail={zh ? "当前代表" : "Current representative"} label={zh ? "历史会话" : "Conversations"} value={snapshot.metrics.conversations} tone="teal" />
              <RepresentativeMetric detail={zh ? "当前代表" : "Current representative"} label={zh ? "知识资产" : "Knowledge assets"} value={snapshot.metrics.knowledgeAssets} />
              <RepresentativeMetric detail={zh ? "当前代表" : "Current representative"} label={zh ? "启用技能" : "Enabled skills"} value={snapshot.metrics.enabledSkills} tone="indigo" />
              <RepresentativeMetric detail={zh ? "当前代表" : "Current representative"} label={zh ? "待人工接手" : "Open handoffs"} value={snapshot.metrics.openHandoffs} tone="warning" />
            </section>

            <div className="representative-ops-grid">
              <section className="dashboard-v2-panel representative-readiness-panel">
                <header><div><p>{zh ? "发布检查" : "Publish readiness"}</p><h2>{completed} / {snapshot.readiness.length} {zh ? "项已完成" : "complete"}</h2></div><span className={readyToPublish ? "is-ready" : undefined}>{readyToPublish ? (zh ? "可以发布" : "Ready") : (zh ? "需要补全" : "Needs work")}</span></header>
                <div className="representative-readiness-list">
                  {snapshot.readiness.map((item, index) => (
                    <article className={item.complete ? "is-complete" : undefined} key={item.id}>
                      <span>{item.complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
                      <div><strong>{localizeReadiness(item.label, locale)}</strong><small>{localizeReadinessDetail(item.id, item.detail, item.complete, locale)}</small></div>
                      {item.id === "channel" ? (
                        <a href={buildChannelsHref(activeSlug, locale)}>
                          {zh ? "管理" : "Manage"} →
                        </a>
                      ) : (
                        <button onClick={() => navigateSection("setup", readinessSetupSection[item.id] ?? "basics")} type="button">{zh ? "查看" : "Review"} →</button>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              <aside className="representative-ops-stack">
                <section className="dashboard-v2-panel">
                  <header>
                    <div><p>{zh ? "渠道" : "Channels"}</p><h2>{zh ? "发布与连接状态" : "Publishing and connection"}</h2></div>
                    <div className="dashboard-v2-panel-action">
                      <a href={buildChannelsHref(activeSlug, locale)}>
                        {zh ? "前往发布渠道" : "Open channels"} →
                      </a>
                    </div>
                  </header>
                  <p className="dashboard-v2-panel-description">
                    {zh
                      ? "这里显示当前代表的渠道摘要；连接、暂停和健康检查在发布渠道统一管理。每个数字代表可选择独立 Telegram Bot，也可复用工作区内同一个 Bot。"
                      : "This is the current representative's channel summary. Manage connections, pauses, and health checks in Channels. Each representative can use its own Telegram Bot or reuse one Bot in the workspace."}
                  </p>
                  <div className="representative-channel-list">
                    {snapshot.channels.length ? snapshot.channels.map((channel) => (
                      <article key={channel.kind}><span className={`is-${channel.kind}`}>{channel.kind.slice(0, 1).toUpperCase()}</span><div><strong>{channel.kind}</strong><small>{channel.externalUserId || (zh ? "尚未分配身份" : "No identity assigned")}</small></div><em className={`is-${channel.status}`}>{channel.status}</em></article>
                    )) : <p className="representative-empty-copy">{zh ? "公开网页启用后会自动显示 Web 渠道。" : "Web appears automatically when public mode is enabled."}</p>}
                  </div>
                </section>
                <section className="dashboard-v2-panel">
                  <header><div><p>{zh ? "配置入口" : "Configuration"}</p><h2>{zh ? "继续完善代表" : "Continue setup"}</h2></div></header>
                  <div className="representative-config-links">
                    {configurationLinks(locale).map((item, index) => <button key={item.label} onClick={() => navigateSection("setup", item.section)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.label}</strong><b>→</b></button>)}
                  </div>
                </section>
              </aside>
            </div>

            <section className="dashboard-v2-panel representative-version-panel">
              <header><div><p>{zh ? "版本历史" : "Version history"}</p><h2>{zh ? "每次发布都可追踪、可回滚" : "Every release is traceable and reversible"}</h2></div></header>
              <div className="representative-version-list">
                {snapshot.versions.length ? snapshot.versions.map((version) => (
                  <article className={version.active ? "is-active" : undefined} key={version.id}><span>v{version.versionNumber}</span><div><strong>{version.changeSummary || (zh ? "未填写变更摘要" : "No change summary")}</strong><small>{formatVersionDateTime(version.publishedAt, locale, snapshot.representative.timeZone)} · {version.publishedBy || "Owner"}</small></div>{version.active ? <em>{zh ? "当前版本" : "Active"}</em> : <button disabled={isPending} onClick={() => activateVersion(version.id)} type="button">{zh ? "重新激活" : "Reactivate"}</button>}</article>
                )) : <p className="representative-empty-copy">{zh ? "尚未发布版本。完成检查后发布第一个版本。" : "No published versions yet. Complete readiness and publish v1."}</p>}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}

const readinessSetupSection: Record<string, RepresentativeSetupSectionId> = {
  identity: "basics",
  knowledge: "knowledge",
  handoff: "contract",
  pricing: "pricing",
  skills: "compute",
};

function parseRepresentativeSection(value: string | null): RepresentativeSection {
  return value === "directory" || value === "setup" || value === "operations"
    ? value
    : "operations";
}

function parseSetupSection(value: string | null): RepresentativeSetupSectionId {
  return value === "contract" || value === "pricing" || value === "knowledge" || value === "compute" || value === "memory"
    ? value
    : "basics";
}

function configurationLinks(locale: Locale): Array<{ label: string; section: RepresentativeSetupSectionId }> {
  const zh = locale === "zh";
  return [
    { label: zh ? "身份与表达" : "Identity & voice", section: "basics" },
    { label: zh ? "知识与记忆" : "Knowledge & memory", section: "knowledge" },
    { label: zh ? "技能与工具" : "Skills & tools", section: "compute" },
    { label: zh ? "人工接管" : "Human handoff", section: "contract" },
    { label: zh ? "价格与权益" : "Pricing & entitlements", section: "pricing" },
  ];
}

function RepresentativeWorkspaceHeader({
  actionLabel,
  canAct,
  onAction,
  summary,
  title,
}: {
  actionLabel: string;
  canAct: boolean;
  onAction: () => void;
  summary: string;
  title: string;
}) {
  return (
    <header className="dashboard-v2-page-header representative-ops-header">
      <div>
        <p>DIGITAL REPRESENTATIVES / 02</p>
        <h1>{title}</h1>
        <span>{summary}</span>
      </div>
      <div className="dashboard-v2-page-actions">
        <button className="dashboard-v2-button-primary" disabled={!canAct} onClick={onAction} type="button">
          {actionLabel}
        </button>
      </div>
    </header>
  );
}

function RepresentativeMetric({ detail, label, value, tone = "neutral" }: { detail: string; label: string; value: number; tone?: "neutral" | "teal" | "warning" | "indigo" }) {
  return <article className={`dashboard-v2-metric-card is-${tone}`}><div><span>{label}</span><i /></div><strong>{String(value).padStart(2, "0")}</strong><p>{detail}</p></article>;
}

function formatLifecycle(value: string, locale: Locale) {
  const labels: Record<string, [string, string]> = { draft: ["草稿", "Draft"], configuring: ["配置中", "Configuring"], ready: ["待发布", "Ready"], published: ["已发布", "Published"], paused: ["已暂停", "Paused"], archived: ["已归档", "Archived"] };
  const label = labels[value] || [value, value];
  return locale === "zh" ? label[0] : label[1];
}

function localizeReadiness(value: string, locale: Locale) {
  if (locale === "en") return value;
  const labels: Record<string, string> = { "Identity and role": "身份与角色", "Knowledge scope": "知识范围", "Human handoff": "人工接管", "Pricing and free scope": "价格与免费范围", "Skills and tools": "技能与工具", "Published channel": "发布渠道" };
  return labels[value] || value;
}

function localizeReadinessDetail(id: string, fallback: string, complete: boolean, locale: Locale) {
  if (locale === "en") return fallback;
  const labels: Record<string, string> = { identity: "名称、角色说明与表达语气已配置。", knowledge: "至少包含一份已审核知识或知识包。", handoff: "人工介入路径和提示已经明确。", pricing: "免费、通行、深度帮助与赞助价格已配置。", skills: complete ? "已启用技能通过当前治理检查。" : "存在尚未满足治理或连接要求的技能绑定。", channel: "至少启用了一个公开或已连接渠道。" };
  return labels[id] || fallback;
}

function buildChannelsHref(representativeSlug: string, locale: Locale) {
  return `/dashboard?rep=${encodeURIComponent(representativeSlug)}&view=channels&lang=${locale}`;
}
