import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getPublicRepresentativeRuntime,
  resolvePublicAudiencePrincipal,
} from "@delegate/web-data";
import {
  LanguageSwitcher,
  buildLocalizedHref,
  extractCountryHint,
  pickCopy,
  resolveLocale,
  type Locale,
} from "@delegate/web-ui";

import {
  buildPublicAudienceLoginHref,
  buildPublicAudienceLogoutHref,
} from "../public-auth";
import { resolvePublicAudienceVerifiedAuthContext } from "../public-principal";

export const metadata: Metadata = {
  title: "Account settings · Delegate",
  robots: { index: false, follow: false },
};

export default async function RepresentativeAccountSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lang?: string; source?: string }>;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : undefined;
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
  const locale = resolveLocale({
    requestedLocale: query?.lang,
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });
  const t = pickCopy(locale, copy);
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") notFound();

  const audienceSession = await resolveAudienceSession(cookieStore);
  const preserveTelegramSource = query?.source === "telegram";
  const representativePath = preserveTelegramSource
    ? `/reps/${slug}?source=telegram`
    : `/reps/${slug}`;
  const settingsPath = preserveTelegramSource
    ? `/reps/${slug}/settings?source=telegram`
    : `/reps/${slug}/settings`;
  const representativeHref = buildLocalizedHref(representativePath, locale);
  const languageItems = [
    {
      locale: "zh" as const,
      href: buildLocalizedHref(settingsPath, "zh"),
      label: t.language.zh,
      shortLabel: "ZH",
    },
    {
      locale: "en" as const,
      href: buildLocalizedHref(settingsPath, "en"),
      label: t.language.en,
      shortLabel: "EN",
    },
  ];
  const loginHref = buildPublicAudienceLoginHref(slug, locale, "settings");
  const logoutHref = buildPublicAudienceLogoutHref(slug, locale);
  const accountEmail = audienceSession?.email?.trim() || null;

  return (
    <main
      className="marketing-shell representative-shell representative-account-settings-shell localized-shell"
      data-locale={locale}
      lang={locale === "zh" ? "zh-CN" : "en"}
    >
      <header className="marketing-topbar representative-topbar representative-settings-topbar">
        <div className="marketing-brand">
          <a
            aria-label={t.backToRepresentative(runtime.setup.name)}
            className="representative-brand-home"
            href={representativeHref}
          >
            <img className="marketing-brand-mark" src="/D_logo.svg" alt="" />
          </a>
          <div className="representative-topbar-identity">
            <strong>Delegate</strong>
            <div className="muted">{t.accountCenter}</div>
          </div>
        </div>
        <span aria-hidden="true" className="representative-topbar-spacer" />
        <a className="representative-settings-return" href={representativeHref}>
          <span aria-hidden="true">←</span>
          {t.backToRepresentative(runtime.setup.name)}
        </a>
      </header>

      <section className="representative-settings-workspace">
        <header className="representative-settings-heading">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1>{t.pageTitle}</h1>
          <p>{t.pageDescription}</p>
        </header>

        <div className="representative-settings-layout">
          <aside className="representative-settings-sidebar">
            <nav aria-label={t.navigationLabel}>
              <a href="#profile">
                <span>01</span>
                {t.profileNavigation}
              </a>
              <a href="#language">
                <span>02</span>
                {t.languageNavigation}
              </a>
            </nav>
            <p>{t.futureModulesNote}</p>
          </aside>

          <div className="representative-settings-content">
            <article className="representative-settings-card" id="profile">
              <header>
                <div>
                  <span className="eyebrow">{t.profileEyebrow}</span>
                  <h2>{t.profileTitle}</h2>
                </div>
                <span className={`representative-settings-status${audienceSession ? " is-active" : ""}`}>
                  {audienceSession ? t.signedIn : t.signedOut}
                </span>
              </header>
              <p className="representative-settings-card-description">
                {audienceSession ? t.profileDescription : t.guestProfileDescription}
              </p>

              {audienceSession ? (
                <>
                  <div className="representative-settings-profile-summary">
                    <span aria-hidden="true" className="representative-settings-profile-avatar">
                      {getAccountInitial(accountEmail, locale)}
                    </span>
                    <div>
                      <strong>{t.accountName}</strong>
                      <span>{accountEmail ?? t.emailUnavailable}</span>
                    </div>
                  </div>
                  <dl className="representative-settings-facts">
                    <div>
                      <dt>{t.emailLabel}</dt>
                      <dd>{accountEmail ?? t.emailUnavailable}</dd>
                    </div>
                    <div>
                      <dt>{t.identitySourceLabel}</dt>
                      <dd>{t.identitySourceValue}</dd>
                    </div>
                  </dl>
                  <div className="representative-settings-actions">
                    <span
                      aria-disabled="true"
                      className="representative-settings-edit-disabled"
                    >
                      {t.editProfile}
                      <small>{t.comingSoon}</small>
                    </span>
                    <a className="representative-settings-logout" href={logoutHref}>
                      {t.logout}
                    </a>
                  </div>
                </>
              ) : (
                <div className="representative-settings-guest-callout">
                  <p>{t.loginPrompt}</p>
                  <a href={loginHref}>{t.login}</a>
                </div>
              )}
            </article>

            <article className="representative-settings-card" id="language">
              <header>
                <div>
                  <span className="eyebrow">{t.languageEyebrow}</span>
                  <h2>{t.languageTitle}</h2>
                </div>
              </header>
              <p className="representative-settings-card-description">
                {t.languageDescription}
              </p>
              <div className="representative-settings-language-control">
                <span>{t.currentLanguage}</span>
                <LanguageSwitcher
                  activeLocale={locale}
                  ariaLabel={t.languageAriaLabel}
                  items={languageItems}
                />
              </div>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}

async function resolveAudienceSession(cookieStore: {
  get(name: string): { value: string } | undefined;
}): Promise<
  Awaited<ReturnType<typeof resolvePublicAudienceVerifiedAuthContext>>["session"]
> {
  let session: Awaited<
    ReturnType<typeof resolvePublicAudienceVerifiedAuthContext>
  >["session"] = null;
  try {
    session = (
      await resolvePublicAudienceVerifiedAuthContext({ cookieStore })
    ).session;
  } catch {
    return null;
  }
  if (
    session?.actor !== "audience"
    || !session.audienceIdentityId
    || !session.audienceId
  ) {
    return null;
  }

  try {
    await resolvePublicAudiencePrincipal({
      audienceId: session.audienceId,
      verifiedAuthSession: session,
    });
    return session;
  } catch {
    return null;
  }
}

function getAccountInitial(email: string | null, locale: Locale): string {
  const initial = email?.trim().charAt(0);
  return initial ? initial.toUpperCase() : locale === "zh" ? "我" : "ME";
}

const copy = {
  zh: {
    accountCenter: "账户中心",
    eyebrow: "账户设置",
    pageTitle: "管理你的 Delegate 账户",
    pageDescription: "在一个可扩展的独立页面中管理账户资料、界面偏好，以及后续接入的安全和通知能力。",
    navigationLabel: "设置分区",
    profileNavigation: "账户资料",
    languageNavigation: "界面语言",
    futureModulesNote: "后续的安全、通知和隐私设置会继续加入这里。",
    profileEyebrow: "Profile",
    profileTitle: "账户资料",
    profileDescription: "查看当前登录身份。资料编辑能力将在账户资料服务接入后开放。",
    guestProfileDescription: "登录后可在这里查看账户资料，并在后续版本中进行修改。",
    signedIn: "已登录",
    signedOut: "未登录",
    accountName: "我的账户",
    emailLabel: "登录邮箱",
    emailUnavailable: "暂未提供邮箱",
    identitySourceLabel: "身份来源",
    identitySourceValue: "Delegate 登录账户",
    editProfile: "编辑资料",
    comingSoon: "即将开放",
    logout: "退出登录",
    loginPrompt: "登录 Delegate 账户后，可以查看账户资料并保留你的界面偏好。",
    login: "登录 / 注册",
    languageEyebrow: "Language",
    languageTitle: "界面语言",
    languageDescription: "选择对外代理页面和账户设置使用的显示语言。",
    currentLanguage: "显示语言",
    languageAriaLabel: "切换界面语言",
    language: { zh: "中文", en: "English" },
    backToRepresentative: (name: string) => `返回 ${name}`,
  },
  en: {
    accountCenter: "Account center",
    eyebrow: "Account settings",
    pageTitle: "Manage your Delegate account",
    pageDescription: "Manage profile information and interface preferences in one extensible page, with room for security and notification settings.",
    navigationLabel: "Settings sections",
    profileNavigation: "Account profile",
    languageNavigation: "Interface language",
    futureModulesNote: "Security, notification, and privacy settings can be added here next.",
    profileEyebrow: "Profile",
    profileTitle: "Account profile",
    profileDescription: "Review the current sign-in identity. Editing will become available after the account profile service is connected.",
    guestProfileDescription: "Sign in to review account information and edit it in a future release.",
    signedIn: "Signed in",
    signedOut: "Signed out",
    accountName: "My account",
    emailLabel: "Sign-in email",
    emailUnavailable: "Email unavailable",
    identitySourceLabel: "Identity source",
    identitySourceValue: "Delegate sign-in account",
    editProfile: "Edit profile",
    comingSoon: "Coming soon",
    logout: "Log out",
    loginPrompt: "Sign in to review your Delegate account information and keep your interface preference.",
    login: "Log in / Sign up",
    languageEyebrow: "Language",
    languageTitle: "Interface language",
    languageDescription: "Choose the display language for public representative pages and account settings.",
    currentLanguage: "Display language",
    languageAriaLabel: "Switch interface language",
    language: { zh: "Chinese", en: "English" },
    backToRepresentative: (name: string) => `Back to ${name}`,
  },
} as const;
