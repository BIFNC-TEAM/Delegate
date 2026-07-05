import { headers } from "next/headers";
import { notFound } from "next/navigation";

import type { Representative } from "@delegate/domain";
import {
  getRepresentativePublicDeliverables,
  getRepresentativeSetupSnapshot,
  getRepresentativeSkillPackSnapshot,
} from "@delegate/web-data";
import {
  DashboardPanelFrame,
  DashboardSignalStrip,
  DashboardSurface,
  DashboardSurfaceGrid,
  LanguageSwitcher,
  buildLocalizedHref,
  extractCountryHint,
  pickCopy,
  resolveServiceUrl,
  resolveLocale,
  type Locale,
} from "@delegate/web-ui";

import { RepresentativeChatPanel } from "./representative-chat-panel";
import { getUsablePublicUrl } from "./public-materials";
import { RepresentativeMaterialPreview } from "./representative-material-preview";
import { RepresentativeRechargePanel } from "./representative-recharge-panel";

type RepresentativeSkill = Representative["skills"][number];

export default async function RepresentativePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lang?: string }>;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : undefined;
  const headerStore = await headers();
  const locale = resolveLocale({
    requestedLocale: query?.lang,
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });
  const t = pickCopy(locale, copy);
  const currentHost = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const siteBaseUrl = resolveServiceUrl(process.env.NEXT_PUBLIC_SITE_URL, "http://localhost:3000", {
    currentAppDefaultPort: 3002,
    currentHost,
  });
  const dashboardBaseUrl = resolveServiceUrl(
    process.env.NEXT_PUBLIC_DASHBOARD_URL,
    "http://localhost:3001",
    {
      currentAppDefaultPort: 3002,
      currentHost,
    },
  );
  const [setupSnapshot, skillPackSnapshot, deliverableSnapshot] = await Promise.all([
    getRepresentativeSetupSnapshot(slug),
    getRepresentativeSkillPackSnapshot(slug),
    getRepresentativePublicDeliverables(slug),
  ]);

  if (!setupSnapshot || !skillPackSnapshot) {
    notFound();
  }

  const representative = {
    ...setupSnapshot,
    skillPacks: skillPackSnapshot.skillPacks,
  };
  const publicDeliverables = deliverableSnapshot?.deliverables ?? [];
  const enabledSkillPacks = representative.skillPacks.filter((skillPack) => skillPack.enabled);
  const totalKnowledgeItems =
    representative.knowledgePack.faq.length +
    representative.knowledgePack.materials.length +
    representative.knowledgePack.policies.length +
    publicDeliverables.length;
  const skillLabels = buildSkillLabels(locale);
  const groupActivationLabels = buildGroupActivationLabels(locale);
  const deliverableKindLabels = buildDeliverableKindLabels(locale);
  const deliverableSourceLabels = buildDeliverableSourceLabels(locale);
  const menu = t.menu;
  const platformAccounts = [
    {
      name: "Web",
      status: t.platformLive,
      detail: t.platformWebDetail,
      href: "#chat",
    },
    { name: "Telegram", status: t.platformRoadmap, detail: t.platformTelegramDetail },
    { name: "WhatsApp", status: t.platformRoadmap, detail: t.platformWhatsAppDetail },
    { name: locale === "zh" ? "飞书" : "Feishu", status: t.platformRoadmap, detail: t.platformFeishuDetail },
    { name: locale === "zh" ? "企业微信" : "WeCom", status: t.platformRoadmap, detail: t.platformWeComDetail },
  ];

  return (
    <main className="dashboard-shell representative-shell localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <header className="representative-topbar">
        <div className="dashboard-brand">
          <div className="dashboard-brand-mark">R</div>
          <div>
            <strong>{representative.name}</strong>
            <div className="muted">{t.brandTagline}</div>
          </div>
        </div>

        <nav aria-label={t.menuAriaLabel} className="representative-menu-tabs">
          {menu.map((item) => (
            <a className="dashboard-menu-tab" href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="dashboard-nav-links">
          <LanguageSwitcher
            activeLocale={locale}
            ariaLabel={t.languageAriaLabel}
            items={[
              {
                locale: "zh",
                href: buildLocalizedHref(`/reps/${representative.slug}`, "zh"),
                label: t.language.zh,
                shortLabel: "ZH",
              },
              {
                locale: "en",
                href: buildLocalizedHref(`/reps/${representative.slug}`, "en"),
                label: t.language.en,
                shortLabel: "EN",
              },
            ]}
          />
          <a className="dashboard-nav-link" href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}>
            {t.homeLabel}
          </a>
          <a
            className="dashboard-nav-link"
            href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?rep=${representative.slug}&view=overview`, locale)}
          >
            {t.dashboardLabel}
          </a>
        </div>
      </header>

      <section className="dashboard-stage representative-stage" id="overview">
        <div>
          <p className="eyebrow">{t.profileEyebrow}</p>
          <h1>{representative.name}</h1>
          <p className="dashboard-stage-copy">{representative.tagline}</p>
          <div className="chip-row">
            {representative.languages.map((language) => (
              <span className="chip" key={language}>
                {language}
              </span>
            ))}
            <span className="chip chip-safe">{groupActivationLabels[representative.groupActivation]}</span>
            <span className="chip">{representative.humanInLoop ? t.aiHumanLabel : t.aiOnlyLabel}</span>
          </div>
        </div>

        <div className="representative-stage-aside">
          <article className="dashboard-highlight-card dashboard-highlight-card-primary">
            <p className="panel-title">{t.worksForLabel}</p>
            <h3>{representative.ownerName}</h3>
            <p>{representative.knowledgePack.identitySummary}</p>
            <p className="footer-note">{t.memoryDisclosure}</p>
          </article>

          <div className="button-row representative-stage-links">
            <a className="button-primary" href="#chat">
              {t.startOnWeb}
            </a>
            <a
              className="button-secondary"
              href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?rep=${representative.slug}&view=setup`, locale)}
            >
              {t.viewControlPlane}
            </a>
          </div>
        </div>
      </section>

      <DashboardSignalStrip
        cards={[
          {
            label: t.signalCards.freeRepliesLabel,
            value: `${representative.contract.freeReplyLimit}`,
            detail: t.signalCards.freeRepliesDetail,
            tone: "accent",
          },
          {
            label: t.signalCards.enabledSkillsLabel,
            value: `${representative.skills.length}`,
            detail: t.signalCards.enabledSkillsDetail,
            tone: "safe",
          },
          {
            label: t.signalCards.knowledgeItemsLabel,
            value: `${totalKnowledgeItems}`,
            detail: t.signalCards.knowledgeItemsDetail,
          },
          {
            label: t.signalCards.skillPacksLabel,
            value: `${enabledSkillPacks.length}`,
            detail: t.signalCards.skillPacksDetail,
          },
        ]}
      />

      <DashboardPanelFrame
        eyebrow={t.frontDeskEyebrow}
        summary={t.frontDeskSummary(representative.name)}
        title={t.frontDeskTitle}
      >
        <div className="representative-front-desk-flow">
          {t.frontDeskSteps.map((step) => (
            <article className="representative-front-desk-step" key={step.label}>
              <span>{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </DashboardPanelFrame>

      <DashboardPanelFrame
        eyebrow={t.rechargeEyebrow}
        id="recharge"
        summary={t.rechargeSummary(representative.name)}
        title={t.rechargeTitle}
      >
        <DashboardSurfaceGrid columns={3}>
          <DashboardSurface eyebrow={t.agentWalletEyebrow} title={t.agentWalletTitle} tone="accent">
            <p className="section-copy">{t.agentWalletCopy(representative.name)}</p>
            <div className="chip-row">
              <span className="chip chip-safe">{t.agentWalletCurrentChip}</span>
              <span className="chip">{t.webFirstChip}</span>
              <span className="chip">{t.amnPayRoadmapChip}</span>
            </div>
            <p className="footer-note">{t.balanceDisclosure(representative.name)}</p>
            <RepresentativeRechargePanel locale={locale} representativeSlug={representative.slug} />
          </DashboardSurface>

          <DashboardSurface eyebrow={t.platformAccountsEyebrow} title={t.platformAccountsTitle}>
            <div className="row-list">
              {platformAccounts.map((account) => (
                <div className="skill-row" key={account.name}>
                  <div>
                    <strong>{account.name}</strong>
                    <p>{account.detail}</p>
                    <div className="chip-row">
                      <span className={account.href ? "chip chip-safe" : "chip"}>{account.status}</span>
                    </div>
                  </div>
                  {account.href ? (
                    <a
                      className="button-secondary"
                      href={account.href}
                      {...(account.href.startsWith("#") ? {} : { rel: "noreferrer", target: "_blank" })}
                    >
                      {t.openPlatform}
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.trustProofEyebrow} title={t.trustProofTitle}>
            <div className="representative-qr-placeholder" aria-label={t.qrAriaLabel}>
              <span>QR</span>
            </div>
            <p className="section-copy">{t.trustProofCopy}</p>
            <div className="chip-row">
              <span className="chip chip-safe">{t.ratingChip}</span>
              <span className="chip">{t.claimStatusChip}</span>
              <span className="chip">{t.publicSourcesChip}</span>
            </div>
            <p className="footer-note">{t.refundDisclosure}</p>
          </DashboardSurface>
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>

      <RepresentativeChatPanel
        freeReplyLimit={representative.contract.freeReplyLimit}
        identitySummary={representative.knowledgePack.identitySummary}
        locale={locale}
        pricing={representative.pricing}
        representativeName={representative.name}
        representativeSlug={representative.slug}
      />

      <DashboardPanelFrame
        eyebrow={t.trustEyebrow}
        id="trust"
        summary={t.trustSummary}
        title={t.trustTitle}
      >
        <DashboardSurfaceGrid columns={3}>
          <DashboardSurface eyebrow={t.allowedEyebrow} title={t.allowedTitle} tone="accent">
            <ul className="list">
              {t.allowList.map((item) => (
                <li className="list-item" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.notAllowedEyebrow} title={t.notAllowedTitle}>
            <ul className="list">
              {t.denyList.map((item) => (
                <li className="list-item" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.contractEyebrow} title={t.contractTitle}>
            <p className="section-copy">
              {t.contractCopy(representative.contract.freeReplyLimit)}
            </p>
            <div className="chip-row">
              <span className="chip chip-safe">{groupActivationLabels[representative.groupActivation]}</span>
              <span className="chip">{representative.publicMode ? t.publicRuntimeLabel : t.privateDraftLabel}</span>
              <span className="chip">{representative.humanInLoop ? t.handoffReadyLabel : t.aiOnlyLabel}</span>
            </div>
            <p className="footer-note">{t.contractFootnote}</p>
          </DashboardSurface>
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>

      <DashboardPanelFrame
        eyebrow={t.skillsEyebrow}
        id="skills"
        summary={t.skillsSummary}
        title={t.skillsTitle}
      >
        <DashboardSurfaceGrid>
          <DashboardSurface
            eyebrow={t.declaredSkillsEyebrow}
            meta={<span className="chip chip-safe">{t.skillsCountChip(representative.skills.length)}</span>}
            title={t.declaredSkillsTitle}
            tone="accent"
          >
            <div className="chip-row">
              {representative.skills.map((skill) => (
                <span className="chip" key={skill}>
                  {skillLabels[skill]}
                </span>
              ))}
            </div>
          </DashboardSurface>

          <DashboardSurface
            eyebrow={t.skillPacksEyebrow}
            meta={<span className="chip">{t.trackedChip(representative.skillPacks.length)}</span>}
            title={t.skillPacksTitle}
          >
            <div className="row-list">
              {representative.skillPacks.map((skillPack) => (
                <div className="skill-row" key={skillPack.id}>
                  <div>
                    <strong>{skillPack.displayName}</strong>
                    <p>{skillPack.summary}</p>
                    <div className="chip-row">
                      <span className="chip">
                        {skillPack.source === "clawhub" ? "ClawHub" : t.builtinLabel}
                      </span>
                      <span className="chip">{skillPack.installStatus}</span>
                      {skillPack.verificationTier ? (
                        <span className="chip chip-safe">{skillPack.verificationTier}</span>
                      ) : null}
                    </div>
                    <p className="footer-note">
                      {skillPack.executesCode ? t.executesCodeNote : t.declarativeNote}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </DashboardSurface>
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>

      <DashboardPanelFrame
        eyebrow={t.knowledgeEyebrow}
        id="knowledge"
        summary={t.knowledgeSummary}
        title={t.knowledgeTitle}
      >
        <DashboardSurfaceGrid columns={3}>
          <DashboardSurface eyebrow="FAQ" title={t.faqTitle} tone="accent">
            <ul className="list">
              {representative.knowledgePack.faq.map((item) => (
                <li className="list-item" key={item.id}>
                  <strong>{item.title}</strong>
                  <p>{item.summary}</p>
                </li>
              ))}
            </ul>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.materialsEyebrow} title={t.materialsTitle}>
            <ul className="list">
              {representative.knowledgePack.materials.map((item) => {
                const downloadUrl = getUsablePublicUrl(item.url);
                return (
                  <li className="list-item" key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.summary}</p>
                    <div className="button-row">
                      <RepresentativeMaterialPreview
                        copy={t.materialPreview}
                        downloadUrl={downloadUrl}
                        kind={item.kind}
                        summary={item.summary}
                        title={item.title}
                      />
                    </div>
                  </li>
                );
              })}
              {publicDeliverables.map((deliverable) => {
                const externalUrl = getUsablePublicUrl(deliverable.externalUrl);
                return (
                  <li className="list-item" key={deliverable.id}>
                    <strong>{deliverable.title}</strong>
                    <p>{deliverable.summary}</p>
                    <div className="chip-row">
                      <span className="chip chip-safe">{t.publicDeliverableChip}</span>
                      <span className="chip">{deliverableKindLabels[deliverable.kind]}</span>
                      <span className="chip">{deliverableSourceLabels[deliverable.sourceKind]}</span>
                    </div>
                    <div className="button-row">
                      {deliverable.sourceKind === "external_link" ? (
                        externalUrl ? (
                          <a
                            className="button-secondary"
                            href={externalUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {t.openMaterial}
                          </a>
                        ) : (
                          <span className="chip">{t.materialPendingChip}</span>
                        )
                      ) : (
                        <a
                          className="button-secondary"
                          href={`/reps/${representative.slug}/deliverables/${deliverable.id}/download`}
                        >
                          {t.downloadDeliverable}
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.policiesEyebrow} title={t.policiesTitle}>
            <ul className="list">
              {representative.knowledgePack.policies.map((item) => (
                <li className="list-item" key={item.id}>
                  <strong>{item.title}</strong>
                  <p>{item.summary}</p>
                </li>
              ))}
            </ul>
          </DashboardSurface>
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>

      <DashboardPanelFrame
        eyebrow={t.plansEyebrow}
        id="plans"
        summary={t.plansSummary}
        title={t.plansTitle}
      >
        <DashboardSurfaceGrid>
          {representative.pricing.map((plan) => (
            <DashboardSurface
              eyebrow={t.accessLayerEyebrow}
              key={plan.tier}
              meta={
                <span className={plan.includesPriorityHandoff ? "chip chip-safe" : "chip"}>
                  {plan.tier}
                </span>
              }
              title={plan.name}
              tone={plan.tier === "deep_help" ? "accent" : "default"}
            >
              <span className="price">{plan.stars} credits</span>
              <p>{plan.summary}</p>
              <div className="chip-row">
                <span className="chip">{t.repliesChip(plan.includedReplies)}</span>
                {plan.includesPriorityHandoff ? (
                  <span className="chip chip-safe">{t.priorityHandoffChip}</span>
                ) : null}
              </div>
              <div className="button-row">
                <a
                  className={plan.tier === "free" ? "button-secondary" : "button-primary"}
                  href={plan.tier === "free" ? "#chat" : "#recharge"}
                >
                  {plan.tier === "free" ? t.startWebChat : t.previewRecharge}
                </a>
              </div>
            </DashboardSurface>
          ))}
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>

      <DashboardPanelFrame
        eyebrow={t.handoffEyebrow}
        id="handoff"
        summary={t.handoffSummary}
        title={t.handoffTitle}
      >
        <DashboardSurfaceGrid>
          <DashboardSurface eyebrow={t.handoffCopyEyebrow} title={t.handoffCopyTitle} tone="accent">
            <p>{representative.handoffPrompt}</p>
          </DashboardSurface>

          <DashboardSurface eyebrow={t.entryPointsEyebrow} title={t.entryPointsTitle}>
            <p className="section-copy">
              {t.entryPointsCopy(groupActivationLabels[representative.groupActivation])}
            </p>
            <div className="button-row">
              <a className="button-primary" href="#chat">
                {t.openRepresentative}
              </a>
              <a
                className="button-secondary"
                href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?rep=${representative.slug}&view=memory`, locale)}
              >
                {t.inspectMemoryPolicy}
              </a>
            </div>
          </DashboardSurface>
        </DashboardSurfaceGrid>
      </DashboardPanelFrame>
    </main>
  );
}

function buildSkillLabels(locale: Locale): Record<RepresentativeSkill, string> {
  if (locale === "zh") {
    return {
      faq_reply: "FAQ 回复",
      lead_qualify: "合作意向初筛",
      intake_collect: "需求采集",
      quote_request_collect: "报价请求采集",
      material_delivery: "资料投递",
      scheduling_request: "预约意向采集",
      human_handoff: "人工转接",
      paid_unlock: "付费续用",
    };
  }

  return {
    faq_reply: "FAQ replies",
    lead_qualify: "Lead qualification",
    intake_collect: "Intake collection",
    quote_request_collect: "Quote request intake",
    material_delivery: "Material delivery",
    scheduling_request: "Scheduling intake",
    human_handoff: "Human handoff",
    paid_unlock: "Paid continuation",
  };
}

function buildGroupActivationLabels(locale: Locale) {
  return locale === "zh"
    ? {
        mention_only: "仅 mention",
        reply_or_mention: "reply 或 mention",
        always: "始终响应",
      }
    : {
        mention_only: "mention only",
        reply_or_mention: "reply or mention",
        always: "always on",
      };
}

function buildDeliverableKindLabels(locale: Locale) {
  return locale === "zh"
    ? {
        deck: "介绍材料",
        case_study: "案例",
        download: "下载项",
        generated_document: "生成文档",
        package: "资料包",
      }
    : {
        deck: "Deck",
        case_study: "Case study",
        download: "Download",
        generated_document: "Generated doc",
        package: "Package",
      };
}

function buildDeliverableSourceLabels(locale: Locale) {
  return locale === "zh"
    ? {
        artifact: "运行产物",
        external_link: "外部链接",
        bundle: "打包下载",
      }
    : {
        artifact: "Artifact-backed",
        external_link: "External link",
        bundle: "Bundled",
      };
}

const copy = {
  zh: {
    brandTagline: "Web-first 公开代表档案",
    menuAriaLabel: "代表页分区",
    languageAriaLabel: "语言切换",
    language: { zh: "中文", en: "English" },
    menu: [
      { href: "#overview", label: "概览" },
      { href: "#recharge", label: "充值" },
      { href: "#chat", label: "对话" },
      { href: "#trust", label: "边界" },
      { href: "#skills", label: "技能" },
      { href: "#knowledge", label: "知识" },
      { href: "#plans", label: "方案" },
      { href: "#handoff", label: "转接" },
    ],
    homeLabel: "官网",
    dashboardLabel: "Dashboard",
    profileEyebrow: "Representative Profile",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    worksForLabel: "Who this representative works for",
    memoryDisclosure:
      "这个代表只会记住属于本代表范围内的公开安全互动，不会读取主人的私有工作区、私有文件或私有账号。",
    startOnWeb: "在网页中开始",
    viewControlPlane: "查看控制台",
    frontDeskEyebrow: "AI 接待前台",
    frontDeskTitle: "先接住高频、标准化、可定价的对话",
    frontDeskSummary: (name: string) =>
      `${name} 不替代 owner 本人，而是先把能回答、该收费、要请示、需转接的请求分流清楚。`,
    frontDeskSteps: [
      { label: "Answer", title: "能回答的先回答", body: "公开 FAQ、资料和服务边界先由代表说明，减少重复解释。" },
      { label: "Charge", title: "该收费的先收费", body: "深度服务和优先响应会进入网页服务档位、充值预览和付款记录。" },
      { label: "Ask", title: "需要拍板的先请示", body: "敏感动作和高价值判断会进入 approval 或 owner inbox，而不是自动越权。" },
      { label: "Handoff", title: "需要人时再转接", body: "真正需要 owner 的请求会带着上下文进入人工转接流程。" },
    ],
    rechargeEyebrow: "代表余额",
    rechargeTitle: "这是给当前数字代表充值和继续服务的入口",
    rechargeSummary: (name: string) =>
      `${name} 的余额、服务档位和平台入口应该在同一个公开页面里被看清楚。`,
    agentWalletEyebrow: "Recharge scope",
    agentWalletTitle: "余额只给这个代表用，不是平台通用钱包",
    agentWalletCopy: (name: string) =>
      `当前 ${name} 已经可以在网页里创建演示充值单、模拟支付成功，并把余额记到当前访问者身份上。真实收款上线前，还需要接入 Stripe、微信或支付宝。`,
    agentWalletCurrentChip: "当前：演示充值",
    webFirstChip: "网页优先",
    amnPayRoadmapChip: "正式支付待接入",
    balanceDisclosure: (name: string) =>
      `充值或购买的服务余额仅用于 ${name} 这个数字代表的服务，不代表进入 owner 私人工作区，也不会自动授权其它 Agent。`,
    rechargeCta: "立即充值 / 继续服务",
    platformAccountsEyebrow: "Platform accounts",
    platformAccountsTitle: "跨平台入口汇聚",
    platformLive: "已接入",
    platformSetupNeeded: "待配置",
    platformRoadmap: "roadmap",
    platformWebDetail: "第一版主入口。用户先在网页代表页完成理解、试聊、服务档位预览和转接。",
    platformTelegramDetail: "后续消息入口。若未来提供 Telegram 内数字服务，会遵循 Telegram Stars 规则。",
    platformWhatsAppDetail: "未来可作为消息入口，把用户带回同一个网页充值和服务入口。",
    platformFeishuDetail: "未来可作为企业协作入口，余额与计费仍归属当前 Agent。",
    platformWeComDetail: "未来可作为企业微信入口，余额仍只归属当前代表。",
    openPlatform: "打开",
    trustProofEyebrow: "Proof + QR",
    trustProofTitle: "评分、来源和二维码占位",
    trustProofCopy:
      "这里预留公开评分、充值二维码和来源证明位置。未认领代表必须明确标注来源和授权状态，不能让用户误以为已获得本人官方授权。",
    qrAriaLabel: "充值二维码占位",
    ratingChip: "历史评分 4.8/5 demo",
    claimStatusChip: "claimed demo",
    publicSourcesChip: "公开来源",
    refundDisclosure:
      "数字服务充值通常用于当前代表的持续服务，原则上不作为一次性礼物处理；具体退款规则以后应在正式支付页面清楚展示。",
    signalCards: {
      freeRepliesLabel: "免费回复",
      freeRepliesDetail: "首次接触阶段能被代表独立接住的免费深度。",
      enabledSkillsLabel: "已启用技能",
      enabledSkillsDetail: "当前公开声明并可被用户理解的能力条数。",
      knowledgeItemsLabel: "知识条目",
      knowledgeItemsDetail: "FAQ、资料和政策构成的公开知识包。",
      skillPacksLabel: "技能包",
      skillPacksDetail: "已启用且进入代表运行时的 skill pack 数量。",
    },
    trustEyebrow: "Trust Interface",
    trustSummary: "公开能力、拒绝范围、升级路径和计费方式都不应该藏在对话里。",
    trustTitle: "用户一进来就该先看到边界和契约",
    allowedEyebrow: "Allowed",
    allowedTitle: "代表会做什么",
    allowList: ["回答 FAQ", "收集合作/报价/预约信息", "发公开资料", "发起人工转接", "提示网页服务升级"],
    notAllowedEyebrow: "Not allowed",
    notAllowedTitle: "代表明确不会做什么",
    denyList: ["访问私有文件系统", "读取主人的私有记忆", "代主人登录账户", "擅自修改真实日程", "做不可逆商业承诺"],
    contractEyebrow: "Conversation contract",
    contractTitle: "免费、升级和转接规则",
    contractCopy: (limit: number) => `免费规则：前 ${limit} 条回复适合基础问答与资料领取；更深的合作判断、报价采集和预约意向会引导到付费续用或人工转接。`,
    publicRuntimeLabel: "公开运行中",
    privateDraftLabel: "草稿未公开",
    handoffReadyLabel: "handoff ready",
    contractFootnote: "记忆边界：只会记住这个代表范围内的公开安全互动，不会读取主人的私有工作区、私有文件或私有账号。",
    skillsEyebrow: "Skill Sources",
    skillsSummary: "这里把内置能力和外部技能包分开展示：可以扩展能力，但不能扩大权限。",
    skillsTitle: "技能包可以有来源，但不能有越权",
    declaredSkillsEyebrow: "Declared skills",
    skillsCountChip: (count: number) => `${count} skills`,
    declaredSkillsTitle: "公开代表会如何接住外部请求",
    skillPacksEyebrow: "Skill packs",
    trackedChip: (count: number) => `${count} tracked`,
    skillPacksTitle: "已安装来源与能力标签",
    builtinLabel: "Built-in",
    executesCodeNote: "这个技能包会执行代码，上线前需要额外审核。",
    declarativeNote: "这个技能包目前只作为能力说明，不会自动获得额外权限。",
    knowledgeEyebrow: "Knowledge Pack",
    knowledgeSummary: "代表先从结构化知识里拿答案，再决定下一步是继续回答、收集 intake 还是升级转接。",
    knowledgeTitle: "公开知识包先于自由发挥",
    faqTitle: "高频标准答案",
    materialsEyebrow: "Materials",
    materialsTitle: "可直接投递的公开材料",
    openMaterial: "打开资料",
    materialPreview: {
      close: "关闭",
      download: "下载原文",
      noDownload: "暂无公开下载",
      open: "打开资料",
      summaryLabel: "公开摘要",
    },
    downloadDeliverable: "下载交付件",
    materialPending: "资料已登记，但还没有可公开打开的文件链接。",
    materialPendingChip: "资料待发布",
    publicDeliverableChip: "公开交付件",
    policiesEyebrow: "Policies",
    policiesTitle: "合作边界与响应规则",
    plansEyebrow: "Plans",
    plansSummary: "用户不该理解原始模型成本，只需要理解还能继续聊多深、能做哪些动作。",
    plansTitle: "四档访问深度，而不是 token 定价",
    accessLayerEyebrow: "服务深度",
    repliesChip: (count: number) => `${count} replies`,
    priorityHandoffChip: "priority handoff",
    startWebChat: "开始网页试聊",
    previewRecharge: "查看充值预览",
    handoffEyebrow: "Human Handoff",
    handoffSummary: "当公开代表接近边界时，转接不该是一句拒答，而应该是一条明确可预期的升级路径。",
    handoffTitle: "主人最终接手的是高价值收件项，不是原始噪音",
    handoffCopyEyebrow: "Handoff copy",
    handoffCopyTitle: "对外升级说明",
    entryPointsEyebrow: "Entry points",
    entryPointsTitle: "继续对话的公开入口",
    entryPointsCopy: (strategy: string) => `第一版入口是网页代表页。Telegram、群组和其它消息平台后续接入时，也会沿用 ${strategy} 这类保守激活策略。`,
    openRepresentative: "回到网页对话",
    inspectMemoryPolicy: "查看记忆策略",
  },
  en: {
    brandTagline: "Web-first public representative profile",
    menuAriaLabel: "Representative sections",
    languageAriaLabel: "Language switcher",
    language: { zh: "Chinese", en: "English" },
    menu: [
      { href: "#overview", label: "Overview" },
      { href: "#recharge", label: "Recharge" },
      { href: "#chat", label: "Chat" },
      { href: "#trust", label: "Trust" },
      { href: "#skills", label: "Skills" },
      { href: "#knowledge", label: "Knowledge" },
      { href: "#plans", label: "Plans" },
      { href: "#handoff", label: "Handoff" },
    ],
    homeLabel: "Home",
    dashboardLabel: "Dashboard",
    profileEyebrow: "Representative Profile",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    worksForLabel: "Who this representative works for",
    memoryDisclosure:
      "This representative may remember prior public, safe interactions within this representative only. It does not access the owner's private workspace, private files, or private accounts.",
    startOnWeb: "Start on web",
    viewControlPlane: "View control plane",
    frontDeskEyebrow: "AI front desk",
    frontDeskTitle: "Catch high-frequency, standardized, priceable conversations first",
    frontDeskSummary: (name: string) =>
      `${name} does not replace the owner. It separates what can be answered, what should be paid, what needs approval, and what deserves human handoff.`,
    frontDeskSteps: [
      { label: "Answer", title: "Answer what it can", body: "Public FAQs, materials, and service boundaries are explained before the owner repeats themselves." },
      { label: "Charge", title: "Charge when needed", body: "Deeper service and priority move into web service tiers, recharge preview, and payment records." },
      { label: "Ask", title: "Ask for approval", body: "Sensitive actions and high-value judgment go through approval or owner inbox instead of silent overreach." },
      { label: "Handoff", title: "Hand off with context", body: "Requests that truly need the owner arrive with context through the human handoff flow." },
    ],
    rechargeEyebrow: "Representative balance",
    rechargeTitle: "This is the recharge and continuation entry for this Digital Representative",
    rechargeSummary: (name: string) =>
      `${name}'s balance scope, service tiers, and platform entry points should be visible on one public page.`,
    agentWalletEyebrow: "Recharge scope",
    agentWalletTitle: "Balance belongs to this Agent, not a generic platform pool",
    agentWalletCopy: (name: string) =>
      `${name} can now create a demo recharge order, simulate payment success, and attach the balance to the current visitor identity. Live collection still needs Stripe, WeChat, or Alipay integration before real charging.`,
    agentWalletCurrentChip: "Today: demo recharge",
    webFirstChip: "Web first",
    amnPayRoadmapChip: "Live payments pending",
    balanceDisclosure: (name: string) =>
      `Recharge or purchase value is scoped to ${name}'s Digital Representative service. It does not grant private workspace access and does not automatically authorize other Agents.`,
    rechargeCta: "Recharge / continue service",
    platformAccountsEyebrow: "Platform accounts",
    platformAccountsTitle: "Cross-platform entry points",
    platformLive: "live",
    platformSetupNeeded: "setup needed",
    platformRoadmap: "roadmap",
    platformWebDetail: "First-version primary entry for understanding, trial chat, service preview, and handoff.",
    platformTelegramDetail: "Future message entry. If Telegram digital services ship later, they should follow Telegram Stars rules.",
    platformWhatsAppDetail: "Future message entry that can bring users back to the same web recharge and service page.",
    platformFeishuDetail: "Future collaboration entry where balance and billing still belong to this Agent.",
    platformWeComDetail: "Future WeCom entry where balance still belongs to this representative.",
    openPlatform: "Open",
    trustProofEyebrow: "Proof + QR",
    trustProofTitle: "Rating, source, and QR placeholder",
    trustProofCopy:
      "This reserves space for public rating, recharge QR, and source proof. Unclaimed representatives must disclose source and authorization state clearly so users do not assume official endorsement.",
    qrAriaLabel: "Recharge QR placeholder",
    ratingChip: "4.8/5 demo rating",
    claimStatusChip: "claimed demo",
    publicSourcesChip: "public sources",
    refundDisclosure:
      "Digital service recharge is generally scoped to ongoing service from this representative, not treated as a one-time gift. Formal refund rules should be shown clearly on the future payment page.",
    signalCards: {
      freeRepliesLabel: "Free replies",
      freeRepliesDetail: "The free depth this representative can absorb in first-contact mode.",
      enabledSkillsLabel: "Enabled skills",
      enabledSkillsDetail: "Publicly declared abilities users should expect and understand.",
      knowledgeItemsLabel: "Knowledge items",
      knowledgeItemsDetail: "The public knowledge pack formed by FAQs, materials, and policies.",
      skillPacksLabel: "Skill packs",
      skillPacksDetail: "Enabled packs that are available to this representative.",
    },
    trustEyebrow: "Trust Interface",
    trustSummary: "Capabilities, refusals, escalation, and pricing should be visible before the conversation goes deep.",
    trustTitle: "People should see the contract before they see the magic",
    allowedEyebrow: "Allowed",
    allowedTitle: "What this representative will do",
    allowList: ["Answer FAQs", "Collect collaboration, quote, and scheduling details", "Deliver public materials", "Create safe handoff requests", "Offer web service upgrades"],
    notAllowedEyebrow: "Not allowed",
    notAllowedTitle: "What this representative will not do",
    denyList: ["Access private file systems", "Read the owner's private memory", "Log into owner accounts", "Change the real calendar directly", "Make irreversible commercial commitments"],
    contractEyebrow: "Conversation contract",
    contractTitle: "Free scope, upgrade rules, and handoff policy",
    contractCopy: (limit: number) => `The first ${limit} replies are optimized for foundational questions and materials. Deeper collaboration judgment, quote intake, and scheduling move into paid continuation or human handoff.`,
    publicRuntimeLabel: "publicly active",
    privateDraftLabel: "draft only",
    handoffReadyLabel: "handoff ready",
    contractFootnote: "Memory boundary: this representative only keeps public, safe interaction context inside this representative. It does not read the owner's private workspace, files, or accounts.",
    skillsEyebrow: "Skill Sources",
    skillsSummary: "Delegate separates built-in abilities from external skill packs, while keeping permission boundaries explicit.",
    skillsTitle: "Skill packs can have sources, but they cannot have authority",
    declaredSkillsEyebrow: "Declared skills",
    skillsCountChip: (count: number) => `${count} skills`,
    declaredSkillsTitle: "How this representative handles external requests",
    skillPacksEyebrow: "Skill packs",
    trackedChip: (count: number) => `${count} tracked`,
    skillPacksTitle: "Installed sources and capability tags",
    builtinLabel: "Built-in",
    executesCodeNote: "This pack executes code and would require extra review.",
    declarativeNote: "This pack currently describes capabilities only and does not receive extra permissions automatically.",
    knowledgeEyebrow: "Knowledge Pack",
    knowledgeSummary: "The representative should answer from structured knowledge first, then decide whether to continue, collect intake, or escalate.",
    knowledgeTitle: "Structured public knowledge comes before improvisation",
    faqTitle: "High-frequency answers",
    materialsEyebrow: "Materials",
    materialsTitle: "Public materials that can be delivered directly",
    openMaterial: "Open material",
    materialPreview: {
      close: "Close",
      download: "Download original",
      noDownload: "No public download yet",
      open: "Open material",
      summaryLabel: "Public summary",
    },
    downloadDeliverable: "Download deliverable",
    materialPending: "This material is registered, but there is no public file link yet.",
    materialPendingChip: "Pending public file",
    publicDeliverableChip: "Public deliverable",
    policiesEyebrow: "Policies",
    policiesTitle: "Boundary and response rules",
    plansEyebrow: "Plans",
    plansSummary: "Users should understand how deep they can go and what actions unlock next, not the raw model cost underneath.",
    plansTitle: "Four service depths instead of token pricing",
    accessLayerEyebrow: "Service depth",
    repliesChip: (count: number) => `${count} replies`,
    priorityHandoffChip: "priority handoff",
    startWebChat: "Start web chat",
    previewRecharge: "Preview recharge",
    handoffEyebrow: "Human Handoff",
    handoffSummary: "When the public representative reaches its boundary, escalation should feel like a predictable workflow instead of a vague refusal.",
    handoffTitle: "The owner should receive high-value inbox items, not raw noise",
    handoffCopyEyebrow: "Handoff copy",
    handoffCopyTitle: "Public escalation copy",
    entryPointsEyebrow: "Entry points",
    entryPointsTitle: "Public paths to continue the conversation",
    entryPointsCopy: (strategy: string) => `The first-version entry point is the web representative page. Telegram, groups, and other message platforms can later reuse conservative activation policies such as ${strategy}.`,
    openRepresentative: "Return to web chat",
    inspectMemoryPolicy: "Inspect memory policy",
  },
} as const;
