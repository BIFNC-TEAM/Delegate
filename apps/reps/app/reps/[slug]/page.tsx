import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  AGENT_WALLET_TIP_PRODUCT_CODE,
  getRepresentativePublicDeliverables,
  getPublicRepresentativeRuntime,
  listPublicCommerceProducts,
  prisma,
  preflightWeChatPayRuntime,
  resolvePublicAudiencePrincipal,
} from "@delegate/web-data";
import {
  HashScrollRestorer,
  buildLocalizedHref,
  extractCountryHint,
  pickCopy,
  resolveServiceUrl,
  resolveLocale,
  type Locale,
} from "@delegate/web-ui";

import { RepresentativeAccountMenu } from "./representative-account-menu";
import { RepresentativeChatPanel } from "./representative-chat-panel";
import { RepresentativeIdentityBindingPanel } from "./representative-identity-binding-panel";
import { RepresentativeMemorySharingPanel } from "./representative-memory-sharing-panel";
import { getUsablePublicUrl } from "./public-materials";
import { RepresentativeProfileInspector } from "./representative-profile-inspector";
import { RepresentativeRechargePanel } from "./representative-recharge-panel";
import {
  buildPublicAudienceLoginHref,
  buildPublicAudienceLogoutHref,
} from "./public-auth";
import { getGovernedContextDisclosure } from "./governed-context-disclosure";
import { resolvePublicAudienceVerifiedAuthContext } from "./public-principal";

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

  const representative = runtime.setup;
  const [deliverableSnapshot, commercePresentation] = await Promise.all([
    getRepresentativePublicDeliverables(slug),
    readPublicCommercePresentation(representative.id),
  ]);
  const governedContextDisclosure = getGovernedContextDisclosure(
    locale,
    runtime.governedMemoryDisclosure,
  );
  let audienceSession: Awaited<
    ReturnType<typeof resolvePublicAudienceVerifiedAuthContext>
  >["session"] = null;
  try {
    const verifiedAuth = await resolvePublicAudienceVerifiedAuthContext({
      cookieStore,
    });
    audienceSession =
      verifiedAuth.session?.audienceIdentityId
      && verifiedAuth.session.audienceId
        ? verifiedAuth.session
        : null;
  } catch {
    audienceSession = null;
  }
  let audiencePrincipalIdentityId: string | null = null;
  if (audienceSession) {
    const audienceId = audienceSession.audienceId;
    if (!audienceId) {
      audienceSession = null;
    } else {
      try {
        const audiencePrincipal = await resolvePublicAudiencePrincipal({
          audienceId,
          verifiedAuthSession: audienceSession,
        });
        audiencePrincipalIdentityId =
          audiencePrincipal.audienceIdentityId;
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
  const weChatPayPreflight = preflightWeChatPayRuntime();
  const paymentAvailability =
    weChatPayPreflight.status !== "ready"
      ? "unavailable" as const
      : weChatPayPreflight.collectionEnabled
        ? "ready" as const
        : "collection_paused" as const;
  const collectionEnabled = paymentAvailability === "ready";
  const visibleCommerceProducts = commercePresentation.products;
  const visibleTipProducts = visibleCommerceProducts.filter(
    (product) => product.kind === "TIP",
  );
  const hasPublicTips =
    commercePresentation.tipsEnabled && visibleTipProducts.length > 0;
  const hasServicePackages = visibleCommerceProducts.some(
    (product) => product.kind === "SERVICE_PACKAGE",
  );
  const hasRestorableCommerceActivity =
    audiencePrincipalIdentityId
      ? await hasRestorablePublicCommerceActivity({
          audienceIdentityId: audiencePrincipalIdentityId,
          representativeId: representative.id,
        })
      : false;
  const hasPublicCommerce =
    visibleCommerceProducts.length > 0 || hasRestorableCommerceActivity;
  const profileResources = [
    ...representative.knowledgePack.materials.map((item) => ({
      id: item.id,
      title: item.title,
      kind: "material" as const,
      href: getUsablePublicUrl(item.url),
    })),
    ...publicDeliverables.map((deliverable) => ({
      id: deliverable.id,
      title: deliverable.title,
      kind: "deliverable" as const,
      href: deliverable.sourceKind === "external_link"
        ? getUsablePublicUrl(deliverable.externalUrl)
        : `/reps/${representative.slug}/deliverables/${deliverable.id}/download`,
    })),
  ];
  const localizedRepresentativePath = telegramRechargeSource && hasPublicCommerce
    ? `/reps/${representative.slug}?source=telegram`
    : `/reps/${representative.slug}`;
  const accountSettingsPath = telegramRechargeSource && hasPublicCommerce
    ? `/reps/${representative.slug}/settings?source=telegram`
    : `/reps/${representative.slug}/settings`;
  const languageItems = [
    {
      locale: "zh" as const,
      href: buildLocalizedHref(localizedRepresentativePath, "zh"),
      label: t.language.zh,
      shortLabel: "ZH",
    },
    {
      locale: "en" as const,
      href: buildLocalizedHref(localizedRepresentativePath, "en"),
      label: t.language.en,
      shortLabel: "EN",
    },
  ];
  const audienceAccountLabel = maskAudienceAccountLabel(
    audienceSession?.email,
    t.accountLabel,
  );

  return (
    <main className="marketing-shell representative-shell representative-profile-page localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <HashScrollRestorer />
      <header className="marketing-topbar representative-topbar">
        <div className="marketing-brand">
          <a
            aria-label={t.homeAriaLabel}
            className="representative-brand-home"
            href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}
          >
            <img className="marketing-brand-mark" src="/D_logo.svg" alt="" />
          </a>
          <div className="representative-topbar-identity">
            <strong>Delegate</strong>
            <div className="muted">{t.publicRepresentative}</div>
          </div>
        </div>

        <span aria-hidden="true" className="representative-topbar-spacer" />

        <div className={`marketing-nav-actions${audienceSession ? " is-authenticated" : ""}`}>
          <RepresentativeAccountMenu
            accountInitial={audienceSession
              ? getAudienceAccountInitial(audienceSession.email, locale)
              : locale === "zh" ? "访" : "G"}
            accountLabel={audienceSession ? audienceAccountLabel : t.loginRegisterLabel}
            accountMenuAriaLabel={t.accountMenuAriaLabel}
            authenticated={Boolean(audienceSession)}
            loginHref={audienceLoginHref}
            loginLabel={t.loginRegisterLabel}
            logoutHref={audienceLogoutHref}
            logoutLabel={t.logoutLabel}
            myAccountLabel={t.accountLabel}
            settingsHref={buildLocalizedHref(accountSettingsPath, locale)}
            settingsLabel={t.settingsLabel}
          />
        </div>
      </header>

      <div
        aria-label={t.conversationWorkspaceAriaLabel}
        className="representative-profile-workspace"
        role="region"
      >
        <RepresentativeChatPanel
          computeEnabled={representative.compute.enabled}
          accessMode={runtime.accessMode}
          faqQuestions={representative.knowledgePack.faq.map((item) => item.title)}
          freeReplyLimit={representative.contract.freeReplyLimit}
          governedMemoryDisclosure={runtime.governedMemoryDisclosure}
          hasPublicCommerce={hasPublicCommerce}
          hasServicePackages={hasServicePackages}
          humanInLoop={representative.humanInLoop}
          {...(telegramRechargeSource
            ? { initialProfileSection: "services" as const }
            : {})}
          locale={locale}
          ownerName={representative.ownerName}
          representativeName={representative.name}
          representativeSlug={representative.slug}
          serviceCreditPurchaseEnabled={hasServicePackages && collectionEnabled}
          profilePanel={(
            <RepresentativeProfileInspector
              audienceAuthenticated={Boolean(audienceSession)}
              bindingManagement={audienceSession ? (
                <div className="representative-profile-management-stack">
                  <RepresentativeIdentityBindingPanel
                    locale={locale}
                    representativeSlug={representative.slug}
                  />
                  <RepresentativeMemorySharingPanel
                    locale={locale}
                    representativeSlug={representative.slug}
                  />
                </div>
              ) : undefined}
              commerceManagement={hasPublicCommerce ? (
                <RepresentativeRechargePanel
                  audienceAuthenticated={Boolean(audienceSession)}
                  collectionEnabled={collectionEnabled}
                  {...(telegramRechargeSource
                    ? { continuationChannel: "telegram" as const }
                    : {})}
                  locale={locale}
                  loginHref={audienceLoginHref}
                  paymentAvailability={paymentAvailability}
                  initialCommerceProducts={visibleCommerceProducts}
                  representativeSlug={representative.slug}
                />
              ) : undefined}
              tipManagement={hasPublicTips ? (
                <RepresentativeRechargePanel
                  audienceAuthenticated={Boolean(audienceSession)}
                  collectionEnabled={collectionEnabled}
                  locale={locale}
                  loginHref={audienceLoginHref}
                  paymentAvailability={paymentAvailability}
                  initialCommerceProducts={visibleTipProducts}
                  productKindFilter="TIP"
                  representativeSlug={representative.slug}
                />
              ) : undefined}
              {...(telegramRechargeSource
                ? { initialSection: "services" as const }
                : {})}
              locale={locale}
              loginHref={audienceLoginHref}
              memoryDisclosure={governedContextDisclosure}
              ownerName={representative.ownerName}
              representativeName={representative.name}
              representativeSlug={representative.slug}
              resources={profileResources}
              tagline={representative.tagline}
              trustItems={t.trustItems(runtime.governedContextEnabled)}
            />
          )}
        />
      </div>

      <footer className="representative-visitor-footer">
        <span>{t.footerDisclosure(representative.name)}</span>
        <a href={buildLocalizedHref(`${siteBaseUrl}/`, locale)}>Delegate</a>
      </footer>
    </main>
  );
}

async function readPublicCommercePresentation(representativeId: string) {
  const unavailable = {
    products: [] as Awaited<ReturnType<typeof listPublicCommerceProducts>>,
    handoffAccessMode: "PACKAGE_REQUIRED" as const,
    tipsEnabled: false,
  };
  if (!process.env.DATABASE_URL?.trim()) return unavailable;
  try {
    const [products, settings] = await Promise.all([
      listPublicCommerceProducts({ representativeId, currency: "CNY" }),
      prisma.representative.findUnique({
        where: { id: representativeId },
        select: { handoffAccessMode: true, tipsEnabled: true },
      }),
    ]);
    if (!settings) return unavailable;
    return {
      products,
      handoffAccessMode: settings.handoffAccessMode,
      tipsEnabled: settings.tipsEnabled,
    };
  } catch {
    // Commerce is secondary to the public conversation. Fail closed without
    // rendering stale prices when its server truth cannot be read.
    return unavailable;
  }
}

async function hasRestorablePublicCommerceActivity(input: {
  audienceIdentityId: string;
  representativeId: string;
}) {
  try {
    const order = await prisma.rechargeOrder.findFirst({
      where: {
        representativeId: input.representativeId,
        productCode: {
          in: [
            AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
            AGENT_WALLET_TIP_PRODUCT_CODE,
          ],
        },
        userWallet: {
          audienceIdentityId: input.audienceIdentityId,
        },
      },
      select: { id: true },
    });
    return Boolean(order);
  } catch {
    // Catalog visibility must not become an oracle for order ownership. If the
    // history check fails, the authenticated recharge API remains the source
    // of truth and the public page keeps the secondary commerce area closed.
    return false;
  }
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

function maskAudienceAccountLabel(
  email: string | null | undefined,
  fallback: string,
) {
  if (!email) return fallback;
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return fallback;
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${localPart.length > visible.length ? "***" : ""}@${domain}`;
}

function getAudienceAccountInitial(
  email: string | null | undefined,
  locale: Locale,
) {
  const initial = email?.trim().slice(0, 1);
  return initial ? initial.toUpperCase() : locale === "zh" ? "我" : "ME";
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
    rechargeNav: "服务与支持",
    resourcesNav: "公开资料",
    trustNav: "隐私与真人",
    publicRepresentative: "公开数字代表",
    startEyebrow: "从这里开始",
    startTitle: "直接说说你想解决什么",
    startSummary: (name: string, governedContextEnabled: boolean) =>
      governedContextEnabled
        ? `${name} 会先理解问题，以已发布资料为基础，并在需要时使用仅限你与当前代表的受治理历史摘要。`
        : `${name} 会先理解问题，再根据已发布资料回答或帮你找到下一步。`,
    startChat: "开始提问",
    capabilitiesTitle: "把问题推进到清楚的下一步",
    capabilitiesSummary: (ownerName: string) => `先处理适合公开回答和标准化收集的事项；需要 ${ownerName} 判断或承诺时，再转交真人。`,
    resourcesEyebrow: "公开资料",
    resourcesTitle: "你可以直接查看和使用的内容",
    resourcesSummary: "回答会优先引用这些公开信息；与当前问题相关的来源也会显示在消息下方。",
    trustItems: (governedContextEnabled: boolean) => [
      "这是 AI 数字代表，AI 和真人消息会明确区分。",
      governedContextEnabled
        ? "回答以已发布、允许公开使用的资料为基础，也可能使用仅限当前访客与本代表的受治理历史摘要。"
        : "回答使用已发布、允许公开使用的资料，并在相关回答下展示来源。",
      "不会读取主人的私人文件、账号或工作区；报价、承诺和日程需要真人确认。",
    ],
    handoffVisitorTitle: (ownerName: string) => `需要 ${ownerName} 本人判断？`,
    handoffUnavailableTitle: "当前不提供人工接管",
    handoffUnavailableDetail: "你仍可继续与数字代表对话；当前会话不会进入真人队列。",
    handoffPackageDetail: "人工接管由已购买的服务套餐权益提供；可用次数、优先级与有效期会在当前会话中显示。",
    handoffPackageUnavailableDetail: "人工接管需要有效的套餐权益；当前暂无包含人工接管的可购买套餐。",
    openHandoffPackages: "查看含人工权益的服务套餐",
    addHandoffContext: "回到对话并补充需求",
    footerDisclosure: (name: string) => `${name} 是由 Delegate 提供支持的公开数字代表。`,
    brandTagline: "Web-first 公开代表档案",
    menuAriaLabel: "代表页分区",
    languageAriaLabel: "语言切换",
    language: { zh: "中文", en: "English" },
    languageMenuLabel: "界面语言",
    homeAriaLabel: "返回 Delegate 官网",
    dashboardLabel: "Dashboard",
    loginRegisterLabel: "登录 / 注册",
    accountLabel: "我的账户",
    accountMenuAriaLabel: "打开账户菜单",
    settingsLabel: "设置",
    accountCommerceLabel: "我的服务与订单",
    accountBindingsLabel: "账号与渠道绑定",
    logoutLabel: "退出",
    conversationWorkspaceAriaLabel: "与数字代表对话",
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
    rechargeEyebrow: "服务与支持",
    rechargeTitle: "按需要继续服务或自愿支持",
    rechargeSummary: (name: string) =>
      `这里仅展示 ${name} 当前真实上架的服务套餐与打赏档位；套餐权益和自愿支持会明确分开。`,
    commerceHistoryTitle: "查看服务与支持记录",
    commerceHistorySummary: "当前没有可购买选项；这里保留你的最近订单状态、支付结果和已获得的服务权益。",
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
    memoryDisclosureTitle: (enabled: boolean) => enabled
      ? "记忆与隐私说明"
      : "隐私与上下文说明",
    allowedEyebrow: "Allowed",
    allowedTitle: "代表会做什么",
    allowList: ["回答公开问题", "接收需求描述", "发送公开资料", "创建服务请求", "发起人工转接"],
    notAllowedEyebrow: "Not allowed",
    notAllowedTitle: "代表明确不会做什么",
    denyList: ["访问私有文件系统", "读取主人的私有记忆", "代主人登录账户", "擅自修改真实日程", "做不可逆商业承诺"],
    contractEyebrow: "Conversation contract",
    contractTitle: "免费、升级和转接规则",
    contractCopy: (limit: number) => `免费规则：前 ${limit} 条回复可用于公开问答和资料领取；需要进一步处理时，只需描述需求，真人接手后再确认其他必要信息。`,
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
    rechargeNav: "Services & support",
    resourcesNav: "Public resources",
    trustNav: "Privacy & human help",
    publicRepresentative: "Public digital representative",
    startEyebrow: "Start here",
    startTitle: "Tell me what you want to solve",
    startSummary: (name: string, governedContextEnabled: boolean) =>
      governedContextEnabled
        ? `${name} will understand the request, use published information as the foundation, and when useful apply governed history scoped only to you and this representative.`
        : `${name} will understand the request, answer from published information, and help you find the next step.`,
    startChat: "Ask a question",
    capabilitiesTitle: "Move your request toward a clear next step",
    capabilitiesSummary: (ownerName: string) => `I handle public questions and structured intake first, then involve ${ownerName} when judgment or commitment is required.`,
    resourcesEyebrow: "Public resources",
    resourcesTitle: "Information you can review and use directly",
    resourcesSummary: "Replies prioritize these public sources, and relevant references appear below the answer that used them.",
    trustItems: (governedContextEnabled: boolean) => [
      "This is an AI representative. AI and human messages are always labeled separately.",
      governedContextEnabled
        ? "Replies are grounded in published information approved for public use and may also use governed history scoped only to this visitor and representative."
        : "Replies use published information approved for public use, with sources shown on relevant answers.",
      "It cannot read the owner's private files, accounts, or workspace. Quotes, commitments, and calendars require human confirmation.",
    ],
    handoffVisitorTitle: (ownerName: string) => `Need ${ownerName} to make the call?`,
    handoffUnavailableTitle: "Human takeover is not available",
    handoffUnavailableDetail: "You can keep chatting with the digital representative, but this conversation will not enter a human queue.",
    handoffPackageDetail: "Human takeover comes from a purchased service package. Remaining uses, priority, and validity are shown in the current conversation.",
    handoffPackageUnavailableDetail: "Human takeover requires an active package entitlement, and no package with human help is currently available.",
    openHandoffPackages: "View packages with human help",
    addHandoffContext: "Return to chat and add context",
    footerDisclosure: (name: string) => `${name} is a public digital representative powered by Delegate.`,
    brandTagline: "Web-first public representative profile",
    menuAriaLabel: "Representative sections",
    languageAriaLabel: "Language switcher",
    language: { zh: "Chinese", en: "English" },
    languageMenuLabel: "Interface language",
    homeAriaLabel: "Back to Delegate home",
    dashboardLabel: "Dashboard",
    loginRegisterLabel: "Log in / Sign up",
    accountLabel: "My account",
    accountMenuAriaLabel: "Open account menu",
    settingsLabel: "Settings",
    accountCommerceLabel: "My services & orders",
    accountBindingsLabel: "Accounts & channel links",
    logoutLabel: "Log out",
    conversationWorkspaceAriaLabel: "Conversation with the digital representative",
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
    rechargeEyebrow: "Services & support",
    rechargeTitle: "Continue the service or offer voluntary support",
    rechargeSummary: (name: string) =>
      `Only live service packages and support amounts published by ${name} appear here. Package entitlements and voluntary support stay clearly separate.`,
    commerceHistoryTitle: "Review services & support history",
    commerceHistorySummary: "Nothing is currently available to buy. Your latest order status, payment result, and granted service entitlements remain available here.",
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
    memoryDisclosureTitle: (enabled: boolean) => enabled
      ? "Memory and privacy details"
      : "Privacy and context details",
    allowedEyebrow: "Allowed",
    allowedTitle: "What this representative will do",
    allowList: ["Answer public questions", "Receive a request description", "Deliver public materials", "Create service requests", "Start human follow-up"],
    notAllowedEyebrow: "Not allowed",
    notAllowedTitle: "What this representative will not do",
    denyList: ["Access private file systems", "Read private memory", "Log into private accounts", "Change the real calendar directly", "Make irreversible commercial commitments"],
    contractEyebrow: "Conversation contract",
    contractTitle: "Free replies, service access, and human follow-up",
    contractCopy: (limit: number) => `The first ${limit} replies cover public questions and materials. If more work is needed, describe the request once; a human can gather any remaining details after taking over.`,
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
