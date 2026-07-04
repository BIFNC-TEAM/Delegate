import Link from "next/link";
import { headers } from "next/headers";
import { demoRepresentative } from "@delegate/domain";
import {
  LanguageSwitcher,
  buildLocalizedHref,
  extractCountryHint,
  pickCopy,
  resolveServiceUrl,
  resolveLocale,
  type Locale,
} from "@delegate/web-ui";

import { DashboardOverview } from "./dashboard-overview";
import { DashboardCompute } from "./dashboard-compute";
import { DashboardOpenViking } from "./dashboard-openviking";
import { DashboardRepresentativeDirectory } from "./dashboard-representative-directory";
import { DashboardRepresentativeSetup } from "./dashboard-representative-setup";
import { DashboardSkillPacks } from "./dashboard-skill-packs";
import { DashboardTraining } from "./dashboard-training";
import { DashboardWallet } from "./dashboard-wallet";
import { listRepresentativeDirectoryItems } from "@delegate/web-data";
import { requireOwnerAuthSession } from "../auth/owner-session";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ rep?: string; view?: string; lang?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const ownerSession = await requireOwnerAuthSession(buildDashboardReturnTo(params));
  const headerStore = await headers();
  const locale = resolveLocale({
    requestedLocale: params?.lang,
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });
  const t = pickCopy(locale, dashboardCopy);
  const representatives = await listRepresentativeDirectoryItems(ownerSession?.ownerId);
  const fallbackSlug = representatives[0]?.slug ?? demoRepresentative.slug;
  const requestedSlug = params?.rep?.trim();
  const requestedView = params?.view?.trim();
  const activeSlug =
    requestedSlug && representatives.some((representative) => representative.slug === requestedSlug)
      ? requestedSlug
      : fallbackSlug;
  const activeView = isDashboardView(requestedView) ? requestedView : "overview";
  const currentHost = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const websiteBaseUrl = resolveServiceUrl(process.env.NEXT_PUBLIC_SITE_URL, "http://localhost:3000", {
    currentAppDefaultPort: 3001,
    currentHost,
  });
  const representativeBaseUrl = resolveServiceUrl(
    process.env.NEXT_PUBLIC_REPRESENTATIVE_URL,
    "http://localhost:3002",
    {
      currentAppDefaultPort: 3001,
      currentHost,
    },
  );
  const tabs = t.tabs;
  const activeTab = tabs.find((tab) => tab.id === activeView) ?? tabs[0]!;

  return (
    <main className="dashboard-shell localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <header className="dashboard-topbar">
        <div className="dashboard-topbar-main">
          <div className="dashboard-brand">
            <div className="dashboard-brand-mark">D</div>
            <div>
              <strong>{t.brandTitle}</strong>
              <div className="muted">{t.brandTagline}</div>
            </div>
          </div>

          <nav aria-label={t.menuAriaLabel} className="dashboard-menu-tabs">
            {tabs.map((tab) => {
              const isActive = tab.id === activeView;

              return (
                <Link
                  className={isActive ? "dashboard-menu-tab dashboard-menu-tab-active" : "dashboard-menu-tab"}
                  href={`/dashboard?rep=${activeSlug}&view=${tab.id}&lang=${locale}`}
                  key={tab.id}
                >
                  {tab.shortLabel}
                </Link>
              );
            })}
          </nav>

          <div className="dashboard-nav-links">
            <LanguageSwitcher
              activeLocale={locale}
              ariaLabel={t.languageAriaLabel}
              items={[
                {
                  locale: "zh",
                  href: `/dashboard?rep=${activeSlug}&view=${activeView}&lang=zh`,
                  label: t.language.zh,
                  shortLabel: "ZH",
                },
                {
                  locale: "en",
                  href: `/dashboard?rep=${activeSlug}&view=${activeView}&lang=en`,
                  label: t.language.en,
                  shortLabel: "EN",
                },
              ]}
            />
            <a className="dashboard-nav-link" href={buildLocalizedHref(`${websiteBaseUrl}/`, locale)}>
              {t.websiteLabel}
            </a>
            <a
              className="dashboard-nav-link"
              href={buildLocalizedHref(`${representativeBaseUrl}/reps/${activeSlug}`, locale)}
            >
              {t.publicRepresentativeLabel}
            </a>
          </div>
        </div>

        <div className="dashboard-topbar-context">
          <span className="chip">{activeSlug}</span>
          <span className="chip chip-safe">{activeTab.label}</span>
          <span className="chip">{t.entryScopeLabel}</span>
          <span className="chip">{t.runtimeLabel}</span>
        </div>
      </header>

      <div className="dashboard-layout">
        <aside className="dashboard-rail">
          <DashboardRepresentativeDirectory
            activeSlug={activeSlug}
            activeView={activeView}
            initialRepresentatives={representatives}
            locale={locale}
            representativeBaseUrl={representativeBaseUrl}
          />
        </aside>

        <section className="dashboard-main">
          <div className="dashboard-stage">
            <div className="dashboard-stage-main">
              <div className="dashboard-stage-route">
                <p className="eyebrow">{t.workspaceEyebrow}</p>
                <span className="chip">{activeTab.eyebrow}</span>
              </div>
              <h1>{activeTab.stageTitle}</h1>
              <p className="dashboard-stage-copy">{activeTab.stageCopy}</p>
            </div>

            <div className="dashboard-stage-stats" aria-label={t.stageStatsAriaLabel}>
              <article className="dashboard-stage-stat">
                <span>{t.currentWorkspaceLabel}</span>
                <strong>{activeSlug}</strong>
                <p>{t.currentWorkspaceDetail}</p>
              </article>
              <article className="dashboard-stage-stat">
                <span>{t.currentLaneLabel}</span>
                <strong>{activeTab.label}</strong>
                <p>{activeTab.blurb}</p>
              </article>
              <article className="dashboard-stage-stat">
                <span>{t.routingLabel}</span>
                <strong>{t.entryScopeLabel}</strong>
                <p>{t.routingDetail}</p>
              </article>
              <article className="dashboard-stage-stat dashboard-stage-stat-accent">
                <span>{t.frontDeskLabel}</span>
                <strong>{t.frontDeskValue}</strong>
                <p>{t.frontDeskDetail}</p>
              </article>
            </div>
          </div>

          <div className="dashboard-view">
            {activeView === "overview" ? <DashboardOverview locale={locale} representativeSlug={activeSlug} /> : null}
            {activeView === "setup" ? (
              <DashboardRepresentativeSetup locale={locale} representativeSlug={activeSlug} />
            ) : null}
            {activeView === "skills" ? <DashboardSkillPacks locale={locale} representativeSlug={activeSlug} /> : null}
            {activeView === "compute" ? <DashboardCompute locale={locale} representativeSlug={activeSlug} /> : null}
            {activeView === "wallet" ? <DashboardWallet locale={locale} representativeSlug={activeSlug} /> : null}
            {activeView === "memory" ? <DashboardOpenViking locale={locale} representativeSlug={activeSlug} /> : null}
            {activeView === "training" ? <DashboardTraining locale={locale} representativeSlug={activeSlug} /> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

type DashboardView = "overview" | "setup" | "skills" | "compute" | "wallet" | "memory" | "training";

function isDashboardView(value: string | undefined): value is DashboardView {
  return (
    value === "overview" ||
    value === "setup" ||
    value === "skills" ||
    value === "compute" ||
    value === "wallet" ||
    value === "memory" ||
    value === "training"
  );
}

function buildDashboardReturnTo(params: { rep?: string; view?: string; lang?: string } | undefined): string {
  const search = new URLSearchParams();
  if (params?.rep) {
    search.set("rep", params.rep);
  }
  if (params?.view) {
    search.set("view", params.view);
  }
  if (params?.lang) {
    search.set("lang", params.lang);
  }
  const query = search.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

const dashboardCopy: Record<
  Locale,
  {
    brandTitle: string;
    brandTagline: string;
    menuAriaLabel: string;
    tabs: Array<{
      id: DashboardView;
      label: string;
      eyebrow: string;
      blurb: string;
      shortLabel: string;
      stageTitle: string;
      stageCopy: string;
    }>;
    languageAriaLabel: string;
    language: { zh: string; en: string };
    websiteLabel: string;
    publicRepresentativeLabel: string;
    entryScopeLabel: string;
    runtimeLabel: string;
    workspaceEyebrow: string;
    currentWorkspaceLabel: string;
    currentWorkspaceDetail: string;
    currentLaneLabel: string;
    routingLabel: string;
    routingDetail: string;
    frontDeskLabel: string;
    frontDeskValue: string;
    frontDeskDetail: string;
    stageStatsAriaLabel: string;
  }
> = {
  zh: {
    brandTitle: "Owner 控制台",
    brandTagline: "面向公开代表的运营控制平面",
    menuAriaLabel: "控制台菜单",
    tabs: [
      {
        id: "overview",
        label: "概览",
        eyebrow: "高频",
        blurb: "先看 owner inbox、付款和今天的信号。",
        shortLabel: "概览",
        stageTitle: "先处理队列、付款和升级请求，再决定要不要亲自接手。",
        stageCopy: "概览页应该像运营驾驶舱，先帮你判断今天哪里值得看、哪里该回、哪些请求已经接近成交。",
      },
      {
        id: "setup",
        label: "代表",
        eyebrow: "发布",
        blurb: "身份、契约、价格与公开知识。",
        shortLabel: "代表",
        stageTitle: "把公开身份、会话契约和知识包编辑成能直接发布的代表入口。",
        stageCopy: "这一页不是宣传页文案，而是网页代表页与公开运行时共同读取的发布配置。保存之后，公开入口和运行时应该同时更新。",
      },
      {
        id: "skills",
        label: "技能",
        eyebrow: "扩展",
        blurb: "来自内建与 ClawHub 的安全技能包。",
        shortLabel: "技能",
        stageTitle: "只安装能提升转化、又不打破 trust boundary 的技能包。",
        stageCopy: "技能页应该帮助你判断哪些能力值得启用，而不是把代表重新变回一个可随意执行代码的 agent。",
      },
      {
        id: "compute",
        label: "计算",
        eyebrow: "隔离",
        blurb: "审批、session、artifact 与 compute 成本控制。",
        shortLabel: "计算",
        stageTitle: "把 exec、browser 和 artifact 放进隔离 compute plane，而不是让公开代表直接接触宿主机。",
        stageCopy: "这页不是终端替身，而是受 policy、approval 和 billing 约束的计算控制台。先决定哪些请求值得批准，再观察 session 和 artifact 是否处在受控边界内。",
      },
      {
        id: "wallet",
        label: "钱包",
        eyebrow: "AMN",
        blurb: "Agent token、creator 分成、提现冻结和账本。",
        shortLabel: "钱包",
        stageTitle: "把 Agent 钱包从黑盒变成 owner 能看懂的资金控制台。",
        stageCopy: "这里展示用户充值进入 Agent token 后的余额、creator pending/withdrawable，以及提现申请和最近 ledger。先看清楚钱在哪里，再做自动化。",
      },
      {
        id: "memory",
        label: "记忆",
        eyebrow: "进阶",
        blurb: "OpenViking sync、recall provenance 与记忆治理。",
        shortLabel: "记忆",
        stageTitle: "把 recall、commit 和记忆预览收进可治理的控制台，而不是藏在后端日志里。",
        stageCopy: "记忆页服务的是治理，不是炫技。这里要看得清是否在同步、召回了什么、有没有越界，以及哪里该回退到确定性流程。",
      },
      {
        id: "training",
        label: "养成",
        eyebrow: "闭环",
        blurb: "资料源、反馈、建议、审批和版本。",
        shortLabel: "养成",
        stageTitle: "让 creator 持续喂资料、改答案、审批建议，把 Delegate 越养越像自己。",
        stageCopy: "养成页把资料登记、纠错反馈、训练建议和发布版本串成一条可审计链路。系统可以提建议，但进入正式知识前必须有人审。",
      },
    ],
    languageAriaLabel: "语言切换",
    language: { zh: "中文", en: "English" },
    websiteLabel: "官网",
    publicRepresentativeLabel: "公开代表页",
    entryScopeLabel: "Web-first",
    runtimeLabel: "Trust-first runtime",
    workspaceEyebrow: "当前工作区",
    currentWorkspaceLabel: "工作区",
    currentWorkspaceDetail: "左侧 rail 只负责切换代表，右侧保持当前任务上下文。",
    currentLaneLabel: "当前操作",
    routingLabel: "入口范围",
    routingDetail: "第一版先覆盖网页代表页、网页聊天、充值预览和人工转接；Telegram、WhatsApp、飞书等消息入口属于后续扩展。",
    frontDeskLabel: "接待模式",
    frontDeskValue: "先接住，再升级",
    frontDeskDetail: "高频问题、付费续用、审批和人工转接都应该进入明确队列。",
    stageStatsAriaLabel: "当前工作区摘要",
  },
  en: {
    brandTitle: "Owner Dashboard",
    brandTagline: "Operational control plane for public representatives",
    menuAriaLabel: "Dashboard menu",
    tabs: [
      {
        id: "overview",
        label: "Overview",
        eyebrow: "High frequency",
        blurb: "Owner inbox, payment flow, and daily signal first.",
        shortLabel: "Overview",
        stageTitle: "Triage the queue, paid unlocks, and escalation requests before anything else.",
        stageCopy: "Overview should feel like an operator desk: what needs attention today, what is converting, and what is worth the owner's time right now.",
      },
      {
        id: "setup",
        label: "Representative",
        eyebrow: "Launch",
        blurb: "Profile, contract, pricing, and public knowledge.",
        shortLabel: "Representative",
        stageTitle: "Publish the representative identity, conversation contract, and public knowledge as one launch surface.",
        stageCopy: "This is not marketing copy. It is the shared configuration that powers the web representative page and public runtime.",
      },
      {
        id: "skills",
        label: "Skills",
        eyebrow: "Expansion",
        blurb: "Bounded packs from builtin and ClawHub sources.",
        shortLabel: "Skills",
        stageTitle: "Enable only the skill packs that improve conversion without widening the runtime trust boundary.",
        stageCopy: "The skill lane should help an owner make controlled capability decisions, not turn the representative back into an open-ended tool runner.",
      },
      {
        id: "compute",
        label: "Compute",
        eyebrow: "Isolated",
        blurb: "Approvals, sessions, artifacts, and compute cost control.",
        shortLabel: "Compute",
        stageTitle: "Put exec, browser, and artifacts inside an isolated compute plane instead of exposing the host.",
        stageCopy: "This is not a terminal replacement. It is a governed compute lane shaped by policy, approval, and billing. Approve the right requests first, then inspect sessions and artifacts.",
      },
      {
        id: "wallet",
        label: "Wallet",
        eyebrow: "AMN",
        blurb: "Agent tokens, creator share, withdrawal freezes, and ledger trail.",
        shortLabel: "Wallet",
        stageTitle: "Turn the Agent wallet from a black box into an owner-readable money console.",
        stageCopy: "This lane shows where user-funded Agent tokens, creator pending/withdrawable balances, withdrawal requests, and recent ledger entries stand before more automation is added.",
      },
      {
        id: "memory",
        label: "Memory",
        eyebrow: "Advanced",
        blurb: "OpenViking sync, recall provenance, and memory governance.",
        shortLabel: "Memory",
        stageTitle: "Keep recall, commit, and memory previews inside an operable governance console.",
        stageCopy: "This lane is for control, not magic. Owners should see what is syncing, what was recalled, and where the system should fall back to deterministic behavior.",
      },
      {
        id: "training",
        label: "Training",
        eyebrow: "Loop",
        blurb: "Sources, feedback, suggestions, review, and versions.",
        shortLabel: "Training",
        stageTitle: "Help the creator keep feeding, correcting, and approving what the Delegate should learn.",
        stageCopy: "The training lane turns source registration, corrections, draft suggestions, and published versions into an auditable loop. The system can suggest; humans approve before public knowledge changes.",
      },
    ],
    languageAriaLabel: "Language switcher",
    language: { zh: "Chinese", en: "English" },
    websiteLabel: "Website",
    publicRepresentativeLabel: "Public Representative",
    entryScopeLabel: "Web-first",
    runtimeLabel: "Trust-first runtime",
    workspaceEyebrow: "Current workspace",
    currentWorkspaceLabel: "Workspace",
    currentWorkspaceDetail: "The left rail only switches representatives. The right pane keeps the active task context intact.",
    currentLaneLabel: "Current lane",
    routingLabel: "Channel scope",
    routingDetail: "This first version covers the web representative page, web chat, recharge preview, and human handoff. Telegram, WhatsApp, Feishu, and other message channels come later.",
    frontDeskLabel: "Front desk mode",
    frontDeskValue: "Receive, then escalate",
    frontDeskDetail: "FAQs, paid continuation, approvals, and human handoff should all land in explicit queues.",
    stageStatsAriaLabel: "Current workspace summary",
  },
};
