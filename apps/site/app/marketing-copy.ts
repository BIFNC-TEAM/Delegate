export type MarketingLocale = "zh" | "en";

export function copyFor(locale: MarketingLocale) {
  return (zh: string, en: string) => (locale === "zh" ? zh : en);
}

export function marketingMenu(locale: MarketingLocale) {
  const t = copyFor(locale);
  return [
    { href: "#network", label: t("服务网络", "Service network") },
    { href: "#experience", label: t("使用方式", "How it works") },
    { href: "#create", label: t("创建指南", "Create yours") },
    { href: "#faq", label: t("常见问题", "FAQ") },
  ];
}
