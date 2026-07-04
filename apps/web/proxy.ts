import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { localeCookieName, normalizeLocale } from "@delegate/web-ui";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  buildCreatorLoginPath,
  isCreatorDashboardPath,
  shouldRequireCreatorDashboardAuth,
} from "./auth-guard";

export function proxy(request: NextRequest) {
  if (
    shouldRequireCreatorDashboardAuth() &&
    isCreatorDashboardPath(request.nextUrl.pathname) &&
    !request.cookies.get(DASHBOARD_AUTH_COOKIE_NAME)?.value
  ) {
    if (request.nextUrl.pathname.startsWith("/api/dashboard")) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    return NextResponse.redirect(
      new URL(buildCreatorLoginPath(request.nextUrl.pathname, request.nextUrl.search), request.url),
    );
  }

  const requestedLocale = normalizeLocale(request.nextUrl.searchParams.get("lang"));
  if (!requestedLocale) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  response.cookies.set(localeCookieName, requestedLocale, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
