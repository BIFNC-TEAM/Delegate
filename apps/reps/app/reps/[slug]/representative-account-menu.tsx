import type { ReactNode } from "react";

export function RepresentativeAccountMenu({
  accountInitial,
  accountLabel,
  accountMenuAriaLabel,
  authenticated,
  loginHref,
  loginLabel,
  logoutHref,
  logoutLabel,
  myAccountLabel,
  settingsHref,
  settingsLabel,
}: {
  accountInitial: string;
  accountLabel: string;
  accountMenuAriaLabel: string;
  authenticated: boolean;
  loginHref: string;
  loginLabel: string;
  logoutHref: string;
  logoutLabel: string;
  myAccountLabel: string;
  settingsHref: string;
  settingsLabel: string;
}) {
  return (
    <details
      className={`representative-account-menu${authenticated ? "" : " representative-guest-menu"}`}
    >
      <summary aria-label={accountMenuAriaLabel}>
        <span aria-hidden="true" className="representative-account-avatar">
          {accountInitial}
        </span>
        <span className="representative-account-summary-label">{accountLabel}</span>
        <span aria-hidden="true" className="representative-account-chevron">⌄</span>
      </summary>

      <div className="representative-account-popover">
        <div className="representative-account-menu-page">
          {authenticated ? (
            <div className="representative-account-identity">
              <strong>{myAccountLabel}</strong>
              <span>{accountLabel}</span>
            </div>
          ) : null}

          <a className="representative-account-settings-trigger" href={settingsHref}>
            <SettingsIcon />
            <span>{settingsLabel}</span>
            <span aria-hidden="true" className="representative-account-row-chevron">›</span>
          </a>

          {authenticated ? (
            <a className="representative-account-logout" href={logoutHref}>
              {logoutLabel}
            </a>
          ) : (
            <a className="representative-account-login" href={loginHref}>
              {loginLabel}
            </a>
          )}
        </div>
      </div>
    </details>
  );
}

function SettingsIcon(): ReactNode {
  return (
    <span aria-hidden="true" className="representative-account-settings-icon">
      <svg fill="none" viewBox="0 0 20 20">
        <path
          d="M8.4 2.8h3.2l.45 1.85c.35.14.68.33.98.56l1.8-.55 1.6 2.78-1.35 1.3a5 5 0 0 1 0 1.52l1.35 1.3-1.6 2.78-1.8-.55c-.3.23-.63.42-.98.56l-.45 1.85H8.4l-.45-1.85a5.7 5.7 0 0 1-.98-.56l-1.8.55-1.6-2.78 1.35-1.3a5 5 0 0 1 0-1.52l-1.35-1.3 1.6-2.78 1.8.55c.3-.23.63-.42.98-.56L8.4 2.8Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
        <circle cx="10" cy="9.5" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </span>
  );
}
