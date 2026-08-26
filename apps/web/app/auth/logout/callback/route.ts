import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
  sanitizeCreatorReturnTo,
} from "../../../../auth-guard";

const DELEGATE_LOGOUT_RETURN_COOKIE = "delegate_logout_return_v1";

export async function GET(request: Request) {
  const canonicalRequestUrl = buildCreatorCanonicalAuthRequestUrl(request);
  if (canonicalRequestUrl) {
    return NextResponse.redirect(canonicalRequestUrl);
  }

  const cookieStore = await cookies();
  const target = resolveLogoutTarget(
    cookieStore.get(DELEGATE_LOGOUT_RETURN_COOKIE)?.value,
    request.url,
  );
  const response = NextResponse.redirect(target, 303);
  response.cookies.delete(DELEGATE_OWNER_AUTH_SESSION_COOKIE);
  response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
  response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
  response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
  response.cookies.set(DELEGATE_DASHBOARD_APP_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(DELEGATE_LOGOUT_RETURN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/auth/logout/callback",
    maxAge: 0,
  });
  return response;
}

function resolveLogoutTarget(cookieValue: string | undefined, requestUrl: string): URL {
  const state = decodeLogoutReturn(cookieValue);
  if (state?.kind === "site") {
    const siteOrigin = readConfiguredSiteOrigin();
    if (siteOrigin) {
      return new URL(sanitizeSiteReturnTo(state.returnTo), `${siteOrigin}/`);
    }
  }

  const returnTo = sanitizeCreatorReturnTo(
    state?.kind === "dashboard" ? state.returnTo : null,
  );
  return buildCreatorRedirectUrl(
    `/auth/error?reason=signed_out&returnTo=${encodeURIComponent(returnTo)}`,
    requestUrl,
  );
}

function decodeLogoutReturn(value: string | undefined): {
  kind: "site" | "dashboard";
  returnTo: string;
} | null {
  if (!value) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      payload.version !== 1
      || (payload.kind !== "site" && payload.kind !== "dashboard")
      || typeof payload.returnTo !== "string"
    ) {
      return null;
    }
    return { kind: payload.kind, returnTo: payload.returnTo };
  } catch {
    return null;
  }
}

function sanitizeSiteReturnTo(value: string): string {
  const normalized = value.trim();
  if (
    !normalized.startsWith("/")
    || normalized.startsWith("//")
    || normalized.includes("\\")
  ) {
    return "/";
  }
  return normalized;
}

function readConfiguredSiteOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
