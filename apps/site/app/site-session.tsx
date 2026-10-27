"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyFor, type MarketingLocale } from "./marketing-copy";
import {
  startSiteSessionSync,
  type SiteSessionState,
} from "./site-session-client";

const SiteSessionContext = createContext<{
  state: SiteSessionState;
  retry: () => void;
}>({ state: { status: "loading" }, retry: () => {} });

export function SiteSessionProvider({
  dashboardBaseUrl,
  children,
}: {
  dashboardBaseUrl: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<SiteSessionState>({ status: "loading" });
  const sync = useRef<ReturnType<typeof startSiteSessionSync> | null>(null);
  useEffect(() => {
    setState({ status: "loading" });
    const current = startSiteSessionSync({
      dashboardBaseUrl,
      onChange: setState,
      browser: window,
      document,
      fetcher: window.fetch.bind(window),
    });
    sync.current = current;
    return () => {
      current.dispose();
      sync.current = null;
    };
  }, [dashboardBaseUrl]);
  return (
    <SiteSessionContext.Provider
      value={{
        state,
        retry: () => {
          void sync.current?.refresh();
        },
      }}
    >
      <noscript>
        <style>
          {".marketing-site .site-session-js-only { display: none; }"}
        </style>
      </noscript>
      {children}
    </SiteSessionContext.Provider>
  );
}

export function useSiteSession() {
  return useContext(SiteSessionContext);
}

export function SiteCreationLink({
  href,
  signedInHref,
  locale,
  className = "button",
  children,
}: {
  href: string;
  signedInHref: string;
  locale: MarketingLocale;
  className?: string;
  children: ReactNode;
}) {
  const { state } = useSiteSession();
  const t = copyFor(locale);
  if (state.status === "loading")
    return (
      <>
        <span
          className={`${className} site-session-placeholder site-session-js-only`}
          aria-busy="true"
        >
          {t("正在确认账号…", "Checking account…")}
        </span>
        <noscript>
          <a className={className} href={href}>
            {children}
          </a>
        </noscript>
      </>
    );
  return (
    <a
      className={className}
      href={state.status === "authenticated" ? signedInHref : href}
    >
      {state.status === "authenticated"
        ? t("管理我的对外代理", "Manage my representatives")
        : children}
    </a>
  );
}
