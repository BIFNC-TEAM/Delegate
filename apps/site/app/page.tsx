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
} from "@delegate/web-ui";

const copy = {
  zh: {
    brandTagline: "Web-first AI 接待前台与代理收益网络第一条数字代表楔子",
    menu: [
      { href: "#interface", label: "接口" },
      { href: "#trust", label: "信任" },
      { href: "#economy", label: "计费" },
      { href: "#control-plane", label: "控制台" },
      { href: "#roadmap", label: "路线" },
    ],
    navDemo: "演示代表页",
    navDashboard: "代表控制台",
    heroEyebrow: "数字代表网络",
    heroTitle: "你的 AI 替身，代表你向外界提供服务",
    heroLead:
      "替你接待陌生人、筛选商机、处理简单任务。你躺平的时候，它替你干活，为你赚取被动收入，只把该你出面的事留给你。",
    heroPrimary: "查看数字代表",
    heroSecondary: "进入控制台",
    shipsKicker: "AI 接待闭环",
    shipsTitle: "先回答，收费时收费，需要拍板时请示，需要人时转接。",
    shipsBody: "当前交付的是网页代表楔子和第一条钱包闭环：公开代表页、网页聊天、待处理收件项、演示充值、用户现金余额、服务额度、创作者 20% 待释放 / 可提现收益和钱包账本。真实 Stripe / 微信 / 支付宝收款、自动出金和透明证明仍是后续产品化工作。",
    frontDeskSteps: [
      { label: "01 / Answer", title: "能回答的先回答", body: "FAQ、公开资料、服务范围先由代表接住，不把主人拉回一级前台。" },
      { label: "02 / Charge", title: "该收费的先收费", body: "免费试聊后，深度服务、优先级和继续对话进入网页充值与 invoice 信号。" },
      { label: "03 / Ask", title: "需要拍板的先请示", body: "敏感动作、报价判断和不可逆动作进入审批，而不是让 AI 自作主张。" },
      { label: "04 / Human", title: "需要人时再转接", body: "转人工会变成待处理收件项，主人接手的是高价值上下文，不是原始噪音。" },
    ],
    proofPoints: [
      { stat: "10 秒", label: "陌生人应该在十秒内理解这不是闲聊 bot，而是一个公开代表入口。" },
      { stat: "70%+", label: "高频 inbound 询问应被代表独立接住，而不是重新把主人拉回一级前台。" },
      { stat: "1 钱包", label: "用户应该给具体 Agent 充值，而不是给平台泛泛充值；余额归属必须一眼看清。" },
    ],
    trustEyebrow: "Trust Boundary",
    trustTitle: "公开运行时必须先让人信任，再让人付费，最后才让人深入。",
    trustLead: "Delegate 的竞争力不是更多 tools，而是把陌生人关系、边界和升级路径讲清楚。",
    trustPills: ["仅公开知识", "仅安全技能", "内建人工转接", "动作可审计"],
    operatingAria: "运营节奏",
    operatingBeats: [
      { step: "01", title: "先接住第一次 inbound", body: "陌生人先被接住，才会继续问下去、付费、或者申请升级转接。" },
      { step: "02", title: "再把边界说清楚", body: "对方必须清楚这是公开代表，不是主人本人，也不是一个万能 bot。" },
      { step: "03", title: "把请求路由成流程", body: "FAQ、报价采集、预约和资料投递，都要能把模糊请求变成结构化入口。" },
      { step: "04", title: "用付费继续深入", body: "免费只负责接住，真正的深度服务和优先级要通过付费自然升级。" },
    ],
    interfaceColumns: [
      {
        eyebrow: "Public interface",
        title: "别人使用的是你的公开代表，不是进入你的私有运行时。",
        body: "它是 public-facing agent interface，不是 private assistant clone。外部人面对的是一个边界清晰、用途明确、可升级的业务接口。",
      },
      {
        eyebrow: "Bounded action",
        title: "代表知道什么、能做什么、不能做什么，都必须显式公开。",
        body: "公开知识包、许可技能、付费边界和转人工规则，组成一个可被陌生人快速理解的对外契约。",
      },
      {
        eyebrow: "Inbound operations",
        title: "价值不在会聊天，而在把 inbound 需求变成可路由、可计费、可接手的业务流。",
        body: "FAQ、报价采集、预约、资料投递和人工升级都不是附属功能，而是核心处理面。",
      },
    ],
    visibleContractEyebrow: "Visible contract",
    visibleContractTitle: "Trust 是产品表面，不是法律页脚。",
    visibleContractLead:
      "外部用户必须知道代表可以看什么、可以做什么、不能做什么，以及什么时候需要转人工或付费继续。",
    trustCards: [
      { title: "能看什么", points: ["仅公开知识包", "仅批准过的 FAQ / 资料 / 价格页", "不接触私有工作区与私有记忆"] },
      { title: "能做什么", points: ["回答 FAQ", "收集线索与需求", "发起付费解锁", "触发安全转人工"] },
      { title: "不能做什么", points: ["不能代表主人登录账户", "不能任意执行本地命令", "不能直接做不可逆商业承诺"] },
    ],
    economyEyebrow: "收益网络",
    economyTitle: "目标是把支付、计费、钱包、结算和透明账本拆成清晰层。",
    economyLead: "当前 Delegate 已交付内部钱包账本、演示充值、服务额度购买、服务消耗、创作者收益、提现冻结和主理人钱包视图；统一支付入口、真实支付验签、自动出金和公开证明是后续网络层。",
    economyPlans: [
      { name: "代表钱包", detail: "已用内部账本把用户现金、服务额度、创作者待释放 / 可提现收益、平台收入和成本拆开。", kicker: "已落地" },
      { name: "Payment Adapters", detail: "Mock provider 可跑通；Stripe 是 adapter 边界；微信支付和支付宝是 fail-closed 骨架，等待真实验签与 SDK 接入。", kicker: "适配器" },
      { name: "计费引擎", detail: "已支持服务额度购买和消耗计费；接入所有回复、敏感动作、浏览器和外部工具路径仍是后续工作。", kicker: "部分落地" },
      { name: "结算 + 账本", detail: "已生成创作者 20% 待释放收益、按消耗释放可提现金额，并支持提现冻结；自动打款和公开证明还未落地。", kicker: "结算" },
    ],
    controlEyebrow: "Control Plane",
    controlTitle: "Dashboard 应该像运营台，而不是设置坟场。",
    controlLead: "控制面板的顺序就是产品价值的顺序：先运营，再发布，再扩展，再治理记忆。",
    controlCards: [
      { eyebrow: "概览", title: "先看待处理请求、付款和今天的运营脉冲。", body: "控制台第一屏应该帮助主人判断什么值得亲自接手，而不是展开一堆配置项。" },
      { eyebrow: "代表", title: "发布一个公开代表，本质上是在发布一套外部关系接口。", body: "身份、契约、定价、知识包和分步设置需要像发布流程，而不是杂乱表单。" },
      { eyebrow: "记忆 + 技能", title: "技能和记忆属于扩展层，应该被治理，而不是被神化。", body: "代表能力要进入可观测面板，记忆要能看到来源，技能要进入边界控制。" },
    ],
    roadmapEyebrow: "Evolution",
    roadmapTitle: "Delegate 先做数字代表，再走向更大的代理收益网络。",
    roadmapLead: "产品路径是：先有可靠在线接待，再有公开数字代表，最后扩成代理收益网络。",
    roadmapStages: [
      { eyebrow: "Reference wedge", title: "Delegate Web", body: "公开数字代表页、trust boundary、网页聊天、充值预览和 human escalation 先形成第一条 web 交易闭环。" },
      { eyebrow: "钱包闭环", title: "先把内部账本记清楚", body: "先把用户钱包、代表钱包、创作者收益、服务成本和平台收入在 Delegate 内部记清楚。" },
      { eyebrow: "Network future", title: "Payment and proof", body: "下一步再接真实 Stripe / 微信 / 支付宝验签、自动出金、chargeback 自动化和公开证明。" },
    ],
    ctaEyebrow: "开始体验",
    ctaTitle: "先把一个数字代表跑通，再把钱包、计费、结算和透明度扩成收益网络。",
    ctaPrimary: "查看演示数字代表",
    ctaSecondary: "配置一个代表",
    switcher: { zh: "中文", en: "English" },
  },
  en: {
    brandTagline: "Web-first AI front desk and the first digital representative wedge",
    menu: [
      { href: "#interface", label: "Interface" },
      { href: "#trust", label: "Trust" },
      { href: "#economy", label: "Money" },
      { href: "#control-plane", label: "Console" },
      { href: "#roadmap", label: "Roadmap" },
    ],
    navDemo: "Demo digital rep",
    navDashboard: "Representative console",
    heroEyebrow: "Digital Representative Network",
    heroTitle: "Your AI double represents you and serves the outside world.",
    heroLead:
      "It greets strangers, qualifies business opportunities, and handles simple tasks for you. While you rest, it works for you, earns passive income, and leaves only the moments that truly need you.",
    heroPrimary: "Explore digital representative",
    heroSecondary: "Open control plane",
    shipsKicker: "AI front desk loop",
    shipsTitle: "Answer first, charge when needed, ask for approval, hand off to a human.",
    shipsBody: "What ships today is the web representative wedge plus the first wallet loop: public representative page, web chat, follow-up queue, demo recharge, user cash balance, service credits, creator 20% pending / withdrawable earnings, and wallet ledger entries. Live Stripe / WeChat / Alipay collection, automatic payout, and public proof remain productization work.",
    frontDeskSteps: [
      { label: "01 / Answer", title: "Answer what it can", body: "FAQs, public materials, and service boundaries are handled before the owner gets pulled back to the front desk." },
      { label: "02 / Charge", title: "Charge when needed", body: "After the free reception layer, deeper help and priority move into web recharge and invoice signals." },
      { label: "03 / Ask", title: "Ask for approval", body: "Sensitive actions, quote judgment, and irreversible steps move through approval instead of AI improvisation." },
      { label: "04 / Human", title: "Hand off with context", body: "Human follow-up becomes a clear queue item, so the person receives high-value context rather than raw noise." },
    ],
    proofPoints: [
      { stat: "10s", label: "A stranger should understand within ten seconds that this is a public representative, not a generic chat bot." },
      { stat: "70%+", label: "The representative should absorb most repetitive inbound questions without pulling the founder back to the front desk." },
      { stat: "1 wallet", label: "Users should recharge a specific Agent, not the platform in general; balance ownership has to be visible." },
    ],
    trustEyebrow: "Trust Boundary",
    trustTitle: "A public runtime must earn trust first, charge second, and deepen the relationship third.",
    trustLead: "Delegate wins by making boundaries, escalation paths, and relationship rules obvious to strangers.",
    trustPills: ["Public knowledge only", "Bounded skills only", "Human follow-up built in", "Auditable actions"],
    operatingAria: "Operating rhythm",
    operatingBeats: [
      { step: "01", title: "Catch the first inbound", body: "The stranger has to feel received before they will keep asking, pay, or request escalation." },
      { step: "02", title: "Show the boundary", body: "People should know immediately that this is a public representative, not the owner and not an unlimited bot." },
      { step: "03", title: "Route the request", body: "FAQ, quote intake, scheduling, and materials delivery should turn vague demand into structured motion." },
      { step: "04", title: "Continue with payment", body: "Free gets the relationship started; deeper help and priority should unlock naturally through payment." },
    ],
    interfaceColumns: [
      {
        eyebrow: "Public interface",
        title: "People interact with your representative, not your private runtime.",
        body: "This is a public-facing agent interface, not a private assistant clone. The outside world sees a bounded, legible, business-facing surface.",
      },
      {
        eyebrow: "Bounded action",
        title: "What the representative knows, can do, and cannot do should be explicitly visible.",
        body: "Public knowledge packs, allowed skills, pricing boundaries, and human follow-up rules together form a contract strangers can understand quickly.",
      },
      {
        eyebrow: "Inbound operations",
        title: "The real value is not chatting. It is routing inbound demand into billable, triageable business flow.",
        body: "FAQ, quote intake, scheduling, materials delivery, and escalation are the product, not side features.",
      },
    ],
    visibleContractEyebrow: "Visible contract",
    visibleContractTitle: "Trust is a product surface, not a legal footnote.",
    visibleContractLead:
      "External users should see what the representative can access, what it can do, what it will refuse, and when payment or human escalation begins.",
    trustCards: [
      { title: "Can see", points: ["Public knowledge pack only", "Approved FAQs, materials, and pricing only", "No private workspace or private memory"] },
      { title: "Can do", points: ["Answer FAQs", "Collect leads and structured demand", "Trigger paid continuation", "Create safe follow-up requests"] },
      { title: "Cannot do", points: ["Log into owner accounts", "Run arbitrary local commands", "Make irreversible commercial commitments"] },
    ],
    economyEyebrow: "Money layer",
    economyTitle: "The network separates payment, billing, wallet, settlement, and transparent ledger into legible layers.",
    economyLead: "Delegate now ships the internal wallet ledger, demo recharge, service credit purchase, usage charge, creator earning, withdrawal freeze, and creator wallet view. Unified payment entry, live payment verification, automatic payout, and public proof remain future network layers.",
    economyPlans: [
      { name: "Representative Wallet", detail: "Delegate now separates user cash, service credits, creator pending / withdrawable balances, platform revenue, and provider cost in its own ledger.", kicker: "Shipped" },
      { name: "Payment Adapters", detail: "Mock provider runs end to end; Stripe has an adapter boundary; WeChat Pay and Alipay are fail-closed skeletons waiting for real SDK/signature wiring.", kicker: "Adapters" },
      { name: "Billing Engine", detail: "Service credit purchase and usage charge services exist; wiring every reply, sensitive action, browser, and external-tool path into billing is next.", kicker: "Partial" },
      { name: "Settlement + Ledger", detail: "Creator 20% pending, consumption-based withdrawable release, and WithdrawRequest freeze are in place; automatic payout and public proof are not.", kicker: "Settlement" },
    ],
    controlEyebrow: "Control Plane",
    controlTitle: "The dashboard should feel like an operations desk, not a settings graveyard.",
    controlLead: "The order of the dashboard should mirror product value: operate first, publish second, expand third, govern memory last.",
    controlCards: [
      { eyebrow: "Overview", title: "Start with follow-up requests, payments, and today’s operating pulse.", body: "The first screen should help a human decide what deserves direct attention, not dump a wall of settings." },
      { eyebrow: "Representative", title: "Publishing a representative means publishing a relationship interface.", body: "Identity, contract, pricing, knowledge, and settings should feel like a launch flow, not a messy back-office form." },
      { eyebrow: "Memory + skills", title: "Skills and memory are expansion layers that need governance, not mystique.", body: "Skill sources belong in boundary control and memory belongs in visible provenance, not hidden magic." },
    ],
    roadmapEyebrow: "Evolution",
    roadmapTitle: "Delegate starts with a Digital Representative, then grows into a broader revenue network.",
    roadmapLead: "The product path is `Agent Runtime -> Digital Representative -> Agent Monetization Network`.",
    roadmapStages: [
      { eyebrow: "Reference wedge", title: "Delegate Web", body: "A public Digital Representative page with trust boundaries, web chat, recharge preview, and human escalation proves the first web transaction loop." },
      { eyebrow: "Wallet loop", title: "Internal ledger first", body: "Make user wallet, representative wallet, creator earning, provider cost, and platform revenue correct inside Delegate before outsourcing money movement." },
      { eyebrow: "Network future", title: "Payment and proof", body: "Next comes live Stripe / WeChat / Alipay verification, automatic payout, chargeback automation, and public proof." },
    ],
    ctaEyebrow: "Try the loop",
    ctaTitle: "Start with one Digital Representative, then scale wallet, billing, settlement, and transparency into the revenue network.",
    ctaPrimary: "See demo digital rep",
    ctaSecondary: "Configure a representative",
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
  const representativeBaseUrl = resolveServiceUrl(
    process.env.NEXT_PUBLIC_REPRESENTATIVE_URL,
    "http://localhost:3002",
    {
      currentAppDefaultPort: 3000,
      currentHost,
    },
  );
  const dashboardBaseUrl = resolveServiceUrl(
    process.env.NEXT_PUBLIC_DASHBOARD_URL,
    "http://localhost:3001",
    {
      currentAppDefaultPort: 3000,
      currentHost,
    },
  );

  return (
    <main className="marketing-shell localized-shell" data-locale={locale} lang={locale === "zh" ? "zh-CN" : "en"}>
      <HashScrollRestorer />
      <header className="marketing-topbar">
        <div className="marketing-brand">
          <div className="marketing-brand-mark">D</div>
          <div>
            <strong>Delegate</strong>
            <div className="muted">{t.brandTagline}</div>
          </div>
        </div>

        <nav aria-label="Website sections" className="marketing-menu-tabs">
          {t.menu.map((item) => (
            <a className="marketing-menu-tab" href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="marketing-nav-actions">
          <LanguageSwitcher
            activeLocale={locale}
            ariaLabel="Language"
            items={[
              { locale: "zh", href: buildLocalizedHref("/", "zh"), label: t.switcher.zh, shortLabel: "ZH" },
              { locale: "en", href: buildLocalizedHref("/", "en"), label: t.switcher.en, shortLabel: "EN" },
            ]}
          />
          <a
            className="marketing-nav-link"
            href={buildLocalizedHref(`${representativeBaseUrl}/reps/${demoRepresentative.slug}`, locale)}
          >
            {t.navDemo}
          </a>
          <a
            className="marketing-button-primary"
            href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?view=overview`, locale)}
          >
            {t.navDashboard}
          </a>
        </div>
      </header>

      <section className="marketing-hero" id="interface">
        <div className="marketing-hero-copy">
          <div className="marketing-hero-badge-row">
            <p className="eyebrow">{t.heroEyebrow}</p>
            <span className="marketing-runtime-badge">{t.shipsKicker}</span>
          </div>
          <h1>{t.heroTitle}</h1>
          <p className="marketing-lead">{t.heroLead}</p>

          <div className="marketing-actions">
            <a
              className="marketing-button-primary"
              href={buildLocalizedHref(`${representativeBaseUrl}/reps/${demoRepresentative.slug}`, locale)}
            >
              {t.heroPrimary}
            </a>
            <a
              className="marketing-button-secondary"
              href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?view=overview`, locale)}
            >
              {t.heroSecondary}
            </a>
          </div>

          <div className="marketing-proof-row" aria-label={t.shipsKicker}>
            {t.proofPoints.map((point) => (
              <article className="marketing-proof-pill" key={point.stat}>
                <strong>{point.stat}</strong>
                <span>{point.label}</span>
              </article>
            ))}
          </div>
        </div>

        <div className="marketing-stage">
          <article className="marketing-runtime-card">
            <div className="marketing-code-window">
              <div className="marketing-code-bar" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="marketing-code-heading">
                <span>delegate.frontdesk.ts</span>
                <strong>{t.economyPlans[0].name}</strong>
              </div>
              <pre>{`await delegate.route({
  inbound: ["web", "telegram", "feishu"],
  firstPass: "answer",
  paidDepth: "service_credits",
  approval: "review_queue",
  humanFollowUp: "with_context"
});`}</pre>
            </div>

            <div className="marketing-front-desk-flow">
              {t.frontDeskSteps.map((step) => (
                <div className="marketing-front-desk-step" key={step.label}>
                  <span>{step.label}</span>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="marketing-product-band">
        <div className="marketing-product-copy">
          <p className="marketing-card-kicker">{t.shipsKicker}</p>
          <h2>{t.shipsTitle}</h2>
          <p>{t.shipsBody}</p>
        </div>

        <div className="marketing-product-grid">
          {t.interfaceColumns.map((column) => (
            <article className="marketing-product-card" key={column.title}>
              <p className="marketing-card-kicker">{column.eyebrow}</p>
              <h3>{column.title}</h3>
              <p>{column.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-band" id="trust">
        <div className="marketing-band-copy">
          <p className="eyebrow">{t.trustEyebrow}</p>
          <h2>{t.trustTitle}</h2>
          <p>{t.trustLead}</p>
        </div>
        <div className="marketing-band-chips">
          {t.trustPills.map((pill) => (
            <span className="marketing-pill" key={pill}>
              {pill}
            </span>
          ))}
        </div>
      </section>

      <section aria-label={t.operatingAria} className="marketing-rhythm-strip">
        {t.operatingBeats.map((beat) => (
          <article className="marketing-beat-card" key={beat.step}>
            <span className="marketing-beat-step">{beat.step}</span>
            <h3>{beat.title}</h3>
            <p>{beat.body}</p>
          </article>
        ))}
      </section>

      <section className="marketing-story marketing-story-shell">
        <div className="marketing-story-copy">
          <p className="eyebrow">{t.visibleContractEyebrow}</p>
          <h2>{t.visibleContractTitle}</h2>
          <p>{t.visibleContractLead}</p>
        </div>

        <div className="marketing-story-list">
          {t.trustCards.map((card) => (
            <article className="marketing-story-item" key={card.title}>
              <h3>{card.title}</h3>
              <ul className="marketing-bullet-list">
                {card.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section marketing-section-shell marketing-section-shell-economy" id="economy">
        <div className="marketing-section-heading">
          <div>
            <p className="eyebrow">{t.economyEyebrow}</p>
            <h2>{t.economyTitle}</h2>
          </div>
          <p className="marketing-lead">{t.economyLead}</p>
        </div>

        <div className="marketing-plan-grid">
          {t.economyPlans.map((plan) => (
            <article className="marketing-plan-card" key={plan.name}>
              <p className="marketing-card-kicker">{plan.kicker}</p>
              <h3>{plan.name}</h3>
              <p>{plan.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section marketing-section-shell marketing-section-shell-control" id="control-plane">
        <div className="marketing-section-heading">
          <div>
            <p className="eyebrow">{t.controlEyebrow}</p>
            <h2>{t.controlTitle}</h2>
          </div>
          <p className="marketing-lead">{t.controlLead}</p>
        </div>

        <div className="marketing-control-layout">
          <article className="marketing-console-card">
            <div className="marketing-console-row">
              <span>{t.controlCards[0].eyebrow}</span>
              <strong>{t.controlCards[0].title}</strong>
            </div>
            <div className="marketing-console-meter">
              <span />
            </div>
            <div className="marketing-console-row">
              <span>{t.economyPlans[2].name}</span>
              <strong>{t.economyPlans[2].kicker}</strong>
            </div>
            <div className="marketing-console-stack">
              {t.trustPills.map((pill) => (
                <span key={pill}>{pill}</span>
              ))}
            </div>
          </article>

          <div className="marketing-ops-grid">
            {t.controlCards.map((card) => (
              <article className="marketing-feature-card" key={card.title}>
                <p className="marketing-card-kicker">{card.eyebrow}</p>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section-shell marketing-section-shell-roadmap" id="roadmap">
        <div className="marketing-section-heading">
          <div>
            <p className="eyebrow">{t.roadmapEyebrow}</p>
            <h2>{t.roadmapTitle}</h2>
          </div>
          <p className="marketing-lead">{t.roadmapLead}</p>
        </div>

        <div className="marketing-roadmap-grid">
          {t.roadmapStages.map((stage) => (
            <article className="marketing-roadmap-card" key={stage.title}>
              <p className="marketing-card-kicker">{stage.eyebrow}</p>
              <h3>{stage.title}</h3>
              <p>{stage.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-cta">
        <div>
          <p className="eyebrow">{t.ctaEyebrow}</p>
          <h2>{t.ctaTitle}</h2>
        </div>
        <div className="marketing-actions">
          <a
            className="marketing-button-primary"
            href={buildLocalizedHref(`${representativeBaseUrl}/reps/${demoRepresentative.slug}`, locale)}
          >
            {t.ctaPrimary}
          </a>
          <a
            className="marketing-button-secondary"
            href={buildLocalizedHref(`${dashboardBaseUrl}/dashboard?view=setup`, locale)}
          >
            {t.ctaSecondary}
          </a>
        </div>
      </section>
    </main>
  );
}
