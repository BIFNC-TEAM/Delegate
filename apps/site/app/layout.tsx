import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "@delegate/web-ui/styles.css";
import "./marketing.css";
import { extractCountryHint, formatHtmlLang, getCookieLocale, localeCookieName, resolveLocale } from "@delegate/web-ui";

export const metadata: Metadata = {
  title: "Delegate — 公开数字代表与 AI 接待前台",
  description:
    "为创始人、顾问和创作者创建公开数字代表：回答公开问题、筛选需求、收取服务费，并把高价值事项带着上下文交给你。",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const headerStore = await headers();
  const cookieStore = await cookies();
  const locale = resolveLocale({
    requestedLocale: getCookieLocale(cookieStore.get(localeCookieName)?.value),
    acceptLanguage: headerStore.get("accept-language"),
    countryHint: extractCountryHint(headerStore),
  });

  return (
    <html lang={formatHtmlLang(locale)} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
