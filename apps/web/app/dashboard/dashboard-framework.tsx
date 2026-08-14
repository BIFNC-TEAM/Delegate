import Link from "next/link";
import type { ReactNode } from "react";

import { buildLocalizedHref, type Locale } from "@delegate/web-ui";
import type {
  ConversationDetailSnapshot,
  ConversationInboxSnapshot,
  RepresentativeDirectoryItem,
  RepresentativeOperationsSnapshot,
} from "@delegate/web-data";
import type {
  OwnerOperationalAlertSummary,
  OwnerSettingsSnapshot,
} from "@delegate/web-data/owner-settings";

import {
  dashboardNavigation,
  dashboardSectionBlueprints,
  localize,
  type DashboardSectionBlueprint,
  type DashboardView,
} from "./dashboard-ui-data";
import { DashboardKnowledgeLibrary } from "./dashboard-knowledge-library";
import { DashboardInbox } from "./dashboard-inbox";
import { DashboardRepresentativeOperations } from "./dashboard-representative-operations";
import { DashboardApprovals } from "./dashboard-approvals";
import { DashboardSkills } from "./dashboard-skills";
import { DashboardAuditLogs } from "./dashboard-audit-logs";
import { DashboardChannels } from "./dashboard-channels";
import { DashboardWallet } from "./dashboard-wallet";
import { DashboardSettings } from "./dashboard-settings";
import type { SettingsSection } from "./settings-section-navigation";

const channelControlPlaneViews = ["channels", "audit"] as const;
const functionalDashboardViews = new Set<DashboardView>([
  "knowledge",
  "representatives",
  "inbox",
  "approvals",
  "skills", "wallet", "audit", "settings",
  ...channelControlPlaneViews,
]);

type DashboardFrameworkProps = {
  accountLabel: string;
  activeSlug: string;
  activeView: DashboardView;
  conversationDetail: ConversationDetailSnapshot | null;
  inboxSnapshot: ConversationInboxSnapshot | null;
  locale: Locale;
  logoutHref?: string;
  loginHref?: string;
  representativeBaseUrl: string;
  representatives: RepresentativeDirectoryItem[];
  representativeOperations: RepresentativeOperationsSnapshot | null;
  operationalAlerts: OwnerOperationalAlertSummary;
  ownerSettings: OwnerSettingsSnapshot;
  settingsSection: SettingsSection;
  settingsTimeZones: string[];
  websiteBaseUrl: string;
};

const frameworkCopy = {
  zh: {
    brandKicker: "Digital Representative OS",
    workspaceLabel: "当前工作区",
    workspaceName: "Delegate Studio",
    workspaceMeta: (count: number) => `${count} 个数字代表`,
    switchWorkspace: "切换代表",
    navAria: "Dashboard 主导航",
    frameworkBadge: "UI Framework",
    frameworkHint: "当前展示新版整体框架，业务数据与动作将分阶段接入。",
    search: "搜索代表、会话、知识或 Action",
    website: "官网",
    publicPage: "公开代表页",
    signOut: "退出",
    signIn: "登录",
    commandKey: "⌘ K",
    activeRepresentative: "当前代表",
    allRepresentatives: "全部代表",
    pageActions: "页面操作",
    filters: "筛选",
    searchList: "搜索当前列表",
    export: "导出",
    more: "更多",
    viewAll: "查看全部",
    notConnected: "功能待接入",
    accountSettings: "Owner 账户设置",
    accountSettingsMeta: "不受当前代表影响",
  },
  en: {
    brandKicker: "Digital Representative OS",
    workspaceLabel: "Current workspace",
    workspaceName: "Delegate Studio",
    workspaceMeta: (count: number) => `${count} digital representatives`,
    switchWorkspace: "Switch representative",
    navAria: "Dashboard navigation",
    frameworkBadge: "UI Framework",
    frameworkHint: "This is the new product framework. Business data and actions will be connected incrementally.",
    search: "Search reps, conversations, knowledge, or actions",
    website: "Website",
    publicPage: "Public page",
    signOut: "Sign out",
    signIn: "Sign in",
    commandKey: "⌘ K",
    activeRepresentative: "Active representative",
    allRepresentatives: "All representatives",
    pageActions: "Page actions",
    filters: "Filters",
    searchList: "Search this list",
    export: "Export",
    more: "More",
    viewAll: "View all",
    notConnected: "Coming next",
    accountSettings: "Owner account settings",
    accountSettingsMeta: "Independent of the active representative",
  },
} as const;

export function DashboardFramework(props: DashboardFrameworkProps) {
  const t = frameworkCopy[props.locale];
  const hasActiveRepresentative =
    Boolean(props.activeSlug)
    && props.representatives.some(
      (representative) => representative.slug === props.activeSlug,
    );
  const activeNavigationItem = dashboardNavigation
    .flatMap((group) => group.items)
    .find((item) => item.id === props.activeView);

  return (
    <main
      className="dashboard-v2-shell localized-shell"
      data-locale={props.locale}
      data-ui-stage={functionalDashboardViews.has(props.activeView) ? "functional" : "framework"}
      lang={props.locale === "zh" ? "zh-CN" : "en"}
    >
      <div className="dashboard-v2-layout">
        <aside className="dashboard-v2-sidebar">
          <div className="dashboard-v2-brand">
            <span className="dashboard-v2-brand-mark">D</span>
            <div>
              <strong>Delegate</strong>
              <span>{t.brandKicker}</span>
            </div>
          </div>

          {props.activeView === "settings" ? (
            <div className="dashboard-v2-settings-scope">
              <span className="dashboard-v2-avatar">
                {props.accountLabel.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <small>{t.workspaceLabel}</small>
                <strong>{t.accountSettings}</strong>
                <em>{t.accountSettingsMeta}</em>
              </span>
            </div>
          ) : (
          <details className="dashboard-v2-workspace-switcher">
            <summary>
              <span className="dashboard-v2-avatar">DS</span>
              <span>
                <small>{t.workspaceLabel}</small>
                <strong>{t.workspaceName}</strong>
                <em>{t.workspaceMeta(props.representatives.length)}</em>
              </span>
              <span className="dashboard-v2-chevron" aria-hidden="true">⌄</span>
            </summary>
            <div className="dashboard-v2-workspace-menu">
              <p>{t.switchWorkspace}</p>
              {props.representatives.length === 0 ? (
                <Link
                  href={buildDashboardHref("representatives", "", props.locale)}
                >
                  <span>＋</span>
                  <span>
                    <strong>
                      {props.locale === "zh"
                        ? "创建第一个数字代表"
                        : "Create the first representative"}
                    </strong>
                    <small>
                      {props.locale === "zh"
                        ? "进入代表目录"
                        : "Open the representative directory"}
                    </small>
                  </span>
                </Link>
              ) : null}
              {props.representatives.map((representative) => (
                <Link
                  className={representative.slug === props.activeSlug ? "is-active" : undefined}
                  href={buildDashboardHref(props.activeView, representative.slug, props.locale)}
                  key={representative.id}
                >
                  <span>{representative.name.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{representative.name}</strong>
                    <small>{representative.slug}</small>
                  </span>
                </Link>
              ))}
            </div>
          </details>
          )}

          <details className="dashboard-v2-mobile-menu">
            <summary>
              <span>{activeNavigationItem ? localize(props.locale, activeNavigationItem.shortLabel) : "Menu"}</span>
              <b>☰</b>
            </summary>
            <nav aria-label={t.navAria}>
              {dashboardNavigation.flatMap((group) => group.items).map((item) => {
                const count = dashboardNavigationCount(item.id, props.operationalAlerts);
                return (
                  <Link
                    aria-current={
                      item.id === props.activeView ? "page" : undefined
                    }
                    className={item.id === props.activeView ? "is-active" : undefined}
                    href={buildDashboardHref(
                      item.id,
                      props.activeSlug,
                      props.locale,
                      item.id === "settings" ? props.settingsSection : undefined,
                    )}
                    key={item.id}
                  >
                    <span>{item.index}</span>
                    <strong>{localize(props.locale, item.label)}</strong>
                    {count ? (
                      <b
                        aria-label={props.locale === "zh" ? `${count} 项待处理` : `${count} items need attention`}
                        className="dashboard-v2-nav-count"
                      >
                        {formatNavigationCount(count)}
                      </b>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </details>

          <nav aria-label={t.navAria} className="dashboard-v2-navigation">
            {dashboardNavigation.map((group) => (
              <div className="dashboard-v2-nav-group" key={group.label.en}>
                <p>{localize(props.locale, group.label)}</p>
                {group.items.map((item) => {
                  const isActive = item.id === props.activeView;
                  const count = dashboardNavigationCount(item.id, props.operationalAlerts);
                  return (
                    <Link
                      aria-current={isActive ? "page" : undefined}
                      className={isActive ? "dashboard-v2-nav-item is-active" : "dashboard-v2-nav-item"}
                      href={buildDashboardHref(
                        item.id,
                        props.activeSlug,
                        props.locale,
                        item.id === "settings" ? props.settingsSection : undefined,
                      )}
                      key={item.id}
                    >
                      <span className="dashboard-v2-nav-index">{item.index}</span>
                      <span>{localize(props.locale, item.label)}</span>
                      {count ? (
                        <strong
                          aria-label={props.locale === "zh" ? `${count} 项待处理` : `${count} items need attention`}
                          className="dashboard-v2-nav-count"
                        >
                          {formatNavigationCount(count)}
                        </strong>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="dashboard-v2-sidebar-footer">
            <div className="dashboard-v2-account">
              <span>{props.accountLabel.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{props.accountLabel}</strong>
                <small>Owner</small>
              </div>
              {props.logoutHref ? (
                <form action={props.logoutHref} method="post">
                  <button
                    aria-label={t.signOut}
                    title={t.signOut}
                    type="submit"
                  >
                    <span aria-hidden="true">↗</span>
                  </button>
                </form>
              ) : props.loginHref ? (
                <a aria-label={t.signIn} href={props.loginHref} title={t.signIn}>
                  <span aria-hidden="true">↗</span>
                </a>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="dashboard-v2-workspace">
          <header className="dashboard-v2-topbar">
            <div className="dashboard-v2-mobile-brand">
              <span className="dashboard-v2-brand-mark">D</span>
              <strong>Delegate</strong>
            </div>
            <button className="dashboard-v2-search" type="button" title={t.notConnected}>
              <span aria-hidden="true">⌕</span>
              <span>{t.search}</span>
              <kbd>{t.commandKey}</kbd>
            </button>
            <div className="dashboard-v2-top-actions">
              <a className="dashboard-v2-text-link" href={buildLocalizedHref(`${props.websiteBaseUrl}/`, props.locale)}>
                {t.website}
              </a>
              {props.activeView !== "settings" && hasActiveRepresentative ? (
                <a
                  className="dashboard-v2-top-button"
                  href={buildLocalizedHref(`${props.representativeBaseUrl}/reps/${props.activeSlug}`, props.locale)}
                >
                  {t.publicPage}
                  <span>↗</span>
                </a>
              ) : null}
            </div>
          </header>

          {!functionalDashboardViews.has(props.activeView) ? (
            <div className="dashboard-v2-framework-note">
              <span>{t.frameworkBadge}</span>
              <p>{t.frameworkHint}</p>
            </div>
          ) : null}

          <div className="dashboard-v2-content">
            {!hasActiveRepresentative
              && props.activeView !== "representatives"
              && props.activeView !== "knowledge"
              && props.activeView !== "settings" ? (
              <DashboardRepresentativeOnboarding
                activeView={props.activeView}
                locale={props.locale}
              />
            ) : props.activeView === "overview" ? (
              <DashboardOverviewFramework
                activeSlug={props.activeSlug}
                locale={props.locale}
                representativeBaseUrl={props.representativeBaseUrl}
                representativeCount={props.representatives.length}
              />
            ) : props.activeView === "knowledge" ? (
              <DashboardKnowledgeLibrary activeSlug={props.activeSlug} locale={props.locale} />
            ) : props.activeView === "representatives" ? (
              <DashboardRepresentativeOperations
                accountLabel={props.accountLabel}
                activeSlug={props.activeSlug}
                initialSnapshot={props.representativeOperations}
                locale={props.locale}
                representativeBaseUrl={props.representativeBaseUrl}
                representatives={props.representatives}
              />
            ) : props.activeView === "inbox" && props.inboxSnapshot ? (
              <DashboardInbox
                activeSlug={props.activeSlug}
                initialDetail={props.conversationDetail}
                initialSnapshot={props.inboxSnapshot}
                locale={props.locale}
              />
            ) : props.activeView === "approvals" ? (
              <DashboardApprovals activeSlug={props.activeSlug} locale={props.locale} />
            ) : props.activeView === "skills" ? (
              <DashboardSkills activeSlug={props.activeSlug} locale={props.locale} />
            ) : props.activeView === "channels" ? (
              <DashboardChannels activeSlug={props.activeSlug} locale={props.locale} />
            ) : props.activeView === "wallet" ? (
              <DashboardWallet
                activeSlug={props.activeSlug}
                locale={props.locale}
                representatives={props.representatives.map((representative) => ({
                  slug: representative.slug,
                  name: representative.name,
                }))}
              />
            ) : props.activeView === "audit" ? (
              <DashboardAuditLogs activeSlug={props.activeSlug} locale={props.locale} />
            ) : props.activeView === "settings" ? (
              <DashboardSettings
                alertSummary={props.operationalAlerts}
                initialSection={props.settingsSection}
                initialSnapshot={props.ownerSettings}
                locale={props.locale}
                logoutHref={props.logoutHref}
                timeZones={props.settingsTimeZones}
              />
            ) : (
              <DashboardSectionFramework
                blueprint={dashboardSectionBlueprints[props.activeView]}
                locale={props.locale}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function DashboardRepresentativeOnboarding({
  activeView,
  locale,
}: {
  activeView: DashboardView;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const activeNavigationItem = dashboardNavigation
    .flatMap((group) => group.items)
    .find((item) => item.id === activeView);
  const viewLabel = activeNavigationItem
    ? localize(locale, activeNavigationItem.label)
    : zh
      ? "当前模块"
      : "This module";

  return (
    <>
      <header className="dashboard-v2-page-header">
        <div>
          <p>ONBOARDING / 00</p>
          <h1>
            {zh
              ? "先创建第一个数字代表。"
              : "Create your first representative."}
          </h1>
          <span>
            {zh
              ? `${viewLabel} 只会显示当前 Owner 真实拥有的数据；创建完成前不会加载示例代表或其他 Owner 的记录。`
              : `${viewLabel} only shows data owned by the current Owner. No demo representative or another Owner's records are loaded before creation.`}
          </span>
        </div>
      </header>

      <section
        aria-labelledby="dashboard-empty-representative-title"
        className="dashboard-v2-panel is-teal"
      >
        <div className="representative-directory-empty">
          <span>REPRESENTATIVES / 00</span>
          <h3 id="dashboard-empty-representative-title">
            {zh ? "当前工作区还没有数字代表" : "No representatives in this workspace"}
          </h3>
          <p>
            {zh
              ? "创建后会直接进入五步草稿配置；在你完成发布前，不会生成公开页面。"
              : "Creation opens the five-step draft setup. Nothing becomes public until you publish it."}
          </p>
          <div className="dashboard-v2-page-actions">
            <Link
              className="dashboard-v2-button-primary"
              href={buildDashboardHref("representatives", "", locale)}
            >
              {zh ? "创建数字代表" : "Create representative"}
            </Link>
            <Link
              className="dashboard-v2-button-secondary"
              href={buildDashboardHref("settings", "", locale)}
            >
              {zh ? "先查看账户设置" : "Review account settings"}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function DashboardOverviewFramework({
  activeSlug,
  locale,
  representativeBaseUrl,
  representativeCount,
}: {
  activeSlug: string;
  locale: Locale;
  representativeBaseUrl: string;
  representativeCount: number;
}) {
  const zh = locale === "zh";
  const metricCards = [
    { label: zh ? "数字代表总数" : "Representatives", value: String(Math.max(representativeCount, 1)).padStart(2, "0"), detail: zh ? "覆盖整个工作区" : "Across this workspace", tone: "teal" },
    { label: zh ? "已发布代表" : "Published", value: String(Math.max(representativeCount, 1)).padStart(2, "0"), detail: zh ? "正在公开接待" : "Live public interfaces" },
    { label: zh ? "知识库文件" : "Knowledge files", value: "24", detail: zh ? "19 个已完成处理" : "19 fully processed" },
    { label: zh ? "今日会话" : "Conversations today", value: "18", detail: zh ? "较昨日 +12%" : "+12% from yesterday", tone: "indigo" },
    { label: zh ? "待审批 Action" : "Pending actions", value: "05", detail: zh ? "2 个高风险" : "2 high risk", tone: "warning" },
    { label: zh ? "本月收入" : "Revenue this month", value: "—", detail: zh ? "进入钱包查看实时数据" : "Open Wallet for live data" },
  ] as const;
  const resources = [
    [zh ? "知识库文件" : "Knowledge files", "24", "19 / 5"],
    [zh ? "已处理文件" : "Processed files", "19", "79%"],
    ["FAQ", "36", zh ? "31 已批准" : "31 approved"],
    [zh ? "服务范围" : "Service scopes", "12", zh ? "9 已发布" : "9 published"],
    [zh ? "技能" : "Skills", "08", zh ? "6 已启用" : "6 enabled"],
    [zh ? "待处理 Inbox" : "Open inbox", "12", zh ? "4 需接手" : "4 handoffs"],
    [zh ? "未发布草稿" : "Unpublished drafts", "03", zh ? "需要审核" : "Needs review"],
  ];
  const todos = [
    { label: zh ? "审批发送报价文件" : "Approve proposal delivery", meta: zh ? "高风险 · 28 分钟后过期" : "High risk · expires in 28 min", tone: "warning" },
    { label: zh ? "处理 Alex Chen 的 Handoff" : "Review Alex Chen handoff", meta: zh ? "Collaboration · 已付费" : "Collaboration · Paid", tone: "indigo" },
    { label: zh ? "审核 6 条生成 FAQ" : "Review 6 generated FAQs", meta: zh ? "来自 Founder profile.pdf" : "From Founder profile.pdf", tone: "teal" },
    { label: zh ? "补全招聘代表的价格配置" : "Complete recruiting rep pricing", meta: zh ? "发布检查 6 / 8" : "Publish checklist 6 / 8", tone: "neutral" },
  ];
  const activities = [
    { time: "10:42", title: zh ? "审批 Action 已通过" : "Action approved", detail: zh ? "Lin AI · 发送报价文件" : "Lin AI · Proposal delivery", kind: "AP" },
    { time: "09:52", title: zh ? "数字代表已发布" : "Representative published", detail: zh ? "招聘接待代表 · v0.8" : "Recruiting front desk · v0.8", kind: "DR" },
    { time: "09:18", title: zh ? "知识文件处理完成" : "Knowledge processing complete", detail: "Founder profile.pdf · 18 chunks", kind: "KB" },
  ];

  return (
    <>
      <DashboardPageHeader
        action={zh ? "上传知识文件" : "Upload knowledge"}
        description={zh ? "先看运营脉冲和需要你介入的事项，再进入知识、代表和收益细节。" : "Start with the operating pulse and items that need you, then move into knowledge, representatives, and revenue."}
        eyebrow="Control Plane / 00"
        title={zh ? "早上好，今天有 5 个 Action 等你决定。" : "Good morning. Five actions need your decision."}
      />

      <section className="dashboard-v2-metric-grid dashboard-v2-metric-grid-six">
        {metricCards.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </section>

      <div className="dashboard-v2-overview-grid">
        <Panel
          action={<Link href={buildDashboardHref("knowledge", activeSlug, locale)}>{zh ? "管理知识库" : "Manage library"} →</Link>}
          eyebrow={zh ? "资源矩阵" : "Resource matrix"}
          title={zh ? "工作区资产与发布状态" : "Workspace assets and publishing state"}
        >
          <div className="dashboard-v2-resource-matrix">
            {resources.map(([label, value, detail], index) => (
              <article key={label}>
                <span className={index === 5 || index === 6 ? "is-attention" : undefined}>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </div>
                <b>{value}</b>
              </article>
            ))}
          </div>
        </Panel>

        <Panel
          action={<Link href={buildDashboardHref("approvals", activeSlug, locale)}>{zh ? "进入待办" : "Open queue"} →</Link>}
          eyebrow={zh ? "待办中心" : "Action center"}
          title={zh ? "现在最值得处理的事项" : "What deserves attention now"}
          tone="indigo"
        >
          <div className="dashboard-v2-todo-list">
            {todos.map((todo, index) => (
              <article key={todo.label}>
                <span className={`dashboard-v2-todo-tone is-${todo.tone}`} />
                <div>
                  <strong>{todo.label}</strong>
                  <small>{todo.meta}</small>
                </div>
                <b>{String(index + 1).padStart(2, "0")}</b>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <div className="dashboard-v2-overview-grid dashboard-v2-overview-grid-bottom">
        <Panel
          action={<Link href={buildDashboardHref("wallet", activeSlug, locale)}>{zh ? "查看钱包" : "Open wallet"} →</Link>}
          eyebrow={zh ? "钱包摘要" : "Wallet summary"}
          title={zh ? "收入、可提现与最近交易" : "Revenue, withdrawable balance, and recent transactions"}
        >
          <div className="dashboard-v2-wallet-summary">
            <div className="dashboard-v2-wallet-balance">
              <small>{zh ? "实时资金数据" : "Live money data"}</small>
              <strong>—</strong>
              <span>{zh ? "概览暂不加载资金数据" : "Financial data is not loaded in Overview"}</span>
            </div>
            <div className="dashboard-v2-wallet-split">
              <div><span>{zh ? "可提现" : "Withdrawable"}</span><strong>—</strong></div>
              <div><span>{zh ? "待释放" : "Pending"}</span><strong>—</strong></div>
            </div>
          </div>
          <div className="dashboard-v2-mini-transactions">
            <div>
              <span>→</span>
              <p>
                <strong>{zh ? "资金数据仅在钱包模块读取" : "Financial data loads only in Wallet"}</strong>
                <small>{zh ? "避免示例金额冒充真实余额" : "Sample amounts are never presented as live balances"}</small>
              </p>
              <b>—</b>
            </div>
          </div>
        </Panel>

        <Panel
          action={<Link href={buildDashboardHref("audit", activeSlug, locale)}>{zh ? "全部活动" : "All activity"} →</Link>}
          eyebrow={zh ? "最近活动" : "Recent activity"}
          title={zh ? "工作区刚刚发生了什么" : "What just happened in this workspace"}
        >
          <div className="dashboard-v2-activity-list">
            {activities.map((activity) => (
              <article key={`${activity.time}:${activity.title}`}>
                <span>{activity.kind}</span>
                <div><strong>{activity.title}</strong><small>{activity.detail}</small></div>
                <time>{activity.time}</time>
              </article>
            ))}
          </div>
        </Panel>

        <Panel eyebrow={zh ? "快捷操作" : "Quick actions"} title={zh ? "从常用入口开始" : "Start from a common task"} tone="teal">
          <div className="dashboard-v2-quick-actions">
            <Link href={buildDashboardHref("knowledge", activeSlug, locale)}><span>01</span><strong>{zh ? "上传知识文件" : "Upload knowledge"}</strong><b>→</b></Link>
            <Link href={buildDashboardHref("representatives", activeSlug, locale)}><span>02</span><strong>{zh ? "创建数字代表" : "Create representative"}</strong><b>→</b></Link>
            <Link href={buildDashboardHref("approvals", activeSlug, locale)}><span>03</span><strong>{zh ? "查看待审批" : "Review approvals"}</strong><b>→</b></Link>
            <a href={buildLocalizedHref(`${representativeBaseUrl}/reps/${activeSlug}`, locale)}><span>04</span><strong>{zh ? "打开公开代表页" : "Open public page"}</strong><b>↗</b></a>
          </div>
        </Panel>
      </div>
    </>
  );
}

function DashboardSectionFramework({ blueprint, locale }: { blueprint: DashboardSectionBlueprint; locale: Locale }) {
  const t = frameworkCopy[locale];
  return (
    <>
      <DashboardPageHeader
        action={localize(locale, blueprint.primaryAction)}
        description={localize(locale, blueprint.description)}
        eyebrow={localize(locale, blueprint.eyebrow)}
        title={localize(locale, blueprint.title)}
      />

      <nav aria-label="Section navigation" className="dashboard-v2-subnav">
        {blueprint.tabs.map((tab, index) => (
          <button className={index === 0 ? "is-active" : undefined} key={tab.en} title={t.notConnected} type="button">
            {localize(locale, tab)}
            {index === 0 ? <span /> : null}
          </button>
        ))}
      </nav>

      <section className="dashboard-v2-metric-grid">
        {blueprint.metrics.map((metric) => (
          <MetricCard
            detail={localize(locale, metric.detail)}
            key={metric.label.en}
            label={localize(locale, metric.label)}
            value={metric.value}
            {...(metric.tone ? { tone: metric.tone } : {})}
          />
        ))}
      </section>

      <div className="dashboard-v2-section-layout">
        <Panel
          action={<button title={t.notConnected} type="button">{t.export} ↗</button>}
          eyebrow={localize(locale, blueprint.eyebrow)}
          title={localize(locale, blueprint.table.title)}
        >
          <p className="dashboard-v2-panel-description">{localize(locale, blueprint.table.description)}</p>
          <div className="dashboard-v2-toolbar">
            <div><span>⌕</span><input aria-label={t.searchList} placeholder={t.searchList} /></div>
            <button title={t.notConnected} type="button">≡ {t.filters}</button>
            <button title={t.notConnected} type="button">•••</button>
          </div>
          <div className="dashboard-v2-table-scroll">
            <table className="dashboard-v2-table">
              <thead><tr>{blueprint.table.columns.map((column) => <th key={column.en}>{localize(locale, column)}</th>)}</tr></thead>
              <tbody>
                {blueprint.table.rows.map((row, rowIndex) => (
                  <tr key={`${blueprint.table.title.en}:${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${cell.en}:${cellIndex}`}>
                        {cellIndex === 0 ? <span className="dashboard-v2-row-primary"><i>{String(rowIndex + 1).padStart(2, "0")}</i><strong>{localize(locale, cell)}</strong></span> : localize(locale, cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dashboard-v2-table-footer"><span>1–3 / 24</span><div><button type="button">←</button><button type="button">→</button></div></div>
        </Panel>

        <aside className="dashboard-v2-module-stack">
          {blueprint.modules.map((module, index) => (
            <Panel
              action={module.status ? <span className="dashboard-v2-module-status">{localize(locale, module.status)}</span> : undefined}
              eyebrow={`${String(index + 1).padStart(2, "0")} / ${localize(locale, blueprint.eyebrow)}`}
              key={module.title.en}
              title={localize(locale, module.title)}
              tone={index === 1 ? "indigo" : "teal"}
            >
              <p className="dashboard-v2-panel-description">{localize(locale, module.description)}</p>
              <div className="dashboard-v2-module-list">
                {module.items.map((item, itemIndex) => (
                  <button key={item.en} title={t.notConnected} type="button">
                    <span>{String(itemIndex + 1).padStart(2, "0")}</span>
                    <strong>{localize(locale, item)}</strong>
                    <b>→</b>
                  </button>
                ))}
              </div>
            </Panel>
          ))}
        </aside>
      </div>
    </>
  );
}

function DashboardPageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action: string }) {
  return (
    <header className="dashboard-v2-page-header">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
      <div className="dashboard-v2-page-actions">
        <button className="dashboard-v2-button-secondary" title="UI framework" type="button">•••</button>
        <button className="dashboard-v2-button-primary" title="UI framework" type="button"><span>＋</span>{action}</button>
      </div>
    </header>
  );
}

function MetricCard({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "teal" | "indigo" | "warning" | "neutral" }) {
  return (
    <article className={`dashboard-v2-metric-card is-${tone}`}>
      <div><span>{label}</span><i /></div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function Panel({ eyebrow, title, action, children, tone = "default" }: { eyebrow: string; title: string; action?: ReactNode; children: ReactNode; tone?: "default" | "teal" | "indigo" }) {
  return (
    <section className={`dashboard-v2-panel is-${tone}`}>
      <header>
        <div><p>{eyebrow}</p><h2>{title}</h2></div>
        {action ? <div className="dashboard-v2-panel-action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

function buildDashboardHref(
  view: DashboardView,
  representativeSlug: string,
  locale: Locale,
  settingsSection?: SettingsSection,
): string {
  const parameters = new URLSearchParams({
    view,
    lang: locale,
  });
  if (representativeSlug) {
    parameters.set("rep", representativeSlug);
  }
  if (view === "settings" && settingsSection) {
    parameters.set("settingsSection", settingsSection);
  }
  return `/dashboard?${parameters.toString()}`;
}

function dashboardNavigationCount(
  view: DashboardView,
  alerts: OwnerOperationalAlertSummary,
) {
  if (alerts.dataSource !== "database") return 0;
  if (view === "inbox") {
    return alerts.topics.handoffs.enabled ? alerts.topics.handoffs.count : 0;
  }
  if (view === "approvals") {
    return alerts.topics.approvals.enabled ? alerts.topics.approvals.count : 0;
  }
  if (view === "wallet") {
    return alerts.topics.walletIssues.count;
  }
  if (view === "channels") {
    return alerts.topics.channelIssues.enabled ? alerts.topics.channelIssues.count : 0;
  }
  return 0;
}

function formatNavigationCount(count: number) {
  return count > 99 ? "99+" : String(count);
}
