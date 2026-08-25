import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import "@delegate/web-ui/styles.css";
import "./dashboard/dashboard-v2.css";
import { formatHtmlLang, getCookieLocale, localeCookieName } from "@delegate/web-ui";
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
  const cookieStore = await cookies();
  const locale =
    getCookieLocale(cookieStore.get(localeCookieName)?.value) ?? "zh";

  return (
    <html
      data-scroll-behavior="smooth"
      lang={formatHtmlLang(locale)}
      suppressHydrationWarning
    >
      <body>
        <DashboardHistoryTracker />
        {children}
      </body>
    </html>
  );
}
