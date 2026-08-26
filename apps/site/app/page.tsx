import { headers } from "next/headers";

import { demoRepresentative } from "@delegate/domain";
import {
  HashScrollRestorer,
  buildLocalizedHref,
  extractCountryHint,
  pickCopy,
  resolveLocale,
  resolveServiceUrl,
} from "@delegate/web-ui";

import { SiteAccountNavigation } from "./site-account-navigation";

const copy = {
  zh: {
    brandTagline: "公开数字代表",
    menu: [
      { href: "#product", label: "产品" },
      { href: "#how", label: "工作方式" },
      { href: "#use-cases", label: "使用场景" },
      { href: "#trust", label: "安全边界" },
      { href: "#plans", label: "方案" },
    ],
    menuLabel: "菜单",
    navLogin: "登录",
    navCreate: "免费注册",
    account: {
      fallback: "已登录账号",
      menuLabel: "打开账号菜单",
      console: "前往控制台",
      representatives: "我的数字代表",
      settings: "用户设置",
      signOut: "退出登录",
      language: "语言",
    },
    heroEyebrow: "AI FRONT DESK · WEB-FIRST",
    heroTitle: "你的 AI 替身，代表你向外界提供服务",
    heroLead:
      "替你接待陌生人、筛选商机、处理简单任务。你躺平的时候，它替你干活，为你赚取被动收入，只把该你出面的事留给你。",
    heroPrimary: "创建我的数字代表",
    heroSecondary: "体验真实代表",
    heroTrust: ["仅使用已批准资料", "敏感动作先请示", "随时转人工接手"],
    mockLabel: "交互示例 · Mock 数据",
    mockRepName: "Lin 的数字代表",
    mockRepStatus: "在线接待中",
    mockVisitorLabel: "访客",
    mockVisitorMessage: "我们是 20 人的 AI 团队，想邀请 Lin 做一次产品战略咨询。",
    mockAgentLabel: "Delegate",
    mockAgentMessage:
      "可以。我先帮你确认团队阶段、希望解决的问题和时间范围，再判断适合哪种服务。",
    mockFields: ["产品已上线", "增长遇到瓶颈", "希望本月沟通"],
    mockRouteLabel: "已识别并路由",
    mockRouteValue: "付费咨询 · ¥299 示例服务包",
    mockOwnerLabel: "Owner 收到",
    mockOwnerValue: "高意向咨询 · 信息完整 · 等待确认",
    proofIntro: "不是把私人助理暴露给外界，而是发布一个有边界、可收费、能转接的公开接口。",
    proofItems: [
      { label: "公开入口", value: "一个可分享的代表页面" },
      { label: "服务升级", value: "从免费接待自然进入付费" },
      { label: "Owner 控制", value: "高价值事项才需要你介入" },
    ],
    problemEyebrow: "WHY DELEGATE",
    problemTitle: "真正浪费你的，不是一次重要沟通，而是每一次沟通前的重复筛选。",
    problemLead:
      "私信、邮件和群聊把同样的问题送到你面前。Delegate 把这些入口变成一条清晰的接待流水线。",
    beforeLabel: "现在",
    afterLabel: "使用 Delegate 后",
    comparisons: [
      ["消息散落在私信、邮件和群聊", "统一进入一个公开代表入口"],
      ["反复回答背景、价格和合作方式", "基于批准资料给出一致回答"],
      ["商机与普通咨询混在一起", "先识别意图，再收集必要信息"],
      ["每个请求都打断本人", "只转接高价值或敏感事项"],
    ],
    howEyebrow: "THE FRONT DESK LOOP",
    howTitle: "四步接住一次外部请求，不让 AI 越界。",
    howLead: "从第一句问候到人工接手，每一步都有明确状态和责任边界。",
    steps: [
      {
        number: "01",
        label: "接住",
        title: "先回答公开问题",
        body: "代表使用你批准的资料回答背景、服务范围、公开价格和常见问题。",
        signal: "PUBLIC KNOWLEDGE",
      },
      {
        number: "02",
        label: "筛选",
        title: "把模糊需求变完整",
        body: "自动确认身份、目标、预算和时间，把随口一问整理成可判断的请求。",
        signal: "STRUCTURED INTAKE",
      },
      {
        number: "03",
        label: "深入",
        title: "该收费时再收费",
        body: "免费接待结束后，深度问答、优先处理或具体交付进入清楚的服务包。",
        signal: "PAID CONTINUATION",
      },
      {
        number: "04",
        label: "转接",
        title: "带着上下文交给你",
        body: "敏感、高价值或需要承诺的事项进入请示队列，你接手时不必重新问一遍。",
        signal: "OWNER HANDOFF",
      },
    ],
    casesEyebrow: "USE CASES · MOCK SCENARIOS",
    casesTitle: "不是替你说所有话，而是替你守住第一道门。",
    casesLead: "以下场景使用 Mock 数据展示产品路径，最终配置由每位 Owner 自己批准。",
    cases: [
      {
        audience: "创始人",
        descriptor: "融资、合作与招聘",
        inbound: "“我们想和你聊一轮融资合作，下周有时间吗？”",
        handled: "核验机构、收集合作目标、团队阶段和时间范围",
        handoff: "高匹配合作进入 Owner 待处理队列",
      },
      {
        audience: "顾问 / 专家",
        descriptor: "咨询资格与服务交付",
        inbound: "“能否帮我们评审一版 AI 产品路线？”",
        handled: "确认问题类型、交付深度、预算与资料准备情况",
        handoff: "匹配服务包后收费，复杂判断再请示",
      },
      {
        audience: "创作者",
        descriptor: "品牌合作与深度问答",
        inbound: "“想邀请你做一次新品内容合作。”",
        handled: "收集品牌、排期、预算和内容授权范围",
        handoff: "符合合作规则的请求才进入本人视野",
      },
    ],
    productEyebrow: "TWO SURFACES, ONE RELATIONSHIP",
    productTitle: "访客看到可信的代表，Owner 看到清楚的运营台。",
    productLead: "同一条关系，在外部保持简单，在内部保持可控。",
    publicSurface: {
      kicker: "PUBLIC REPRESENTATIVE",
      title: "对外：公开代表页面",
      body: "访客先理解代表身份、资料边界和可用服务，再开始对话。",
      features: ["身份与 AI 披露始终可见", "公开资料和服务范围清楚", "聊天、付费与转人工在同一页面"],
      status: "公开状态",
      statusValue: "已发布 · 边界已批准",
      profileLabel: "创始人代表",
      prompt: "可以咨询产品战略、顾问服务，或发起一次引荐申请。",
      input: "开始公开对话",
    },
    ownerSurface: {
      kicker: "OWNER CONTROL PLANE",
      title: "对内：代表运营台",
      body: "Owner 只处理值得亲自介入的请求，并能看见每次路由的原因。",
      queue: [
        ["产品咨询", "高意向 · 等待确认"],
        ["媒体采访", "资料完整 · 建议接手"],
        ["普通 FAQ", "已由代表完成"],
      ],
      status: "今日接待",
      statusValue: "18 次 · 3 项需要你",
      queueLabel: "待处理请求",
      queueStatusLabel: "当前状态",
    },
    trustEyebrow: "VISIBLE CONTRACT",
    trustTitle: "安全边界不是法律页脚，而是每次互动的一部分。",
    trustLead:
      "外部用户知道自己面对的是谁，Owner 知道代表依据什么做出每一步判断。",
    trustItems: [
      { label: "能看", value: "仅批准过的公开知识、FAQ、资料与价格" },
      { label: "能做", value: "回答、收集需求、发起服务升级、创建转接" },
      { label: "先请示", value: "敏感信息、商业承诺、不可逆动作与例外报价" },
      { label: "绝不会", value: "进入私人工作区、冒充本人、任意执行外部动作" },
    ],
    trustNote: "所有示例均为 Mock 数据；真实代表的知识、服务和动作权限由 Owner 明确批准。",
    planEyebrow: "EARLY ACCESS · MOCK PRICING",
    planTitle: "先发布一个代表，再按真实使用深度升级。",
    planLead: "以下为官网展示用示例方案，不构成正式报价；最终价格以上线版本为准。",
    plans: [
      {
        name: "Preview",
        price: "¥0",
        suffix: "体验期",
        summary: "验证公开代表是否适合你的 inbound。",
        features: ["1 个公开代表", "基础知识包", "免费接待与人工转接", "示例运营概览"],
        cta: "体验演示代表",
        primary: false,
      },
      {
        name: "Operator",
        price: "¥199",
        suffix: "/ 月 · Mock",
        summary: "为稳定接待、付费服务和 Owner 协作而设计。",
        features: ["完整代表主页", "服务包与付费继续", "审批和高价值转接", "接待与收益视图"],
        cta: "创建我的代表",
        primary: true,
      },
    ],
    faqEyebrow: "QUESTIONS",
    faqTitle: "开始之前，最常被问到的事。",
    faqs: [
      ["它会冒充我吗？", "不会。代表页面会明确披露 AI 身份，并使用独立的公开代表身份与访客互动。"],
      ["它能看到我的私人资料吗？", "默认不能。代表只使用 Owner 明确批准的公开知识、FAQ、服务资料和价格。"],
      ["遇到它不该决定的事怎么办？", "请求会进入请示或转人工队列，并保留已收集的信息与路由原因。"],
      ["可以收费吗？", "可以配置免费接待和付费继续。当前官网价格与数据为 Mock，真实支付能力以上线配置为准。"],
      ["现在支持哪些入口？", "当前产品以 Web 公开代表页为主，其他消息渠道属于后续扩展方向。"],
      ["创建一个代表需要什么？", "准备身份介绍、公开资料、服务范围、边界规则和希望转接的请求类型即可。"],
    ],
    finalEyebrow: "OPEN YOUR FRONT DESK",
    finalTitle: "把重复接待交给代表，把重要关系留给自己。",
    finalLead: "先体验一个真实代表，再决定如何发布属于你的公开入口。",
    finalPrimary: "创建我的数字代表",
    finalSecondary: "先体验演示",
    footerSummary: "面向创始人、顾问和创作者的公开 AI 接待前台。",
    footerStatus: "Web-first · Early access",
    footerCopyright: "Delegate · 公开 AI 接待前台",
    footerProduct: "产品",
    footerResources: "了解更多",
    footerLinks: ["工作方式", "使用场景", "安全边界", "常见问题"],
    switcher: { zh: "中文", en: "English" },
  },
  en: {
    brandTagline: "Public digital representatives",
    menu: [
      { href: "#product", label: "Product" },
      { href: "#how", label: "How it works" },
      { href: "#use-cases", label: "Use cases" },
      { href: "#trust", label: "Safety" },
      { href: "#plans", label: "Plans" },
    ],
    menuLabel: "Menu",
    navLogin: "Sign in",
    navCreate: "Sign up free",
    account: {
      fallback: "Signed-in account",
      menuLabel: "Open account menu",
      console: "Go to dashboard",
      representatives: "My representatives",
      settings: "Account settings",
      signOut: "Sign out",
      language: "Language",
    },
    heroEyebrow: "AI FRONT DESK · WEB-FIRST",
    heroTitle: "Your AI double, representing you to provide services to the world.",
    heroLead:
      "It welcomes strangers, qualifies opportunities, and handles simple tasks for you. While you rest, it keeps working and earning passive income—bringing you in only when your personal attention is needed.",
    heroPrimary: "Create my representative",
    heroSecondary: "Try the live representative",
    heroTrust: ["Approved knowledge only", "Sensitive actions ask first", "Human takeover anytime"],
    mockLabel: "Interaction example · Mock data",
    mockRepName: "Lin's digital representative",
    mockRepStatus: "Receiving visitors",
    mockVisitorLabel: "Visitor",
    mockVisitorMessage: "We're a 20-person AI team and would like Lin's help with product strategy.",
    mockAgentLabel: "Delegate",
    mockAgentMessage:
      "I can help qualify the request first. What stage is the product at, what problem matters most, and when would you like to talk?",
    mockFields: ["Product launched", "Growth stalled", "This month"],
    mockRouteLabel: "Recognized and routed",
    mockRouteValue: "Paid advisory · ¥299 mock service",
    mockOwnerLabel: "Owner receives",
    mockOwnerValue: "High intent · Complete context · Awaiting review",
    proofIntro:
      "This is not a private assistant exposed to strangers. It is a bounded, billable public interface with a human handoff.",
    proofItems: [
      { label: "Public entry", value: "One representative page to share" },
      { label: "Service depth", value: "Free reception can become paid help" },
      { label: "Owner control", value: "You enter only where judgment matters" },
    ],
    problemEyebrow: "WHY DELEGATE",
    problemTitle: "The drain is not one important conversation. It is the repetitive filtering before every one.",
    problemLead:
      "DMs, email, and group chats keep sending the same questions back to you. Delegate turns them into one visible reception flow.",
    beforeLabel: "Today",
    afterLabel: "With Delegate",
    comparisons: [
      ["Requests scattered across DMs and email", "One public representative entry"],
      ["Repeating context, pricing, and process", "Consistent answers from approved material"],
      ["Real opportunities mixed with casual asks", "Intent recognized before information is collected"],
      ["Every request interrupts the owner", "Only sensitive or high-value work is handed off"],
    ],
    howEyebrow: "THE FRONT DESK LOOP",
    howTitle: "Four steps receive an inbound request without letting AI overstep.",
    howLead: "From the first greeting to human takeover, every step has a visible state and boundary.",
    steps: [
      { number: "01", label: "Receive", title: "Answer public questions", body: "The representative uses material you approved for context, scope, public pricing, and FAQs.", signal: "PUBLIC KNOWLEDGE" },
      { number: "02", label: "Qualify", title: "Turn a vague ask into a complete one", body: "It confirms identity, goals, budget, and timing before the owner needs to look.", signal: "STRUCTURED INTAKE" },
      { number: "03", label: "Deepen", title: "Charge only when depth begins", body: "Deeper answers, priority, and deliverables move into a clearly named service package.", signal: "PAID CONTINUATION" },
      { number: "04", label: "Hand off", title: "Bring the owner complete context", body: "Sensitive, high-value, or commitment-heavy requests enter a review queue without losing context.", signal: "OWNER HANDOFF" },
    ],
    casesEyebrow: "USE CASES · MOCK SCENARIOS",
    casesTitle: "It does not speak for you everywhere. It protects the first doorway.",
    casesLead: "These mock scenarios show the product path. Each owner approves the final knowledge, service, and handoff rules.",
    cases: [
      { audience: "Founder", descriptor: "Fundraising, partnerships, hiring", inbound: "“We'd like to explore a funding partnership. Are you free next week?”", handled: "Verify the organization, goal, company stage, and timing", handoff: "High-fit partnerships enter the owner's queue" },
      { audience: "Advisor / Expert", descriptor: "Qualification and delivery", inbound: "“Could you review our AI product roadmap?”", handled: "Confirm problem type, depth, budget, and material readiness", handoff: "Match a service package, then ask on complex judgment" },
      { audience: "Creator", descriptor: "Brand work and deeper access", inbound: "“We'd like to collaborate on a product launch.”", handled: "Collect brand, schedule, budget, and usage rights", handoff: "Only requests matching the collaboration rules reach the creator" },
    ],
    productEyebrow: "TWO SURFACES, ONE RELATIONSHIP",
    productTitle: "Visitors see a trustworthy representative. Owners see an operating desk.",
    productLead: "The same relationship stays simple outside and controllable inside.",
    publicSurface: {
      kicker: "PUBLIC REPRESENTATIVE",
      title: "Outside: the representative page",
      body: "Visitors understand identity, knowledge boundaries, and available services before they start.",
      features: ["AI identity stays visible", "Approved knowledge and service scope are clear", "Chat, payment, and handoff live on one page"],
      status: "Public status",
      statusValue: "Published · Boundaries approved",
      profileLabel: "Founder representative",
      prompt: "Ask about product strategy, advisory services, or a warm introduction.",
      input: "Start a public conversation",
    },
    ownerSurface: {
      kicker: "OWNER CONTROL PLANE",
      title: "Inside: the operating desk",
      body: "Owners see only the requests worth direct attention and why each request was routed.",
      queue: [["Product advisory", "High intent · Awaiting review"], ["Media interview", "Complete brief · Takeover suggested"], ["General FAQ", "Completed by representative"]],
      status: "Received today",
      statusValue: "18 requests · 3 need you",
      queueLabel: "Inbound queue",
      queueStatusLabel: "Status",
    },
    trustEyebrow: "VISIBLE CONTRACT",
    trustTitle: "Safety is not a legal footnote. It is part of every interaction.",
    trustLead: "Visitors know who they are speaking with. Owners know what evidence produced every routing decision.",
    trustItems: [
      { label: "Can see", value: "Approved public knowledge, FAQs, materials, and prices" },
      { label: "Can do", value: "Answer, collect demand, offer service depth, and create handoffs" },
      { label: "Asks first", value: "Sensitive data, commitments, irreversible actions, and exceptions" },
      { label: "Never", value: "Enter private workspaces, impersonate the owner, or act arbitrarily" },
    ],
    trustNote: "Every example uses mock data. Real knowledge, services, and action permissions require explicit owner approval.",
    planEyebrow: "EARLY ACCESS · MOCK PRICING",
    planTitle: "Publish one representative first. Upgrade when real usage becomes deeper.",
    planLead: "These are illustrative plans for the website, not a formal offer. Launch pricing may change.",
    plans: [
      { name: "Preview", price: "¥0", suffix: "trial", summary: "Validate whether a public representative fits your inbound.", features: ["1 public representative", "Basic knowledge pack", "Free reception and human handoff", "Mock operating overview"], cta: "Try the demo", primary: false },
      { name: "Operator", price: "¥199", suffix: "/ month · Mock", summary: "For stable reception, paid services, and owner collaboration.", features: ["Complete representative page", "Service packages and paid depth", "Approvals and high-value handoff", "Reception and revenue views"], cta: "Create my representative", primary: true },
    ],
    faqEyebrow: "QUESTIONS",
    faqTitle: "What people ask before opening the front desk.",
    faqs: [
      ["Will it impersonate me?", "No. The page explicitly discloses AI identity and uses a separate public representative identity."],
      ["Can it see my private material?", "Not by default. It uses only public knowledge, FAQs, services, and prices explicitly approved by the owner."],
      ["What happens when it should not decide?", "The request enters an approval or human handoff queue with its context and routing reason intact."],
      ["Can it charge for service?", "You can configure free reception and paid continuation. Pricing and data on this site are mock examples."],
      ["Which channels work today?", "The current product is centered on the public web representative. Other messaging channels are future extensions."],
      ["What do I need to create one?", "Prepare an identity, public materials, service scope, boundary rules, and the kinds of requests you want handed off."],
    ],
    finalEyebrow: "OPEN YOUR FRONT DESK",
    finalTitle: "Give repetitive reception to your representative. Keep the important relationships.",
    finalLead: "Try a real representative first, then decide how your own public doorway should work.",
    finalPrimary: "Create my representative",
    finalSecondary: "Try the demo first",
    footerSummary: "A public AI front desk for founders, advisors, and creators.",
    footerStatus: "Web-first · Early access",
    footerCopyright: "Delegate · Public AI front desk",
    footerProduct: "Product",
    footerResources: "Explore",
    footerLinks: ["How it works", "Use cases", "Safety", "Questions"],
    switcher: { zh: "Chinese", en: "English" },
  },
} as const;

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ lang?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const headerStore = await headers();
  const locale = resolveLocale({
    requestedLocale: params?.lang,
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });
  const t = pickCopy(locale, copy);
  const currentHost = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const representativeBaseUrl = resolveServiceUrl(process.env.NEXT_PUBLIC_REPRESENTATIVE_URL, "http://localhost:3002", {
    currentAppDefaultPort: 3000,
    currentHost,
  });
  const dashboardBaseUrl = resolveServiceUrl(process.env.NEXT_PUBLIC_DASHBOARD_URL, "http://localhost:3001", {
    currentAppDefaultPort: 3000,
    currentHost,
  });
  const selfServiceRegistrationEnabled =
    process.env.DELEGATE_CREATOR_ADMISSION_MODE?.trim().toLowerCase()
    === "self_service";
  const demoHref = buildLocalizedHref(`${representativeBaseUrl}/reps/${demoRepresentative.slug}`, locale);
  const dashboardHref = buildCreatorAuthHref(
    dashboardBaseUrl,
    "sign_in",
    buildLocalizedHref("/dashboard?view=overview", locale),
    locale,
  );
  const setupHref = buildCreatorAuthHref(
    dashboardBaseUrl,
    selfServiceRegistrationEnabled ? "register" : "sign_in",
    buildLocalizedHref(
      "/dashboard?view=representatives&repSection=directory",
      locale,
    ),
    locale,
  );
  const footerHrefs = ["#how", "#use-cases", "#trust", "#faq"];

  return (
    <main className="site-shell localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <HashScrollRestorer />

      <header className="site-header">
        <a className="site-brand" href="#top" aria-label="Delegate home">
          <img src="/D_logo.svg" alt="" className="site-brand-mark" />
          <span>
            <strong>Delegate</strong>
            <small>{t.brandTagline}</small>
          </span>
        </a>

        <nav className="site-nav" aria-label="Website sections">
          {t.menu.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}
        </nav>

        <SiteAccountNavigation
          activeLocale={locale}
          copy={{
            languageAriaLabel: t.account.language,
            menuLabel: t.menuLabel,
            login: t.navLogin,
            accountFallback: t.account.fallback,
            accountMenuLabel: t.account.menuLabel,
            console: t.account.console,
            representatives: t.account.representatives,
            settings: t.account.settings,
            signOut: t.account.signOut,
            zh: t.switcher.zh,
            en: t.switcher.en,
          }}
          dashboardBaseUrl={dashboardBaseUrl}
          loginHref={dashboardHref}
          menu={t.menu}
          registerHref={setupHref}
          registerLabel={selfServiceRegistrationEnabled
            ? t.navCreate
            : locale === "zh"
              ? "创建数字代表"
              : "Create a representative"}
          siteReturnTo={buildLocalizedHref("/", locale)}
        />
      </header>

      <section className="site-hero" id="top">
        <div className="site-hero-inner">
          <div className="site-hero-copy">
            <p className="site-eyebrow">{t.heroEyebrow}</p>
            <h1>{t.heroTitle}</h1>
            <p className="site-hero-lead">{t.heroLead}</p>
            <div className="site-actions">
              <a className="site-button site-button-primary" href={setupHref}>{t.heroPrimary}</a>
              <a className="site-button site-button-secondary" href={demoHref}>{t.heroSecondary}</a>
            </div>
            <ul className="site-trust-inline" aria-label="Trust summary">
              {t.heroTrust.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="site-reception-demo" aria-label={t.mockLabel}>
            <div className="site-demo-caption">
              <span>{t.mockLabel}</span>
              <span className="site-live-dot">{t.mockRepStatus}</span>
            </div>
            <div className="site-demo-window">
              <div className="site-demo-header">
                <span className="site-demo-avatar">L</span>
                <span><strong>{t.mockRepName}</strong><small>Delegate · AI</small></span>
                <span className="site-status-pill">PUBLIC</span>
              </div>
              <div className="site-conversation">
                <div className="site-message site-message-visitor">
                  <span>{t.mockVisitorLabel}</span>
                  <p>{t.mockVisitorMessage}</p>
                </div>
                <div className="site-message site-message-agent">
                  <span>{t.mockAgentLabel}</span>
                  <p>{t.mockAgentMessage}</p>
                  <div className="site-demo-tags">
                    {t.mockFields.map((field) => <span key={field}>{field}</span>)}
                  </div>
                </div>
              </div>
              <div className="site-route-row">
                <span>{t.mockRouteLabel}</span>
                <strong>{t.mockRouteValue}</strong>
              </div>
              <div className="site-owner-notice">
                <span>{t.mockOwnerLabel}</span>
                <strong>{t.mockOwnerValue}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-proof" id="product">
        <p>{t.proofIntro}</p>
        <dl>
          {t.proofItems.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="site-section site-problem">
        <div className="site-section-heading">
          <p className="site-eyebrow">{t.problemEyebrow}</p>
          <h2>{t.problemTitle}</h2>
          <p>{t.problemLead}</p>
        </div>
        <div className="site-comparison" role="table" aria-label={`${t.beforeLabel} / ${t.afterLabel}`}>
          <div className="site-comparison-head" role="row">
            <span role="columnheader">{t.beforeLabel}</span>
            <span role="columnheader">{t.afterLabel}</span>
          </div>
          {t.comparisons.map(([before, after]) => (
            <div className="site-comparison-row" role="row" key={before}>
              <span role="cell">{before}</span>
              <strong role="cell">{after}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="site-section site-process" id="how">
        <div className="site-process-intro">
          <p className="site-eyebrow">{t.howEyebrow}</p>
          <h2>{t.howTitle}</h2>
          <p>{t.howLead}</p>
        </div>
        <ol className="site-process-list">
          {t.steps.map((step) => (
            <li key={step.number}>
              <span className="site-step-number">{step.number}</span>
              <div className="site-step-copy">
                <span>{step.label}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
              <span className="site-step-signal">{step.signal}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="site-section site-cases" id="use-cases">
        <div className="site-section-heading site-section-heading-wide">
          <p className="site-eyebrow">{t.casesEyebrow}</p>
          <h2>{t.casesTitle}</h2>
          <p>{t.casesLead}</p>
        </div>
        <div className="site-case-list">
          {t.cases.map((useCase, index) => (
            <article key={useCase.audience}>
              <div className="site-case-persona">
                <span>0{index + 1}</span>
                <h3>{useCase.audience}</h3>
                <p>{useCase.descriptor}</p>
              </div>
              <blockquote>{useCase.inbound}</blockquote>
              <dl>
                <div><dt>Delegate</dt><dd>{useCase.handled}</dd></div>
                <div><dt>Owner</dt><dd>{useCase.handoff}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="site-section site-surfaces">
        <div className="site-section-heading site-section-heading-wide">
          <p className="site-eyebrow">{t.productEyebrow}</p>
          <h2>{t.productTitle}</h2>
          <p>{t.productLead}</p>
        </div>
        <div className="site-surface-grid">
          <article className="site-surface site-surface-public">
            <div className="site-surface-copy">
              <p className="site-kicker">{t.publicSurface.kicker}</p>
              <h3>{t.publicSurface.title}</h3>
              <p>{t.publicSurface.body}</p>
              <ul>{t.publicSurface.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
            </div>
            <div className="site-public-preview" aria-label={t.publicSurface.title}>
              <div><span className="site-demo-avatar">L</span><span><strong>Lin</strong><small>{t.publicSurface.profileLabel}</small></span></div>
              <p>{t.publicSurface.prompt}</p>
              <span className="site-preview-input">{t.publicSurface.input} <b>→</b></span>
              <dl><dt>{t.publicSurface.status}</dt><dd>{t.publicSurface.statusValue}</dd></dl>
            </div>
          </article>

          <article className="site-surface site-surface-owner">
            <div className="site-surface-copy">
              <p className="site-kicker">{t.ownerSurface.kicker}</p>
              <h3>{t.ownerSurface.title}</h3>
              <p>{t.ownerSurface.body}</p>
              <div className="site-owner-stat"><span>{t.ownerSurface.status}</span><strong>{t.ownerSurface.statusValue}</strong></div>
            </div>
            <div className="site-queue-preview" aria-label={t.ownerSurface.title}>
              <div className="site-queue-head"><span>{t.ownerSurface.queueLabel}</span><span>{t.ownerSurface.queueStatusLabel}</span></div>
              {t.ownerSurface.queue.map(([label, value], index) => (
                <div className="site-queue-row" key={label}>
                  <span><b>0{index + 1}</b>{label}</span><strong>{value}</strong>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="site-trust" id="trust">
        <div className="site-trust-copy">
          <p className="site-eyebrow">{t.trustEyebrow}</p>
          <h2>{t.trustTitle}</h2>
          <p>{t.trustLead}</p>
        </div>
        <dl className="site-trust-rules">
          {t.trustItems.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
        </dl>
        <p className="site-trust-note">{t.trustNote}</p>
      </section>

      <section className="site-section site-plans" id="plans">
        <div className="site-section-heading">
          <p className="site-eyebrow">{t.planEyebrow}</p>
          <h2>{t.planTitle}</h2>
          <p>{t.planLead}</p>
        </div>
        <div className="site-plan-list">
          {t.plans.map((plan) => (
            <article className={plan.primary ? "site-plan site-plan-featured" : "site-plan"} key={plan.name}>
              <div className="site-plan-title"><span>{plan.name}</span><p>{plan.summary}</p></div>
              <p className="site-plan-price"><strong>{plan.price}</strong><span>{plan.suffix}</span></p>
              <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              <a className={plan.primary ? "site-button site-button-primary" : "site-button site-button-secondary"} href={plan.primary ? setupHref : demoHref}>{plan.cta}</a>
            </article>
          ))}
        </div>
      </section>

      <section className="site-section site-faq" id="faq">
        <div className="site-section-heading">
          <p className="site-eyebrow">{t.faqEyebrow}</p>
          <h2>{t.faqTitle}</h2>
        </div>
        <div className="site-faq-list">
          {t.faqs.map(([question, answer], index) => (
            <details key={question} open={index === 0}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="site-final-cta">
        <div>
          <p className="site-eyebrow">{t.finalEyebrow}</p>
          <h2>{t.finalTitle}</h2>
          <p>{t.finalLead}</p>
        </div>
        <div className="site-actions">
          <a className="site-button site-button-light" href={setupHref}>{t.finalPrimary}</a>
          <a className="site-button site-button-ghost" href={demoHref}>{t.finalSecondary}</a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="site-footer-brand">
          <a className="site-brand" href="#top">
            <img src="/D_logo.svg" alt="" className="site-brand-mark" />
            <span><strong>Delegate</strong><small>{t.footerSummary}</small></span>
          </a>
          <span className="site-footer-status">{t.footerStatus}</span>
        </div>
        <div className="site-footer-links">
          <div><strong>{t.footerProduct}</strong><a href={demoHref}>{t.heroSecondary}</a><a href={dashboardHref}>{t.navLogin}</a></div>
          <div><strong>{t.footerResources}</strong>{t.footerLinks.map((label, index) => <a href={footerHrefs[index]} key={label}>{label}</a>)}</div>
        </div>
        <p className="site-copyright">© {new Date().getFullYear()} {t.footerCopyright}</p>
      </footer>
    </main>
  );
}

function buildCreatorAuthHref(
  dashboardBaseUrl: string,
  flow: "sign_in" | "register",
  returnTo: string,
  locale: "zh" | "en",
): string {
  const url = new URL("/auth/login", dashboardBaseUrl);
  url.searchParams.set("flow", flow);
  url.searchParams.set("returnTo", returnTo);
  url.searchParams.set("lang", locale);
  return url.toString();
}
