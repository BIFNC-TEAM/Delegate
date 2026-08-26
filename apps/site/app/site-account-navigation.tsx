"use client";

import { useEffect, useState } from "react";

import { LanguageSwitcher, type Locale } from "@delegate/web-ui";

type SiteSession = {
  authenticated: true;
  account: {
    displayName: string;
    email: string | null;
  };
};

type SiteAccountNavigationProps = {
  activeLocale: Locale;
  dashboardBaseUrl: string;
  loginHref: string;
  registerHref: string;
  registerLabel: string;
  siteReturnTo: string;
  menu: ReadonlyArray<{ href: string; label: string }>;
  copy: {
    languageAriaLabel: string;
    menuLabel: string;
    login: string;
    accountFallback: string;
    accountMenuLabel: string;
    console: string;
    representatives: string;
    settings: string;
    signOut: string;
    zh: string;
    en: string;
  };
};

export function SiteAccountNavigation(props: SiteAccountNavigationProps) {
  const [session, setSession] = useState<SiteSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(new URL("/api/auth/site-session", props.dashboardBaseUrl), {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json() as SiteSession | { authenticated: false };
        return payload.authenticated ? payload : null;
      })
      .then((payload) => setSession(payload))
      .catch(() => {
        if (!controller.signal.aborted) setSession(null);
      });

    return () => controller.abort();
  }, [props.dashboardBaseUrl]);

  const languageItems = [
    { locale: "zh" as const, href: "/?lang=zh", label: props.copy.zh, shortLabel: "ZH" },
    { locale: "en" as const, href: "/?lang=en", label: props.copy.en, shortLabel: "EN" },
  ];
  const consoleHref = localizedDashboardHref(props.dashboardBaseUrl, "overview", props.activeLocale);
  const representativesHref = localizedDashboardHref(
    props.dashboardBaseUrl,
    "representatives",
    props.activeLocale,
  );
  const settingsHref = localizedDashboardHref(
    props.dashboardBaseUrl,
    "settings",
    props.activeLocale,
    "profile",
  );
  const logoutAction = new URL("/auth/logout", props.dashboardBaseUrl);
  logoutAction.searchParams.set("siteReturnTo", props.siteReturnTo);

  return (
    <>
      <div className="site-header-actions">
        {session ? (
          <AccountMenu
            account={session.account}
            accountFallback={props.copy.accountFallback}
            accountMenuLabel={props.copy.accountMenuLabel}
            consoleHref={consoleHref}
            consoleLabel={props.copy.console}
            languageAriaLabel={props.copy.languageAriaLabel}
            languageItems={languageItems}
            locale={props.activeLocale}
            logoutAction={logoutAction.toString()}
            representativesHref={representativesHref}
            representativesLabel={props.copy.representatives}
            settingsHref={settingsHref}
            settingsLabel={props.copy.settings}
            signOutLabel={props.copy.signOut}
          />
        ) : (
          <>
            <LanguageSwitcher
              activeLocale={props.activeLocale}
              ariaLabel={props.copy.languageAriaLabel}
              items={languageItems}
            />
            <a className="site-text-link site-header-login" href={props.loginHref}>
              {props.copy.login}
            </a>
            <a className="site-button site-button-primary site-header-cta" href={props.registerHref}>
              {props.registerLabel}
            </a>
          </>
        )}
      </div>

      <details className="site-mobile-menu">
        <summary>{props.copy.menuLabel}</summary>
        <nav aria-label={props.copy.menuLabel}>
          {props.menu.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}
          {session ? (
            <>
              <div className="site-mobile-account">
                <AccountIdentity
                  account={session.account}
                  fallback={props.copy.accountFallback}
                />
              </div>
              <a href={consoleHref}>{props.copy.console}</a>
              <a href={representativesHref}>{props.copy.representatives}</a>
              <a href={settingsHref}>{props.copy.settings}</a>
              <form action={logoutAction.toString()} method="post">
                <button type="submit">{props.copy.signOut}</button>
              </form>
            </>
          ) : (
            <>
              <a className="site-mobile-login" href={props.loginHref}>{props.copy.login}</a>
              <a className="site-mobile-register" href={props.registerHref}>{props.registerLabel}</a>
            </>
          )}
          <div className="site-mobile-language" aria-label={props.copy.languageAriaLabel}>
            {languageItems.map((item) => (
              <a aria-current={item.locale === props.activeLocale ? "page" : undefined} href={item.href} key={item.locale}>
                {item.shortLabel} · {item.label}
              </a>
            ))}
          </div>
        </nav>
      </details>
    </>
  );
}

function AccountMenu(props: {
  account: SiteSession["account"];
  accountFallback: string;
  accountMenuLabel: string;
  consoleHref: string;
  consoleLabel: string;
  languageAriaLabel: string;
  languageItems: Array<{ locale: Locale; href: string; label: string; shortLabel: string }>;
  locale: Locale;
  logoutAction: string;
  representativesHref: string;
  representativesLabel: string;
  settingsHref: string;
  settingsLabel: string;
  signOutLabel: string;
}) {
  const label = accountLabel(props.account, props.accountFallback);

  return (
    <details className="site-account-menu">
      <summary aria-label={props.accountMenuLabel}>
        <span className="site-account-avatar" aria-hidden="true">{accountInitial(label)}</span>
        <span className="site-account-trigger-label">{label}</span>
        <span className="site-account-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="site-account-popover">
        <div className="site-account-identity">
          <AccountIdentity account={props.account} fallback={props.accountFallback} />
        </div>
        <div className="site-account-links">
          <a href={props.consoleHref}><span aria-hidden="true">↗</span>{props.consoleLabel}</a>
          <a href={props.representativesHref}><span aria-hidden="true">◇</span>{props.representativesLabel}</a>
          <a href={props.settingsHref}><span aria-hidden="true">⚙</span>{props.settingsLabel}</a>
        </div>
        <div className="site-account-language">
          <span>{props.languageAriaLabel}</span>
          <LanguageSwitcher
            activeLocale={props.locale}
            ariaLabel={props.languageAriaLabel}
            items={props.languageItems}
          />
        </div>
        <form action={props.logoutAction} className="site-account-logout" method="post">
          <button type="submit">{props.signOutLabel}</button>
        </form>
      </div>
    </details>
  );
}

function AccountIdentity({
  account,
  fallback,
}: {
  account: SiteSession["account"];
  fallback: string;
}) {
  const label = accountLabel(account, fallback);
  return (
    <>
      <span className="site-account-avatar" aria-hidden="true">{accountInitial(label)}</span>
      <span className="site-account-identity-copy">
        <strong>{label}</strong>
        {account.email && account.email !== label ? <small>{account.email}</small> : null}
      </span>
    </>
  );
}

function accountLabel(account: SiteSession["account"], fallback: string): string {
  return account.displayName.trim() || account.email?.trim() || fallback;
}

function accountInitial(label: string): string {
  return Array.from(label.trim())[0]?.toUpperCase() || "D";
}

function localizedDashboardHref(
  dashboardBaseUrl: string,
  view: "overview" | "representatives" | "settings",
  locale: Locale,
  settingsSection?: "profile",
): string {
  const url = new URL("/dashboard", dashboardBaseUrl);
  url.searchParams.set("view", view);
  url.searchParams.set("lang", locale);
  if (settingsSection) url.searchParams.set("settingsSection", settingsSection);
  return url.toString();
}
