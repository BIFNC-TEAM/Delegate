import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "@delegate/web-ui/styles.css";
import { extractCountryHint, formatHtmlLang, getCookieLocale, localeCookieName, resolveLocale } from "@delegate/web-ui";

export const metadata: Metadata = {
  title: "Delegate Representative",
  description:
    "Web-first public representative profiles for AI front desk, paid continuation, and human handoff flows.",
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
    <html lang={formatHtmlLang(locale)}>
      <body>{children}</body>
    </html>
  );
}
