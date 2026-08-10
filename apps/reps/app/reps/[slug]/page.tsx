import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import type { Representative } from "@delegate/domain";
import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  getRepresentativePublicDeliverables,
  getPublicRepresentativeRuntime,
  readAccountSessionMode,
  readDelegateAuthSessionSecret,
  resolveWeChatPayReleaseFlags,
  resolvePublicAudiencePrincipal,
  verifyDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
} from "@delegate/web-data";
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

import { RepresentativeChatPanel } from "./representative-chat-panel";
import { RepresentativeIdentityBindingPanel } from "./representative-identity-binding-panel";
import { RepresentativeMemorySharingPanel } from "./representative-memory-sharing-panel";
import { getUsablePublicUrl } from "./public-materials";
import { RepresentativeMaterialPreview } from "./representative-material-preview";
import { RepresentativeRechargePanel } from "./representative-recharge-panel";
import {
  buildPublicAudienceLoginHref,
  buildPublicAudienceLogoutHref,
} from "./public-auth";
import { getGovernedContextDisclosure } from "./governed-context-disclosure";

type RepresentativeSkill = Representative["skills"][number];

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") {
    return {
      title: "Representative unavailable · Delegate",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${runtime.setup.name} · Delegate`,
    description: runtime.setup.tagline,
    openGraph: {
      title: runtime.setup.name,
      description: runtime.setup.tagline,
      type: "profile",
    },
  };
}

export default async function RepresentativePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lang?: string; source?: string }>;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : undefined;
  const telegramRechargeSource = query?.source === "telegram";
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
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
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status === "paused") {
    return <PausedRepresentativePage locale={locale} siteBaseUrl={siteBaseUrl} />;
  }
  if (runtime.status !== "available") {
    notFound();
  }

  const deliverableSnapshot = await getRepresentativePublicDeliverables(slug);

  const representative = runtime.setup;
  const governedContextDisclosure = getGovernedContextDisclosure(
    locale,
    runtime.governedMemoryDisclosure,
  );
  const legacyAuthorityEnabled = usesLegacyAccountSessionAuthority(
    readAccountSessionMode(),
  );
  const authSession = legacyAuthorityEnabled
    ? verifyDelegateAuthSession(
        cookieStore.get(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE)?.value ??
          cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value,
        readDelegateAuthSessionSecret(),
      )
    : null;
  let audienceSession =
    authSession?.actor === "audience"
    && authSession.audienceIdentityId
    && authSession.audienceId
      ? authSession
      : null;
  if (audienceSession) {
    const audienceId = audienceSession.audienceId;
    if (!audienceId) {
      audienceSession = null;
    } else {
      try {
        await resolvePublicAudiencePrincipal({
          audienceId,
          verifiedAuthSession: audienceSession,
        });
      } catch {
        audienceSession = null;
      }
    }
  }
  const audienceLoginHref = buildPublicAudienceLoginHref(
    representative.slug,
    locale,
    telegramRechargeSource ? "telegram-recharge" : "chat",
  );
  const audienceLogoutHref = buildPublicAudienceLogoutHref(representative.slug, locale);
  const publicDeliverables = deliverableSnapshot?.deliverables ?? [];
  const publicResourceCount =
    representative.knowledgePack.faq.length +
    representative.knowledgePack.materials.length +
    representative.knowledgePack.policies.length +
    publicDeliverables.length;
  const visitorCapabilities = buildVisitorCapabilities(locale);
  const deliverableKindLabels = buildDeliverableKindLabels(locale);
  const deliverableSourceLabels = buildDeliverableSourceLabels(locale);
  const showPublicDemoTools =
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS === "true";
  let weChatPayReleaseFlags:
    | ReturnType<typeof resolveWeChatPayReleaseFlags>
    | null = null;
  try {
    weChatPayReleaseFlags = resolveWeChatPayReleaseFlags();
  } catch {
    // Runtime readiness exposes the operator-facing configuration failure.
    // The public page fails closed instead of falling back to demo payments.
  }
  const weChatPayProcessingEnabled =
    weChatPayReleaseFlags?.processingEnabled === true;
  const showPublicPayment =
    weChatPayProcessingEnabled
    || (weChatPayReleaseFlags !== null && showPublicDemoTools);
  const paymentMode: "mock" | "wechat" =
    weChatPayProcessingEnabled ? "wechat" : "mock";
  const collectionEnabled =
    paymentMode === "mock"
      ? true
      : weChatPayReleaseFlags?.collectionEnabled === true;
  const menu = [
    { href: "#chat", label: t.chatNav },
    ...(showPublicPayment
      ? [{ href: "#recharge", label: t.rechargeNav }]
      : []),
    { href: "#about", label: t.aboutNav },
    ...(publicResourceCount > 0 ? [{ href: "#resources", label: t.resourcesNav }] : []),
    { href: "#trust", label: t.trustNav },
  ];

  return (
    <main className="marketing-shell representative-shell localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <HashScrollRestorer />
      <header className="marketing-topbar representative-topbar">
        <div className="marketing-brand">
          <img className="marketing-brand-mark" src="/D_logo.svg" alt="Delegate logo" />
          <div>
            <strong>{representative.name}</strong>
            <div className="muted">{t.representing(representative.ownerName)}</div>
          </div>
        </div>

        <nav aria-label={t.menuAriaLabel} className="marketing-menu-tabs representative-menu-tabs">
          {menu.map((item) => (
            <a className="marketing-menu-tab" href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="marketing-nav-actions">
          <LanguageSwitcher
            activeLocale={locale}
            ariaLabel={t.languageAriaLabel}
            items={[
              {
                locale: "zh",
                href: buildLocalizedHref(
                  telegramRechargeSource
                    ? `/reps/${representative.slug}?source=telegram#recharge`
                    : `/reps/${representative.slug}`,
                  "zh",
                ),
                label: t.language.zh,
                shortLabel: "ZH",
              },
              {
                locale: "en",
                href: buildLocalizedHref(
                  telegramRechargeSource
                    ? `/reps/${representative.slug}?source=telegram#recharge`
                    : `/reps/${representative.slug}`,
                  "en",
                ),
                label: t.language.en,
                shortLabel: "EN",
              },
            ]}
          />
          <a className="marketing-nav-link representative-site-link" href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}>
            {t.homeLabel}
          </a>
          {audienceSession ? (
            <>
              <span className="marketing-nav-link dashboard-nav-link-status">
                {t.signedInLabel}
              </span>
              <a className="marketing-nav-link" href={audienceLogoutHref}>
                {t.logoutLabel}
              </a>
            </>
          ) : (
            <a className="marketing-button-primary dashboard-account-login" href={audienceLoginHref}>
              {t.loginRegisterLabel}
            </a>
          )}
        </div>
      </header>

      <section className="representative-visitor-hero" id="overview">
        <div className="representative-visitor-identity">
          <div aria-hidden="true" className="representative-visitor-avatar">
            {representative.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="representative-visitor-copy">
            <p className="eyebrow">{t.publicRepresentative}</p>
            <h1>{representative.name}</h1>
            <p className="representative-owner-line">{t.representing(representative.ownerName)}</p>
            <p className="marketing-lead">{representative.tagline}</p>
            <div className="chip-row">
              <span className="chip chip-safe">{t.aiDisclosure}</span>
              {representative.humanInLoop ? <span className="chip">{t.humanAvailable}</span> : null}
              {representative.languages.map((language) => <span className="chip" key={language}>{language}</span>)}
            </div>
          </div>
        </div>
        <div className="representative-visitor-start">
          <span className="panel-title">{t.startEyebrow}</span>
          <h2>{t.startTitle}</h2>
          <p>{t.startSummary(representative.name, runtime.governedContextEnabled)}</p>
          <a className="button-primary" href="#chat">{t.startChat}</a>
        </div>
      </section>

      <RepresentativeChatPanel
        computeEnabled={representative.compute.enabled}
        freeReplyLimit={representative.contract.freeReplyLimit}
        governedMemoryDisclosure={runtime.governedMemoryDisclosure}
        humanInLoop={representative.humanInLoop}
        locale={locale}
        ownerName={representative.ownerName}
        pricing={representative.pricing}
        representativeName={representative.name}
        representativeSlug={representative.slug}
        serviceCreditPaymentMode={paymentMode}
        serviceCreditPurchaseEnabled={showPublicPayment && collectionEnabled}
      />

      {audienceSession ? (
        <section className="representative-visitor-section" id="identity-bindings">
          <div className="representative-visitor-section-heading">
            <p className="eyebrow">{locale === "zh" ? "跨渠道身份" : "CROSS-CHANNEL IDENTITY"}</p>
            <h2>{locale === "zh" ? "绑定你的私聊账户" : "Link your private-channel accounts"}</h2>
            <p>
              {locale === "zh"
                ? "绑定后，当前已开放的私聊渠道会对应到同一个 Delegate 用户与服务权益；各渠道的原始会话记录仍然分开。"
                : "Once linked, the available private-chat channels resolve to the same Delegate user and service entitlements while each channel keeps its own conversation timeline."}
            </p>
          </div>
          <RepresentativeIdentityBindingPanel
            locale={locale}
            representativeSlug={representative.slug}
          />
          <RepresentativeMemorySharingPanel
            locale={locale}
            representativeSlug={representative.slug}
          />
        </section>
      ) : null}

      <section className="representative-visitor-section" id="about">
        <div className="representative-visitor-section-heading">
          <p className="eyebrow">{t.capabilitiesEyebrow}</p>
          <h2>{t.capabilitiesTitle}</h2>
          <p>{t.capabilitiesSummary(representative.ownerName)}</p>
        </div>
        <div className="representative-capability-grid">
          {representative.skills.filter((skill) => !["human_handoff", "paid_unlock"].includes(skill)).map((skill) => (
            <article className="representative-capability-card" key={skill}>
              <strong>{visitorCapabilities[skill].title}</strong>
              <p>{visitorCapabilities[skill].detail}</p>
            </article>
          ))}
        </div>
      </section>

      {publicResourceCount > 0 ? (
        <section className="representative-visitor-section" id="resources">
          <div className="representative-visitor-section-heading">
            <p className="eyebrow">{t.resourcesEyebrow}</p>
            <h2>{t.resourcesTitle}</h2>
            <p>{t.resourcesSummary}</p>
          </div>
          <div className="representative-resource-grid">
            {representative.knowledgePack.faq.map((item) => (
              <article className="representative-resource-card" key={item.id}>
                <span className="panel-title">FAQ</span><strong>{item.title}</strong><p>{item.summary}</p>
              </article>
            ))}
            {representative.knowledgePack.materials.map((item) => (
              <article className="representative-resource-card" key={item.id}>
                <span className="panel-title">{t.materialsEyebrow}</span><strong>{item.title}</strong><p>{item.summary}</p>
                <RepresentativeMaterialPreview copy={t.materialPreview} downloadUrl={getUsablePublicUrl(item.url)} kind={item.kind} summary={item.summary} title={item.title} />
              </article>
            ))}
            {representative.knowledgePack.policies.map((item) => (
              <article className="representative-resource-card" key={item.id}>
                <span className="panel-title">{t.policiesEyebrow}</span><strong>{item.title}</strong><p>{item.summary}</p>
              </article>
            ))}
            {publicDeliverables.map((deliverable) => {
              const externalUrl = getUsablePublicUrl(deliverable.externalUrl);
              return (
                <article className="representative-resource-card" key={deliverable.id}>
                  <span className="panel-title">{t.publicDeliverableChip}</span>
                  <strong>{deliverable.title}</strong><p>{deliverable.summary}</p>
                  <div className="chip-row"><span className="chip">{deliverableKindLabels[deliverable.kind]}</span><span className="chip">{deliverableSourceLabels[deliverable.sourceKind]}</span></div>
                  {deliverable.sourceKind === "external_link" ? (
                    externalUrl ? <a className="button-secondary" href={externalUrl} rel="noreferrer" target="_blank">{t.openMaterial}</a> : <span className="chip">{t.materialPendingChip}</span>
                  ) : <a className="button-secondary" href={`/reps/${representative.slug}/deliverables/${deliverable.id}/download`}>{t.downloadDeliverable}</a>}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {showPublicPayment ? (
        <section className="representative-visitor-section representative-demo-commerce" id="recharge">
          <div className="representative-visitor-section-heading">
            <p className="eyebrow">
              {paymentMode === "wechat"
                ? t.rechargeEyebrow
                : t.demoEyebrow}
            </p>
            <h2>
              {paymentMode === "wechat"
                ? t.rechargeTitle
                : t.demoTitle}
            </h2>
            <p>
              {paymentMode === "wechat"
                ? t.rechargeSummary(representative.name)
                : t.demoSummary}
            </p>
          </div>
          <RepresentativeRechargePanel
            audienceAuthenticated={Boolean(audienceSession)}
            collectionEnabled={collectionEnabled}
            {...(telegramRechargeSource
              ? { continuationChannel: "telegram" as const }
              : {})}
            locale={locale}
            loginHref={audienceLoginHref}
            paymentMode={paymentMode}
            representativeSlug={representative.slug}
          />
        </section>
      ) : null}

      <section className="representative-trust-section" id="trust">
        <article className="representative-trust-primary">
          <p className="eyebrow">{t.trustEyebrow}</p>
          <h2>{t.trustTitle}</h2>
          <div className="representative-trust-list">
            {t.trustItems(runtime.governedContextEnabled).map((item) => <p key={item}>{item}</p>)}
            <p>{governedContextDisclosure}</p>
          </div>
        </article>
        <article className="representative-handoff-card" id="handoff">
          <p className="eyebrow">{t.handoffEyebrow}</p>
          <h2>{t.handoffVisitorTitle(representative.ownerName)}</h2>
          <p>{representative.handoffPrompt}</p>
          <a className="button-primary" href="#chat">{t.addHandoffContext}</a>
        </article>
      </section>

      <footer className="representative-visitor-footer">
        <span>{t.footerDisclosure(representative.name)}</span>
        <a href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}>Delegate</a>
      </footer>
    </main>
  );
}

function PausedRepresentativePage({ locale, siteBaseUrl }: { locale: Locale; siteBaseUrl: string }) {
  const zh = locale === "zh";
  return (
    <main className="marketing-shell representative-shell localized-shell" data-locale={locale} lang={zh ? "zh-CN" : "en"}>
      <header className="marketing-topbar representative-topbar">
        <div className="marketing-brand"><img className="marketing-brand-mark" src="/D_logo.svg" alt="Delegate logo" /><div><strong>Delegate</strong><div className="muted">Digital Representative OS</div></div></div>
        <a className="marketing-button-secondary" href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}>{zh ? "返回官网" : "Back to Delegate"}</a>
      </header>
      <section className="marketing-hero representative-stage representative-paused-stage">
        <div className="marketing-hero-copy representative-hero-copy">
          <p className="eyebrow">TEMPORARILY PAUSED</p>
          <h1>{zh ? "这位数字代表暂时离线。" : "This representative is temporarily offline."}</h1>
          <p className="marketing-lead">{zh ? "公开页面、聊天和服务接口已同步暂停。请稍后再来，或通过其他已公开渠道联系主理人。" : "The public page, chat, and service APIs are paused together. Please return later or use another published contact channel."}</p>
        </div>
      </section>
    </main>
  );
}

function buildVisitorCapabilities(
  locale: Locale,
): Record<RepresentativeSkill, { title: string; detail: string }> {
  if (locale === "zh") {
    return {
      faq_reply: { title: "回答常见问题", detail: "根据已发布资料解释产品、服务和合作方式。" },
      lead_qualify: { title: "了解合作是否合适", detail: "通过几个关键问题，帮你判断下一步该怎么走。" },
      intake_collect: { title: "整理你的需求", detail: "收集目标、背景和限制，形成清晰的沟通摘要。" },
      quote_request_collect: { title: "准备报价信息", detail: "先补齐范围、预算和时间要求，再交给真人确认。" },
      material_delivery: { title: "查找公开资料", detail: "提供与你的问题相关的公开文档和可下载内容。" },
      scheduling_request: { title: "提交预约意向", detail: "记录希望沟通的主题和时间，不擅自修改真人日程。" },
      human_handoff: { title: "申请真人接手", detail: "需要判断或承诺时，带着当前上下文转给真人。" },
      paid_unlock: { title: "继续深入沟通", detail: "基础交流后，可按需要选择更长对话或人工评估。" },
    };
  }

  return {
    faq_reply: { title: "Answer common questions", detail: "Explain products, services, and ways to work together using published information." },
    lead_qualify: { title: "Check whether there is a fit", detail: "Ask a few focused questions and suggest the clearest next step." },
    intake_collect: { title: "Organize your request", detail: "Capture goals, context, and constraints in a useful summary." },
    quote_request_collect: { title: "Prepare a quote request", detail: "Collect scope, budget, and timing before a human confirms anything." },
    material_delivery: { title: "Find public resources", detail: "Surface public documents and downloads that match your question." },
    scheduling_request: { title: "Request a meeting", detail: "Record the topic and preferred timing without changing anyone's calendar." },
    human_handoff: { title: "Ask for a human", detail: "Carry the conversation context to a human when judgment or commitment is needed." },
    paid_unlock: { title: "Continue with deeper help", detail: "Move from basic questions to a longer conversation or human review when needed." },
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
    chatNav: "开始对话",
    rechargeNav: "服务包",
    aboutNav: "能帮什么",
    resourcesNav: "公开资料",
    trustNav: "隐私与真人",
    representing: (ownerName: string) => `${ownerName} 的数字代表`,
    publicRepresentative: "公开数字代表",
    aiDisclosure: "由 AI 回复",
    humanAvailable: "必要时可转真人",
    startEyebrow: "从这里开始",
    startTitle: "直接说说你想解决什么",
    startSummary: (name: string, governedContextEnabled: boolean) =>
      governedContextEnabled
        ? `${name} 会先理解问题，以已发布资料为基础，并在需要时使用仅限你与当前代表的受治理历史摘要。`
        : `${name} 会先理解问题，再根据已发布资料回答或帮你找到下一步。`,
    startChat: "开始提问",
    capabilitiesEyebrow: "我可以帮你",
    capabilitiesTitle: "把问题推进到清楚的下一步",
    capabilitiesSummary: (ownerName: string) => `先处理适合公开回答和标准化收集的事项；需要 ${ownerName} 判断或承诺时，再转交真人。`,
    resourcesEyebrow: "公开资料",
    resourcesTitle: "你可以直接查看和使用的内容",
    resourcesSummary: "回答会优先引用这些公开信息；与当前问题相关的来源也会显示在消息下方。",
    demoEyebrow: "本地演示",
    demoTitle: "验证服务包购买流程",
    demoSummary: "这里只用于开发测试，不会产生真实扣款；模拟支付后会直接发放当前代表的演示服务额度。",
    trustItems: (governedContextEnabled: boolean) => [
      "这是 AI 数字代表，AI 和真人消息会明确区分。",
      governedContextEnabled
        ? "回答以已发布、允许公开使用的资料为基础，也可能使用仅限当前访客与本代表的受治理历史摘要。"
        : "回答使用已发布、允许公开使用的资料，并在相关回答下展示来源。",
      "不会读取主人的私人文件、账号或工作区；报价、承诺和日程需要真人确认。",
    ],
    handoffVisitorTitle: (ownerName: string) => `需要 ${ownerName} 本人判断？`,
    addHandoffContext: "回到对话并补充需求",
    footerDisclosure: (name: string) => `${name} 是由 Delegate 提供支持的公开数字代表。`,
    brandTagline: "Web-first 公开代表档案",
    menuAriaLabel: "代表页分区",
    languageAriaLabel: "语言切换",
    language: { zh: "中文", en: "English" },
    menu: [
      { href: "#overview", label: "概览" },
      { href: "#recharge", label: "服务包" },
      { href: "#chat", label: "对话" },
      { href: "#trust", label: "边界" },
      { href: "#skills", label: "技能" },
      { href: "#knowledge", label: "知识" },
      { href: "#plans", label: "方案" },
      { href: "#handoff", label: "转接" },
    ],
    homeLabel: "官网",
    dashboardLabel: "Dashboard",
    loginRegisterLabel: "登录 / 注册",
    signedInLabel: "已登录",
    logoutLabel: "退出",
    profileEyebrow: "Representative Profile",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    worksForLabel: "Who this representative works for",
    startOnWeb: "在网页中开始",
    viewControlPlane: "查看控制台",
    reviewBoundary: "查看能力边界",
    frontDeskEyebrow: "AI 接待前台",
    frontDeskTitle: "先接住高频、标准化、可定价的对话",
    frontDeskSummary: (name: string) =>
      `${name} 不替代真人本人，而是先把能回答、该收费、要请示、需转接的请求分流清楚。`,
    frontDeskSteps: [
      { label: "Answer", title: "能回答的先回答", body: "公开 FAQ、资料和服务边界先由代表说明，减少重复解释。" },
      { label: "Charge", title: "该收费的先收费", body: "深度服务和优先响应会进入网页服务包、支付和订单记录。" },
      { label: "Ask", title: "需要拍板的先请示", body: "敏感动作和高价值判断会进入审批或待处理请求，而不是自动越权。" },
      { label: "Human", title: "需要人时再转接", body: "真正需要真人的请求会带着上下文进入人工转接流程。" },
    ],
    rechargeEyebrow: "当前代表服务包",
    rechargeTitle: "购买当前数字代表的服务额度",
    rechargeSummary: (name: string) =>
      `选择 ${name} 已上架的服务包；支付成功后会直接发放当前代表专属额度，无需再用余额二次购买。`,
    agentWalletEyebrow: "额度范围",
    agentWalletTitle: "服务额度只适用于当前数字代表",
    agentWalletCopy: (name: string) =>
      `${name} 的公开页面只展示服务端已上架的服务包。付款成功后，额度会直接发放到当前登录账户并限定用于这个代表。`,
    agentWalletCurrentChip: "当前：一次性服务包",
    webFirstChip: "网页优先",
    amnPayRoadmapChip: "微信收款受生产开关控制",
    balanceDisclosure: (name: string) =>
      `购买的服务额度仅用于 ${name} 这个数字代表的服务，不代表进入真人的私人工作区，也不会自动授权其它代表。`,
    rechargeCta: "购买服务包 / 继续服务",
    platformAccountsEyebrow: "Platform accounts",
    platformAccountsTitle: "跨平台入口汇聚",
    platformLive: "已接入",
    platformSetupNeeded: "待配置",
    platformRoadmap: "roadmap",
    platformWebDetail: "第一版主入口。用户先在网页代表页完成理解、试聊、服务档位预览和转接。",
    platformTelegramDetail: "后续消息入口。若未来提供 Telegram 内数字服务，会遵循 Telegram Stars 规则。",
    platformWhatsAppDetail: "未来可作为消息入口，把用户带回同一个网页服务包和服务入口。",
    platformFeishuDetail: "未来可作为企业协作入口，服务额度与计费仍归属当前代表。",
    platformWeComDetail: "未来可作为企业微信入口，服务额度仍只归属当前代表。",
    openPlatform: "打开",
    trustProofEyebrow: "Proof + QR",
    trustProofTitle: "评分、来源和二维码占位",
    trustProofCopy:
      "这里集中展示公开评价、服务包支付入口和来源证明。未认领代表必须明确标注来源和授权状态，不能让用户误以为已获得本人官方授权。",
    qrAriaLabel: "服务包支付二维码",
    ratingChip: "历史评分 4.8/5 demo",
    claimStatusChip: "claimed demo",
    publicSourcesChip: "公开来源",
    refundDisclosure:
      "一次性服务包仅用于当前代表；购买所得额度完全未使用且未预留时，才可申请全额退款。",
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
    trustEyebrow: "隐私与边界",
    trustSummary: "公开能力、拒绝范围、升级路径和计费方式都不应该藏在对话里。",
    trustTitle: "你在对话前应该知道这些",
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
    handoffReadyLabel: "可转人工",
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
    knowledgeSummary: "代表先从结构化知识里拿答案，再决定下一步是继续回答、收集需求还是升级转接。",
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
    plansTitle: "四档服务深度，而不是技术计费",
    accessLayerEyebrow: "服务深度",
    repliesChip: (count: number) => `${count} 次回复`,
    priorityHandoffChip: "优先转人工",
    paidPlanHint: "可在服务包区选择",
    startWebChat: "开始网页试聊",
    previewRecharge: "查看服务包",
    handoffEyebrow: "人工转接",
    handoffSummary: "当公开代表接近边界时，转接不该是一句拒答，而应该是一条明确可预期的升级路径。",
    handoffTitle: "主人最终接手的是高价值收件项，不是原始噪音",
    handoffCopyEyebrow: "转接说明",
    handoffCopyTitle: "对外升级说明",
    entryPointsEyebrow: "Entry points",
    entryPointsTitle: "继续对话的公开入口",
    entryPointsCopy: (strategy: string) => `第一版入口是网页代表页。Telegram、群组和其它消息平台后续接入时，也会沿用 ${strategy} 这类保守激活策略。`,
    openRepresentative: "回到网页对话",
  },
  en: {
    chatNav: "Start chatting",
    rechargeNav: "Service packages",
    aboutNav: "What I can do",
    resourcesNav: "Public resources",
    trustNav: "Privacy & human help",
    representing: (ownerName: string) => `Digital representative for ${ownerName}`,
    publicRepresentative: "Public digital representative",
    aiDisclosure: "Replies with AI",
    humanAvailable: "Human help when needed",
    startEyebrow: "Start here",
    startTitle: "Tell me what you want to solve",
    startSummary: (name: string, governedContextEnabled: boolean) =>
      governedContextEnabled
        ? `${name} will understand the request, use published information as the foundation, and when useful apply governed history scoped only to you and this representative.`
        : `${name} will understand the request, answer from published information, and help you find the next step.`,
    startChat: "Ask a question",
    capabilitiesEyebrow: "How I can help",
    capabilitiesTitle: "Move your request toward a clear next step",
    capabilitiesSummary: (ownerName: string) => `I handle public questions and structured intake first, then involve ${ownerName} when judgment or commitment is required.`,
    resourcesEyebrow: "Public resources",
    resourcesTitle: "Information you can review and use directly",
    resourcesSummary: "Replies prioritize these public sources, and relevant references appear below the answer that used them.",
    demoEyebrow: "Local demo",
    demoTitle: "Verify the service-package purchase flow",
    demoSummary: "This is for development testing only and does not create a real charge. Simulated payment directly grants demo credits for this representative.",
    trustItems: (governedContextEnabled: boolean) => [
      "This is an AI representative. AI and human messages are always labeled separately.",
      governedContextEnabled
        ? "Replies are grounded in published information approved for public use and may also use governed history scoped only to this visitor and representative."
        : "Replies use published information approved for public use, with sources shown on relevant answers.",
      "It cannot read the owner's private files, accounts, or workspace. Quotes, commitments, and calendars require human confirmation.",
    ],
    handoffVisitorTitle: (ownerName: string) => `Need ${ownerName} to make the call?`,
    addHandoffContext: "Return to chat and add context",
    footerDisclosure: (name: string) => `${name} is a public digital representative powered by Delegate.`,
    brandTagline: "Web-first public representative profile",
    menuAriaLabel: "Representative sections",
    languageAriaLabel: "Language switcher",
    language: { zh: "Chinese", en: "English" },
    menu: [
      { href: "#overview", label: "Overview" },
      { href: "#recharge", label: "Service packages" },
      { href: "#chat", label: "Chat" },
      { href: "#trust", label: "Trust" },
      { href: "#skills", label: "Skills" },
      { href: "#knowledge", label: "Knowledge" },
      { href: "#plans", label: "Plans" },
      { href: "#handoff", label: "Handoff" },
    ],
    homeLabel: "Home",
    dashboardLabel: "Dashboard",
    loginRegisterLabel: "Log in / Sign up",
    signedInLabel: "Signed in",
    logoutLabel: "Log out",
    profileEyebrow: "Representative Profile",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    worksForLabel: "Who this representative works for",
    startOnWeb: "Start on web",
    viewControlPlane: "View control plane",
    reviewBoundary: "Review boundaries",
    frontDeskEyebrow: "AI front desk",
    frontDeskTitle: "Catch high-frequency, standardized, priceable conversations first",
    frontDeskSummary: (name: string) =>
      `${name} does not replace a real person. It separates what can be answered, what should be paid, what needs approval, and what deserves human follow-up.`,
    frontDeskSteps: [
      { label: "Answer", title: "Answer what it can", body: "Public FAQs, materials, and service boundaries are explained before a person has to repeat themselves." },
      { label: "Charge", title: "Charge when needed", body: "Deeper service and priority move into web service packages, payment, and order records." },
      { label: "Ask", title: "Ask for approval", body: "Sensitive actions and high-value judgment go through approval or a follow-up queue instead of silent overreach." },
      { label: "Human", title: "Bring in a person", body: "Requests that truly need a human arrive with context through the follow-up flow." },
    ],
    rechargeEyebrow: "Service packages for this representative",
    rechargeTitle: "Buy service credits for this Digital Representative",
    rechargeSummary: (name: string) =>
      `Choose a package published by ${name}. Successful payment directly grants representative-scoped credits with no second wallet purchase.`,
    agentWalletEyebrow: "Credit scope",
    agentWalletTitle: "Service credits apply only to this Digital Representative",
    agentWalletCopy: (name: string) =>
      `${name}'s public page shows only server-published service packages. Successful payment grants credits directly to the signed-in account for this representative.`,
    agentWalletCurrentChip: "Today: one-time service packages",
    webFirstChip: "Web first",
    amnPayRoadmapChip: "WeChat collection is production-gated",
    balanceDisclosure: (name: string) =>
      `Purchased service credits are scoped to ${name}'s Digital Representative service. They do not grant private workspace access or authorize other representatives.`,
    rechargeCta: "Buy a service package / continue",
    platformAccountsEyebrow: "Platform accounts",
    platformAccountsTitle: "Cross-platform entry points",
    platformLive: "live",
    platformSetupNeeded: "needs configuration",
    platformRoadmap: "roadmap",
    platformWebDetail: "First-version primary entry for understanding, trial chat, service preview, and human follow-up.",
    platformTelegramDetail: "Future message entry. If Telegram digital services ship later, they should follow Telegram Stars rules.",
    platformWhatsAppDetail: "Future message entry that can bring users back to the same web service-package and service page.",
    platformFeishuDetail: "Future collaboration entry where service credits and billing remain scoped to this representative.",
    platformWeComDetail: "Future WeCom entry where service credits remain scoped to this representative.",
    openPlatform: "Open",
    trustProofEyebrow: "Proof + QR",
    trustProofTitle: "Rating, source, and QR placeholder",
    trustProofCopy:
      "Public ratings, the service-package payment entry, and source proof live here. Unclaimed representatives must disclose source and authorization state clearly so users do not assume official endorsement.",
    qrAriaLabel: "Service-package payment QR",
    ratingChip: "4.8/5 demo rating",
    claimStatusChip: "claimed demo",
    publicSourcesChip: "public sources",
    refundDisclosure:
      "A one-time package is scoped to this representative. A full refund is available only while all granted credits remain unused and unreserved.",
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
    trustEyebrow: "Privacy and boundaries",
    trustSummary: "Capabilities, refusals, escalation, and pricing should be visible before the conversation goes deep.",
    trustTitle: "What you should know before chatting",
    allowedEyebrow: "Allowed",
    allowedTitle: "What this representative will do",
    allowList: ["Answer FAQs", "Collect collaboration, quote, and scheduling details", "Deliver public materials", "Create safe follow-up requests", "Offer web service upgrades"],
    notAllowedEyebrow: "Not allowed",
    notAllowedTitle: "What this representative will not do",
    denyList: ["Access private file systems", "Read private memory", "Log into private accounts", "Change the real calendar directly", "Make irreversible commercial commitments"],
    contractEyebrow: "Conversation contract",
    contractTitle: "Free scope, upgrade rules, and human follow-up policy",
    contractCopy: (limit: number) => `The first ${limit} replies are optimized for foundational questions and materials. Deeper collaboration judgment, quote intake, and scheduling move into paid continuation or human follow-up.`,
    publicRuntimeLabel: "publicly active",
    privateDraftLabel: "draft only",
    handoffReadyLabel: "human follow-up ready",
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
    knowledgeSummary: "The representative should answer from structured knowledge first, then decide whether to continue, collect details, or escalate.",
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
    plansTitle: "Four service depths instead of technical pricing",
    accessLayerEyebrow: "Service depth",
    repliesChip: (count: number) => `${count} replies`,
    priorityHandoffChip: "priority human follow-up",
    paidPlanHint: "Choose in service packages",
    startWebChat: "Start web chat",
    previewRecharge: "View service packages",
    handoffEyebrow: "Human follow-up",
    handoffSummary: "When the public representative reaches its boundary, escalation should feel like a predictable path instead of a vague refusal.",
    handoffTitle: "A person should receive high-value follow-up items, not raw noise",
    handoffCopyEyebrow: "Follow-up copy",
    handoffCopyTitle: "Public escalation copy",
    entryPointsEyebrow: "Entry points",
    entryPointsTitle: "Public paths to continue the conversation",
    entryPointsCopy: (strategy: string) => `The first-version entry point is the web representative page. Telegram, groups, and other message platforms can later reuse conservative activation policies such as ${strategy}.`,
    openRepresentative: "Return to web chat",
  },
} as const;
