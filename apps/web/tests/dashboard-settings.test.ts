import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-settings.tsx", import.meta.url),
  "utf8",
);
const framework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../app/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const layout = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8",
);
const blueprints = readFileSync(
  new URL("../app/dashboard/dashboard-ui-data.ts", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../app/dashboard/dashboard-v2.css", import.meta.url),
  "utf8",
);
const historyTracker = readFileSync(
  new URL("../app/dashboard/dashboard-history-tracker.tsx", import.meta.url),
  "utf8",
);

describe("dashboard owner settings", () => {
  it("renders Settings as a real owner-scoped view without the legacy fake blueprint", () => {
    expect(framework).toContain('"settings"');
    expect(framework).toContain("<DashboardSettings");
    expect(framework).toContain('props.activeView === "settings"');
    expect(framework).toContain("dashboard-v2-settings-scope");
    expect(framework).toContain('props.activeView !== "settings"');
    expect(framework).not.toContain("LanguageSwitcher");
    expect(blueprints).toContain(
      'Exclude<DashboardView, "overview" | "settings">',
    );
    expect(blueprints).not.toContain("settings: {");
    expect(blueprints).not.toContain("ops@delegate.ai");
    expect(blueprints).not.toContain("finance@delegate.ai");
  });

  it("keeps Settings independent from representative authorization and deep-links all sections", () => {
    expect(page).toContain("parseSettingsSection");
    expect(page).toContain("settingsSection={settingsSection}");
    expect(page).toContain("getOwnerSettingsSnapshot({ ownerId })");
    expect(component).toContain("buildSettingsSectionHref");
    expect(component).toContain('"profile", copy.profileTab');
    expect(component).toContain('"security", copy.securityTab');
    expect(component).toContain('"notifications", copy.notificationsTab');
    expect(component).toContain('fetch("/api/dashboard/settings"');
    expect(component).not.toContain("/api/dashboard/settings?rep=");
    expect(component).not.toContain("representativeSlug");
  });

  it("implements truthful profile and Logto security surfaces", () => {
    expect(component).toContain("displayName");
    expect(component).toContain("preferredLocale");
    expect(component).toContain(
      '(profile.preferredLocale ?? "zh") !== draft.preferredLocale',
    );
    expect(component).toContain(
      'preferredLocale: snapshot.profile?.preferredLocale ?? "zh"',
    );
    expect(component).toContain(
      'value={profileDraft.preferredLocale ?? "zh"}',
    );
    expect(component).not.toContain("languageUnsetOption");
    expect(component).toContain("invalidStoredTimeZone");
    expect(component).not.toContain("supportedValuesOf");
    expect(framework).toContain("timeZones={props.settingsTimeZones}");
    expect(component).toContain("snapshot.security.emailVerification");
    expect(component).toContain("snapshot.security.phoneVerification");
    expect(component).toContain("snapshot.security.managementUrl");
    expect(component).toContain('rel="noreferrer"');
    expect(component).not.toContain("MFA enabled");
    expect(component).not.toContain("Security score");
    expect(component).not.toContain("Revoke other sessions");
  });

  it("configures only real Dashboard alert badges and keeps wallet exceptions mandatory", () => {
    expect(component).toContain("Dashboard navigation only");
    expect(component).toContain("不会发送邮件、短信或 Webhook");
    expect(component).toContain("walletException: true");
    expect(component).toContain("alwaysOn");
    expect(component).not.toContain("quietHours");
    expect(framework).toContain("dashboardNavigationCount");
    expect(framework).toContain("alerts.topics.walletIssues.count");
    expect(framework).not.toContain("dashboard-v2-nav-dot");
  });

  it("exposes save, conflict, unavailable, and accessible feedback states", () => {
    expect(component).toContain('window.addEventListener("beforeunload"');
    expect(component).toContain('navigation.addEventListener("navigate"');
    expect(component).toContain("registerDashboardHistoryGuard");
    expect(component).toContain("resolveUnsavedHistoryTraversal");
    expect(component).toContain("window.history.go(rollback.delta)");
    expect(historyTracker).toContain(
      "useLayoutEffect(() => installDashboardHistoryTracking(window), []);",
    );
    expect(component).toContain(
      "refreshControlledDraftAfterHistoryRollback",
    );
    expect(component).toContain(
      'document.addEventListener("click", handleDocumentNavigation, true)',
    );
    expect(component).toContain("isCurrentDocumentDestination");
    expect(component).toContain("event.stopImmediatePropagation()");
    expect(component).toContain("mutationInFlightRef.current");
    expect(component).toContain("pendingMutationRequestsRef");
    expect(component).toContain("getOrCreateMutationRequestId");
    expect(component).toContain(
      "pending?.fingerprint === fingerprint",
    );
    expect(component).toContain("pendingNavigationHref");
    expect(component).toContain("window.clearTimeout(timeout)");
    expect(component).not.toContain("}, 450)");
    expect(component).toContain("aria-current");
    expect(component).toContain("aria-busy");
    expect(component).toContain('role={feedback.kind === "success" ? "status" : "alert"}');
    expect(component).not.toContain("aria-live={feedback.kind");
    expect(framework).toContain('item.id === props.activeView ? "page" : undefined');
    expect(page).toContain('"本地 Dashboard"');
    expect(component).toContain("owner_settings_version_conflict");
    expect(component).toContain("persistenceUnavailableMessage");
    expect(component).toContain("localizeSettingsRequestError");
    expect(component).toContain("sessionExpiredMessage");
    expect(component).toContain("<SettingsTimestamp");
    expect(component).toContain("SettingsFormActions");
    expect(component).toContain("window.location.assign");
    expect(css).toContain(".settings-feedback");
    expect(css).toContain(".settings-field-error");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("resolves locale with URL, saved Owner preference, cookie, then Chinese default", () => {
    expect(page).toContain("normalizeLocale(params?.lang)");
    expect(page).toContain("ownerPreferences?.preferredLocale");
    expect(page).toContain("getCookieLocale");
    expect(page).toContain('?? "zh"');
    expect(layout).toContain(
      'getCookieLocale(cookieStore.get(localeCookieName)?.value) ?? "zh"',
    );
    const localeResolution = page.slice(page.indexOf("const locale ="));
    expect(localeResolution.indexOf("normalizeLocale(params?.lang)")).toBeLessThan(
      localeResolution.indexOf("ownerPreferences?.preferredLocale"),
    );
    expect(localeResolution.indexOf("ownerPreferences?.preferredLocale")).toBeLessThan(
      localeResolution.indexOf("getCookieLocale"),
    );
    expect(localeResolution.indexOf("getCookieLocale")).toBeLessThan(
      localeResolution.indexOf('?? "zh"'),
    );
  });
});
