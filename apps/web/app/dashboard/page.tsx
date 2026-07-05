import Link from "next/link";
import { headers } from "next/headers";
import { demoRepresentative } from "@delegate/domain";
import {
  HashScrollRestorer,
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
      <HashScrollRestorer />
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
    brandTitle: "代表控制台",
    brandTagline: "面向公开代表的运营台",
    menuAriaLabel: "控制台菜单",
    tabs: [
      {
        id: "overview",
        label: "概览",
        eyebrow: "高频",
        blurb: "先看待处理请求、付款和今天的信号。",
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
        stageCopy: "这一页不是宣传页文案，而是网页代表页和在线接待共同读取的发布配置。保存之后，公开入口会同步更新。",
      },
      {
        id: "skills",
        label: "技能",
        eyebrow: "扩展",
        blurb: "来自内建与 ClawHub 的安全技能包。",
        shortLabel: "技能",
        stageTitle: "只安装能提升转化、又不越权的技能包。",
        stageCopy: "技能页应该帮助你判断哪些能力值得启用，而不是把代表变成一个什么都能乱做的工具。",
      },
      {
        id: "compute",
        label: "审批动作",
        eyebrow: "隔离",
        blurb: "审批、执行记录、产物和成本控制。",
        shortLabel: "动作",
        stageTitle: "把敏感执行、浏览器任务和交付产物放进隔离执行区。",
        stageCopy: "这页不是终端替身，而是受规则、审批和费用约束的动作控制台。先决定哪些请求值得批准，再观察执行记录和产物是否处在安全边界内。",
      },
      {
        id: "wallet",
        label: "钱包",
        eyebrow: "资金",
        blurb: "服务额度、创作者分成、提现冻结和账本。",
        shortLabel: "钱包",
        stageTitle: "把代表钱包从黑盒变成主理人能看懂的资金台。",
        stageCopy: "这里展示用户充值后的服务额度、创作者待释放 / 可提现金额、提现申请和最近账本。先看清楚钱在哪里，再做自动化。",
      },
      {
        id: "memory",
        label: "记忆",
        eyebrow: "进阶",
        blurb: "记忆同步、召回来源与边界治理。",
        shortLabel: "记忆",
        stageTitle: "把记忆召回、保存和预览收进可治理的控制台，而不是藏在后端日志里。",
        stageCopy: "记忆页服务的是治理，不是炫技。这里要看得清是否在同步、召回了什么、有没有越界，以及哪里该回退到确定性流程。",
      },
      {
        id: "training",
        label: "养成",
        eyebrow: "闭环",
        blurb: "资料源、反馈、建议、审批和版本。",
        shortLabel: "养成",
        stageTitle: "让主理人持续喂资料、改答案、审批建议，把 Delegate 越养越像自己。",
        stageCopy: "养成页把资料登记、纠错反馈、训练建议和发布版本串成一条可审计链路。系统可以提建议，但进入正式知识前必须有人审。",
      },
    ],
    languageAriaLabel: "语言切换",
    language: { zh: "中文", en: "English" },
    websiteLabel: "官网",
    publicRepresentativeLabel: "公开代表页",
    entryScopeLabel: "网页优先",
    runtimeLabel: "先讲清边界",
    workspaceEyebrow: "当前工作区",
    currentWorkspaceLabel: "工作区",
    currentWorkspaceDetail: "左侧只负责切换代表，右侧不打断你正在看的内容。",
    currentLaneLabel: "当前操作",
    routingLabel: "入口范围",
    routingDetail: "第一版先覆盖网页代表页、网页聊天、充值预览和人工转接；Telegram、WhatsApp、飞书等消息入口属于后续扩展。",
    frontDeskLabel: "接待模式",
    frontDeskValue: "先接住，再升级",
    frontDeskDetail: "高频问题、付费续用、审批和人工转接都应该进入明确待办。",
    stageStatsAriaLabel: "当前工作区摘要",
  },
  en: {
    brandTitle: "Representative Console",
    brandTagline: "Operations desk for public representatives",
    menuAriaLabel: "Dashboard menu",
    tabs: [
      {
        id: "overview",
        label: "Overview",
        eyebrow: "High frequency",
        blurb: "Attention queue, payment flow, and daily signal first.",
        shortLabel: "Overview",
        stageTitle: "Triage the queue, paid unlocks, and escalation requests before anything else.",
        stageCopy: "Overview should feel like an operator desk: what needs attention today, what is converting, and what is worth a human follow-up right now.",
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
        stageTitle: "Enable only the skill packs that improve conversion without widening what the representative is allowed to do.",
        stageCopy: "The skill lane should help you make controlled capability decisions, not turn the representative back into an open-ended tool runner.",
      },
      {
        id: "compute",
        label: "Actions",
        eyebrow: "Isolated",
        blurb: "Approvals, run records, outputs, and cost control.",
        shortLabel: "Actions",
        stageTitle: "Put sensitive execution, browser work, and outputs inside an isolated action area.",
        stageCopy: "This is not a terminal replacement. It is a governed action lane shaped by rules, approval, and billing. Approve the right requests first, then inspect run records and outputs.",
      },
      {
        id: "wallet",
        label: "Wallet",
        eyebrow: "Money",
        blurb: "Service credits, creator share, withdrawal freezes, and ledger trail.",
        shortLabel: "Wallet",
        stageTitle: "Turn the representative wallet from a black box into a readable money console.",
        stageCopy: "This lane shows where user-funded service credits, creator pending/withdrawable balances, withdrawal requests, and recent ledger entries stand before more automation is added.",
      },
      {
        id: "memory",
        label: "Memory",
        eyebrow: "Advanced",
        blurb: "Memory sync, recall sources, and boundary governance.",
        shortLabel: "Memory",
        stageTitle: "Keep memory recall, saving, and previews inside an operable governance console.",
        stageCopy: "This lane is for control, not magic. You should see what is syncing, what was recalled, and where the system should fall back to predictable behavior.",
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
    currentWorkspaceDetail: "The left side switches representatives. The right side keeps what you are doing intact.",
    currentLaneLabel: "Current area",
    routingLabel: "Channel scope",
    routingDetail: "This first version covers the web representative page, web chat, recharge preview, and human follow-up. Telegram, WhatsApp, Feishu, and other message channels come later.",
    frontDeskLabel: "Front desk mode",
    frontDeskValue: "Receive, then escalate",
    frontDeskDetail: "FAQs, paid continuation, approvals, and human follow-up should all land in explicit queues.",
    stageStatsAriaLabel: "Current workspace summary",
  },
};
