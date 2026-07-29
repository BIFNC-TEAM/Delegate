import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "@delegate/web-ui/styles.css";
import "./dashboard/dashboard-v2.css";
import { extractCountryHint, formatHtmlLang, getCookieLocale, localeCookieName, resolveLocale } from "@delegate/web-ui";
import { DashboardHistoryTracker } from "./dashboard/dashboard-history-tracker";

export const metadata: Metadata = {
  title: "Delegate",
  description:
    "Owner dashboard for web-first AI front desk operations, public representatives, paid continuation, and handoff workflows.",
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
    <html data-scroll-behavior="smooth" lang={formatHtmlLang(locale)}>
      <body>
        <DashboardHistoryTracker />
        {children}
      </body>
    </html>
  );
}
