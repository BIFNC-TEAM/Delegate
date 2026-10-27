import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "./marketing.css";
import {
  extractCountryHint,
  formatHtmlLang,
  getCookieLocale,
  localeCookieName,
  resolveLocale,
} from "@delegate/web-ui";

export const metadata: Metadata = {
  title: "Delegate · 你的对外代理",
  description:
    "创建你的对外代理，接待咨询、提供服务，并连接一个可以为彼此充值的专业服务网络。",
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
