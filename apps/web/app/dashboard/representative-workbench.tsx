import type { ReactNode } from "react";
import Link from "next/link";
import { dashboardNavigation, localize } from "./dashboard-ui-data";
import type { Locale } from "@delegate/web-ui";
import "./representative-basic-info.css";

// The same 24px outline geometry used by the approved prototype.
export function WorkbenchIcon({ name = "bot" }: { name?: string }) {
  const paths: Record<string, ReactNode> = {
    upload: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M12 3v12m-5-7 5-5 5 5" />
      </>
    ),
    bot: (
      <>
        <path d="M12 8V4H8M4 12H2m20 0h-2M9 13v2m6-2v2" />
        <rect x="4" y="8" width="16" height="12" rx="2" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="5" />
        <path d="M20 21a8 8 0 0 0-16 0" />
      </>
    ),
    back: <path d="m12 19-7-7 7-7M5 12h14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    overview: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </>
    ),
    knowledge: (
      <path d="M12 7v14m0-14C8 4 5 4 2 5v15c3-1 6-1 10 1 4-2 7-2 10-1V5c-3-1-6-1-10 2Z" />
    ),
    inbox: (
      <>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
        <path d="M8 8h8M8 12h5" />
      </>
    ),
    approvals: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    skills: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 17h7m-3.5-3.5v7" />
      </>
    ),
    wallet: (
      <>
        <path d="M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h15V8H5a3 3 0 0 1 0-6" />
        <path d="M20 12h-5v5h5" />
      </>
    ),
    channels: <path d="m22 2-7 20-4-9L2 9 20 2ZM22 2 11 13" />,
    audit: (
      <>
        <path d="M8 21h12V5a2 2 0 0 0-2-2H6v14M8 21a2 2 0 0 1-2-2v-2h12v2a2 2 0 0 0 2 2M9 7h6m-6 4h6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6" />
      </>
    ),
    analytics: <path d="M3 3v18h18M7 14l4-5 4 3 6-8" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.bot}
    </svg>
  );
}

export function WorkbenchPanelHeading({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <div>
      <h3 className="d-heading-icon">
        <span className="d-icon-tile">
          <WorkbenchIcon name={icon} />
        </span>
        {title}
      </h3>
      <p>{description}</p>
    </div>
  );
}

export function RepresentativeWorkbench({
  children,
  accountLabel,
  representativeName,
  count,
  activeSlug,
  locale,
  loginHref,
}: {
  children: ReactNode;
  accountLabel: string;
  representativeName: string;
  count: number;
  activeSlug: string;
  locale: Locale;
  loginHref?: string | undefined;
}) {
  const href = (view: string) =>
    `/dashboard?rep=${encodeURIComponent(activeSlug)}&view=${view}&lang=${locale}`;
  return (
    <main
      className="representative-workbench"
      lang={locale === "zh" ? "zh-CN" : "en"}
    >
      <div className="d-shell">
        <aside className="d-sidebar">
          <div className="d-brand">
            <span className="d-logo">D</span>
            <div>
              Delegate<small>对外代理工作台</small>
            </div>
          </div>
          <div className="d-workspace">
            <span className="d-muted">当前工作区</span>
            <strong>Delegate Studio</strong>
            <span className="d-muted">{count} 个对外代理</span>
          </div>
          {dashboardNavigation.map((group) => (
            <div key={group.label.en}>
              <div className="d-nav-label">{localize(locale, group.label)}</div>
              {group.items.map((item) => (
                <Link
                  key={item.id}
                  className={`d-side-item${item.id === "representatives" ? " active" : ""}`}
                  href={href(item.id)}
                  aria-current={
                    item.id === "representatives" ? "page" : undefined
                  }
                >
                  <WorkbenchIcon name={item.id} />
                  {localize(locale, item.label)}
                </Link>
              ))}
            </div>
          ))}
          <a
            className="d-owner d-account-owner"
            href={loginHref || href("settings")}
          >
            <span className="d-avatar">{Array.from(accountLabel)[0]}</span>
            <span className="d-account-name">
              <strong>{accountLabel}</strong>
              <span className="d-muted">
                {loginHref ? "登录账户" : "Owner"}
              </span>
            </span>
            <WorkbenchIcon name="settings" />
          </a>
        </aside>
        <section className="d-main">
          <header className="d-topbar">
            <WorkbenchIcon />
            <span>对外代理 / {representativeName}</span>
            <span className="d-muted">
              {locale === "zh" ? "简体中文" : "English"}
            </span>
          </header>
          <div className="d-content">{children}</div>
        </section>
      </div>
    </main>
  );
}
