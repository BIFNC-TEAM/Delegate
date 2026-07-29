export const settingsSections = [
  "profile",
  "security",
  "notifications",
] as const;

export type SettingsSection = (typeof settingsSections)[number];

export function parseSettingsSection(
  value: string | null | undefined,
): SettingsSection {
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
