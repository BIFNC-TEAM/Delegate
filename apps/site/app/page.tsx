import { headers } from "next/headers";
import { demoRepresentative } from "@delegate/domain";
import {
  HashScrollRestorer,
  buildLocalizedHref,
  extractCountryHint,
  resolveLocale,
  resolveServiceUrl,
} from "@delegate/web-ui";
import { SiteSessionProvider, SiteCreationLink } from "./site-session";
import { SiteAccountNavigation } from "./site-account-navigation";
import { copyFor, marketingMenu } from "./marketing-copy";
import { HeroDemo } from "./hero-demo";
import { ServiceNetwork } from "./service-network";
import { ServiceJourney } from "./service-journey";
import { CreationGuide } from "./creation-guide";
import { PolicyDocuments } from "./policy-documents";
import { SiteSectionNavigation } from "./site-section-navigation";

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
  const t = copyFor(locale);
  const currentHost =
    headerStore.get("x-forwarded-host") ?? headerStore.get("host");
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
  const selfServiceRegistrationEnabled =
    process.env.DELEGATE_CREATOR_ADMISSION_MODE?.trim().toLowerCase() ===
    "self_service";
  const demoHref = buildLocalizedHref(
    `${representativeBaseUrl}/reps/${demoRepresentative.slug}`,
    locale,
  );
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
  const representativesHref = buildLocalizedHref(
    `${dashboardBaseUrl}/dashboard?view=representatives&repSection=directory`,
    locale,
  );
  const unifiedAuthEnabled =
    process.env.DELEGATE_UNIFIED_AUTH_ENABLED === "true";
  const signupHref =
    selfServiceRegistrationEnabled && !unifiedAuthEnabled
      ? buildCreatorAuthHref(
          dashboardBaseUrl,
          "register",
          buildLocalizedHref("/dashboard?view=overview", locale),
          locale,
        )
      : null;
  const menu = marketingMenu(locale);
  const faqs =
    locale === "zh"
      ? [
          [
            "创建对外代理，需要会写代码吗？",
            "创建流程通过页面配置完成。你可以填写身份与服务介绍、添加知识资料，并设置相应的收费和运行规则。",
          ],
          [
            "需要准备哪些资料？",
            "可以先准备自己的身份介绍、服务范围和常见问题。按需添加文件、网页或手工知识，为对外代理的回答提供依据；不必一次填满所有内容。",
          ],
          [
            "谁可以向我的对外代理充值？",
            "访问你的对外代理且符合其访问和交易条件的用户，可以按你提供的套餐充值。对方也可以拥有自己的对外代理，提供自己的服务。",
          ],
          [
            "服务价格由谁设置？",
            "创建者在开放的配置范围内设置自己的服务套餐。金额、额度、人工服务权益及相关使用规则，应在购买前清楚展示。",
          ],
          [
            "对外代理回答不了时怎么办？",
            "需要本人判断的事项可以申请人工接管。是否支持、适用条件与处理安排，以该对外代理说明的服务规则为准；申请不等于真人已立即接手。",
          ],
          [
            "发布后能否修改或暂停？",
            "可以通过工作台更新配置、管理发布版本或调整渠道状态。不同设置的生效方式以页面说明为准；暂停服务前应处理尚未完成的服务和用户权益。",
          ],
        ]
      : [
          [
            "Do I need to code to create a representative?",
            "No. Configure your identity and services, add knowledge, and set pricing and operating rules through the dashboard.",
          ],
          [
            "What should I prepare?",
            "Start with an introduction, your service scope, and frequently asked questions. Add files, web pages, or written knowledge as needed. You do not need everything ready at once.",
          ],
          [
            "Who can top up my representative?",
            "Visitors who meet your representative’s access and purchase requirements can buy your service plans. They can also operate a representative of their own.",
          ],
          [
            "Who sets the service prices?",
            "Creators configure their plans within the available options. Prices, credits, human support entitlements, and usage conditions should be clear before purchase.",
          ],
          [
            "What happens when the AI cannot answer?",
            "Visitors can request human help for decisions that require you. Availability and conditions depend on the representative’s service rules. A request does not mean a person has already taken over.",
          ],
          [
            "Can I update or pause after publishing?",
            "Use the dashboard to update configuration, manage published versions, and adjust channels. Follow each setting’s activation rules, and handle outstanding services and entitlements before pausing.",
          ],
        ];

  return (
    <SiteSessionProvider dashboardBaseUrl={dashboardBaseUrl}>
      <div
        className="marketing-site"
        lang={locale === "zh" ? "zh-CN" : "en"}
        data-locale={locale}
      >
        <HashScrollRestorer />
        <a className="skip-link" href="#main">
          {t("跳至正文", "Skip to content")}
        </a>
        <header className="site-header">
          <div className="nav-shell">
            <div className="nav-brand">
              <a
                className="brand"
                href="#top"
                aria-label={t("Delegate 首页", "Delegate home")}
              >
                <span className="brand-mark" aria-hidden="true">
                  D
                </span>
                Delegate
                <span className="brand-label">
                  {t("对外代理", "Your representative")}
                </span>
              </a>
              <span className="nav-beta">{t("内测中", "BETA")}</span>
            </div>
            <SiteSectionNavigation locale={locale} />
            <div className="nav-actions">
              <SiteAccountNavigation
                activeLocale={locale}
                dashboardBaseUrl={dashboardBaseUrl}
                loginHref={dashboardHref}
                registerHref={setupHref}
                registerLabel={t("创建对外代理", "Create yours")}
                signupHref={signupHref}
                siteReturnTo={buildLocalizedHref("/", locale)}
                menu={menu}
                copy={{
                  languageAriaLabel: t("语言", "Language"),
                  menuLabel: t("菜单", "Menu"),
                  login: unifiedAuthEnabled
                    ? t("登录 / 注册", "Log in / Sign up")
                    : t("登录", "Log in"),
                  signup: t("注册", "Sign up"),
                  checking: t("正在确认账号…", "Checking account…"),
                  unavailable: t(
                    "账号状态暂不可用",
                    "Account status unavailable",
                  ),
                  retry: t("重试", "Retry"),
                  accountFallback: t("已登录账号", "Your account"),
                  accountMenuLabel: t("打开账号菜单", "Open account menu"),
                  console: t("前往控制台", "Dashboard"),
                  representatives: t("我的对外代理", "My representatives"),
                  settings: t("用户设置", "Settings"),
                  signOut: t("退出登录", "Sign out"),
                  zh: "中文",
                  en: "English",
                }}
              />
            </div>
          </div>
        </header>
        <main id="main">
          <section className="hero section-wrap" id="top">
            <div className="hero-copy">
              <div className="beta-announcement">
                <span className="beta-beacon" aria-hidden="true" />
                <span>{t("内测中", "PRIVATE BETA")}</span>
              </div>
              <h1>
                {t("你的 AI 替身，", "Your AI counterpart.")}
                <br />
                {t("代表你向外界", "Representing you. ")}
                <span>{t("提供服务", "Delivering services.")}</span>
              </h1>
              <p className="hero-description">
                {t(
                  "替你接待陌生人、筛选商机、处理简单任务。你躺平的时候，它替你干活，为你赚取被动收入，只把该你出面的事留给你。",
                  "Welcome new contacts, qualify opportunities, and handle everyday requests. Your representative works while you take a break, offering paid services and bringing you in when your judgment matters.",
                )}
              </p>
              <div className="button-row">
                <SiteCreationLink
                  href={setupHref}
                  signedInHref={representativesHref}
                  locale={locale}
                >
                  {t("创建我的对外代理", "Create my representative")}
                </SiteCreationLink>
                <a className="button secondary" href={demoHref}>
                  {t("体验一个对外代理", "Try a representative")}
                </a>
              </div>
            </div>
            <HeroDemo locale={locale} />
          </section>
          <ServiceNetwork locale={locale} />
          <ServiceJourney locale={locale} />
          <CreationGuide
            locale={locale}
            setupHref={setupHref}
            representativesHref={representativesHref}
          />
          <section className="faq-section section-wrap" id="faq">
            <div className="section-heading">
              <p className="eyebrow">{t("04 / 常见问题", "04 / QUESTIONS")}</p>
              <h2>
                {t("开始之前，", "Before you start,")}
                <br />
                {t("你可能还想知道。", "a few things to know.")}
              </h2>
            </div>
            <div className="faq-list">
              {faqs.map(([question, answer], i) => (
                <details key={question} open={i === 0}>
                  <summary>
                    {question}
                    <span />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </section>
        </main>
        <footer className="site-footer section-wrap">
          <div>
            <a className="brand" href="#top">
              <span className="brand-mark" aria-hidden="true">
                D
              </span>
              Delegate
            </a>
            <p>
              {t(
                "对外代理，让专业能力与世界连接。",
                "Connect your expertise with the world.",
              )}
            </p>
          </div>
          <div className="footer-links">
            <PolicyDocuments locale={locale} />
            <a href={demoHref}>{t("咨询产品", "Ask about Delegate")}</a>
            <span>© {new Date().getFullYear()} Delegate</span>
          </div>
        </footer>
      </div>
    </SiteSessionProvider>
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
