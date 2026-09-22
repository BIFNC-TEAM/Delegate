export const settingsSections = [
  "profile",
  "notifications",
] as const;

export type SettingsSection = (typeof settingsSections)[number];

export function parseSettingsSection(
  value: string | null | undefined,
): SettingsSection {
  // Legacy security/connections links now open Profile & preferences, including sign-out.
  return settingsSections.includes(value as SettingsSection)
    ? (value as SettingsSection)
    : "profile";
}

export function buildSettingsSectionHref({
  currentSearch,
  locale,
  pathname,
  section,
}: {
  currentSearch: string;
  locale: string;
  pathname: string;
  section: SettingsSection;
}): string {
  const params = new URLSearchParams(currentSearch);
  params.set("view", "settings");
  params.set("settingsSection", section);
  params.set("lang", locale);
  params.delete("conversation");
  params.delete("repSection");
  params.delete("setupSection");
  return `${pathname}?${params.toString()}`;
}

// Keep Account Center in the same tab: its verification Back button uses
// browser history. The explicit redirect handles successful task completion.
export function buildAccountCenterHref(href: string | undefined, dashboardOrigin: string, locale: string): string | null {
  if (!href) return null;
  try {
    const target = new URL(href);
    const dashboard = new URL(dashboardOrigin);
    const safeOrigin = (url: URL) => !url.username && !url.password && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    if (!safeOrigin(target) || !safeOrigin(dashboard)
      || !/^\/account\/(?:phone|email|password|social\/[A-Za-z0-9_-]+(?:\/(?:change|remove))?)$/u.test(target.pathname)) return null;
    const returnTo = new URL("/dashboard", dashboard.origin);
    returnTo.search = new URLSearchParams({ view: "settings", settingsSection: "profile", lang: locale === "en" ? "en" : "zh" }).toString();
    returnTo.hash = "settings-profile-heading";
    target.searchParams.set("redirect", returnTo.toString());
    target.searchParams.set("ui_locales", locale === "en" ? "en" : "zh-CN");
    return target.toString();
  } catch { return null; }
}
