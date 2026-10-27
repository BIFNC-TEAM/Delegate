"use client";

import { useRef } from "react";

import { LanguageSwitcher, type Locale } from "@delegate/web-ui";

import { useSiteSession } from "./site-session";
import type { SiteAccount } from "./site-session-client";

type SiteAccountNavigationProps = {
  activeLocale: Locale;
  dashboardBaseUrl: string;
  loginHref: string;
  registerHref: string;
  registerLabel: string;
  signupHref: string | null;
  siteReturnTo: string;
  menu: ReadonlyArray<{ href: string; label: string }>;
  copy: {
    languageAriaLabel: string;
    menuLabel: string;
    login: string;
    signup: string;
    checking: string;
    unavailable: string;
    retry: string;
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
  const mobileMenu = useRef<HTMLDetailsElement>(null);
  const { state, retry } = useSiteSession();
  const session = state.status === "authenticated" ? state : null;
  const isAnonymous = state.status === "anonymous";
  const sessionFeedback = (
    <div className="site-session-feedback" role="status">
      {state.status === "loading" ? (
        <>
          <span className="site-session-js-only" aria-busy="true">
            {props.copy.checking}
          </span>
          <noscript>
            <a href={props.loginHref}>{props.copy.login}</a>
            {props.signupHref && (
              <>
                {" "}
                · <a href={props.signupHref}>{props.copy.signup}</a>
              </>
            )}
          </noscript>
        </>
      ) : (
        <>
          <span>{props.copy.unavailable}</span>
          <button type="button" onClick={retry}>
            {props.copy.retry}
          </button>
        </>
      )}
    </div>
  );

  const languageItems = [
    {
      locale: "zh" as const,
      href: "/?lang=zh",
      label: props.copy.zh,
      shortLabel: "ZH",
    },
    {
      locale: "en" as const,
      href: "/?lang=en",
      label: props.copy.en,
      shortLabel: "EN",
    },
  ];
  const consoleHref = localizedDashboardHref(
    props.dashboardBaseUrl,
    "overview",
    props.activeLocale,
  );
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
        ) : isAnonymous ? (
          <>
            <LanguageSwitcher
              activeLocale={props.activeLocale}
              ariaLabel={props.copy.languageAriaLabel}
              items={languageItems}
            />
            <a
              className="site-text-link site-header-login"
              href={props.loginHref}
            >
              {props.copy.login}
            </a>
            {props.signupHref && (
              <a
                className="site-text-link site-header-signup"
                href={props.signupHref}
              >
                {props.copy.signup}
              </a>
            )}
            <a
              className="site-button site-button-primary site-header-cta"
              href={props.registerHref}
            >
              {props.registerLabel}
            </a>
          </>
        ) : (
          sessionFeedback
        )}
      </div>

      <details
        className="site-mobile-menu"
        ref={mobileMenu}
        onKeyDown={(event) => {
          if (event.key === "Escape" && mobileMenu.current) {
            mobileMenu.current.open = false;
            mobileMenu.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary>{props.copy.menuLabel}</summary>
        <nav
          aria-label={props.copy.menuLabel}
          onClick={(event) => {
            if (
              (event.target as HTMLElement).closest("a") &&
              mobileMenu.current
            )
              mobileMenu.current.open = false;
          }}
        >
          {props.menu.map((item) => (
            <a href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
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
          ) : isAnonymous ? (
            <>
              <a className="site-mobile-login" href={props.loginHref}>
                {props.copy.login}
              </a>
              {props.signupHref && (
                <a href={props.signupHref}>{props.copy.signup}</a>
              )}
              <a className="site-mobile-register" href={props.registerHref}>
                {props.registerLabel}
              </a>
            </>
          ) : (
            sessionFeedback
          )}
          <div
            className="site-mobile-language"
            aria-label={props.copy.languageAriaLabel}
          >
            {languageItems.map((item) => (
              <a
                aria-current={
                  item.locale === props.activeLocale ? "page" : undefined
                }
                href={item.href}
                key={item.locale}
              >
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
  account: SiteAccount;
  accountFallback: string;
  accountMenuLabel: string;
  consoleHref: string;
  consoleLabel: string;
  languageAriaLabel: string;
  languageItems: Array<{
    locale: Locale;
    href: string;
    label: string;
    shortLabel: string;
  }>;
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
    <details
      className="site-account-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={props.accountMenuLabel}>
        <span className="site-account-avatar" aria-hidden="true">
          {accountInitial(label)}
        </span>
        <span className="site-account-trigger-label">{label}</span>
        <span className="site-account-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="site-account-popover">
        <div className="site-account-identity">
          <AccountIdentity
            account={props.account}
            fallback={props.accountFallback}
          />
        </div>
        <div className="site-account-links">
          <a href={props.consoleHref}>
            <span aria-hidden="true">↗</span>
            {props.consoleLabel}
          </a>
          <a href={props.representativesHref}>
            <span aria-hidden="true">◇</span>
            {props.representativesLabel}
          </a>
          <a href={props.settingsHref}>
            <span aria-hidden="true">⚙</span>
            {props.settingsLabel}
          </a>
        </div>
        <div className="site-account-language">
          <span>{props.languageAriaLabel}</span>
          <LanguageSwitcher
            activeLocale={props.locale}
            ariaLabel={props.languageAriaLabel}
            items={props.languageItems}
          />
        </div>
        <form
          action={props.logoutAction}
          className="site-account-logout"
          method="post"
        >
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
  account: SiteAccount;
  fallback: string;
}) {
  const label = accountLabel(account, fallback);
  return (
    <>
      <span className="site-account-avatar" aria-hidden="true">
        {accountInitial(label)}
      </span>
      <span className="site-account-identity-copy">
        <strong>{label}</strong>
        {account.email && account.email !== label ? (
          <small>{account.email}</small>
        ) : null}
      </span>
    </>
  );
}

function accountLabel(account: SiteAccount, fallback: string): string {
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
