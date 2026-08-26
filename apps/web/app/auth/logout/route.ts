import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  readAccountSessionMode,
  readLogtoOidcConfig,
  revokeAppSession,
  usesAccountSessionV2,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
  sanitizeCreatorReturnTo,
} from "../../../auth-guard";

const DELEGATE_LOGOUT_RETURN_COOKIE = "delegate_logout_return_v1";

export function GET() {
  return new Response(null, {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": "no-store",
    },
  });
}

export const HEAD = GET;

export async function POST(request: Request) {
  try {
    const canonicalRequestUrl = buildCreatorCanonicalAuthRequestUrl(request);
    if (canonicalRequestUrl) {
      return NextResponse.redirect(canonicalRequestUrl);
    }
    if (!isTrustedLogoutRequest(request)) {
      return new NextResponse(null, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }

    const url = new URL(request.url);
    const returnTo = sanitizeCreatorReturnTo(
      url.searchParams.get("returnTo"),
    );
    const siteReturnTo = resolveTrustedSiteReturnTo(
      url.searchParams.get("siteReturnTo"),
    );
    if (shouldRevokeAccountSession()) {
      const cookieStore = await cookies();
      const currentAppSession = cookieStore.get(
        DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
      )?.value;
      try {
        if (currentAppSession) {
          await revokeAppSession({
            token: currentAppSession,
            application: "DASHBOARD",
            reason: "USER_LOGOUT",
          });
        }
      } catch {
        // Browser-side deletion remains authoritative for this response even
        // when the shadow database is temporarily unavailable.
      }
    }
    const response = NextResponse.redirect(
      buildLogtoEndSessionUrl(request),
      303,
    );
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
    response.cookies.set(
      DELEGATE_LOGOUT_RETURN_COOKIE,
      encodeLogoutReturn(
        siteReturnTo ? "site" : "dashboard",
        siteReturnTo
          ? `${siteReturnTo.pathname}${siteReturnTo.search}${siteReturnTo.hash}`
          : returnTo,
      ),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/auth/logout/callback",
        maxAge: 5 * 60,
      },
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to log out.",
      },
      { status: 500 },
    );
  }
}

function buildLogtoEndSessionUrl(request: Request): URL {
  const config = readLogtoOidcConfig("dashboard");
  const endSessionUrl = new URL("/oidc/session/end", config.endpoint);
  endSessionUrl.searchParams.set("client_id", config.appId);
  endSessionUrl.searchParams.set(
    "post_logout_redirect_uri",
    buildCreatorRedirectUrl("/auth/logout/callback", request.url).toString(),
  );
  return endSessionUrl;
}

function encodeLogoutReturn(
  kind: "site" | "dashboard",
  returnTo: string,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, kind, returnTo }),
    "utf8",
  ).toString("base64url");
}

function isTrustedLogoutRequest(request: Request): boolean {
  const expectedOrigin = buildCreatorRedirectUrl(
    "/",
    request.url,
  ).origin;
  const requestOrigin = request.headers.get("origin")?.trim();
  if (requestOrigin) {
    try {
      const normalizedOrigin = new URL(requestOrigin).origin;
      return normalizedOrigin === expectedOrigin
        || isTrustedSiteOrigin(normalizedOrigin);
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
}

function resolveTrustedSiteReturnTo(value: string | null): URL | null {
  const configuredSiteOrigin = readConfiguredSiteOrigin();
  const normalized = value?.trim();
  if (
    !configuredSiteOrigin
    || !normalized
    || !normalized.startsWith("/")
    || normalized.startsWith("//")
    || normalized.includes("\\")
  ) {
    return null;
  }
  try {
    const target = new URL(normalized, `${configuredSiteOrigin}/`);
    return target.origin === configuredSiteOrigin ? target : null;
  } catch {
    return null;
  }
}

function isTrustedSiteOrigin(origin: string): boolean {
  const configuredSiteOrigin = readConfiguredSiteOrigin();
  if (!configuredSiteOrigin) return false;
  if (origin === configuredSiteOrigin) return true;
  if (process.env.NODE_ENV === "production") return false;
  try {
    const actual = new URL(origin);
    const configured = new URL(configuredSiteOrigin);
    return actual.protocol === configured.protocol
      && actual.port === configured.port
      && isLoopback(actual.hostname)
      && isLoopback(configured.hostname);
  } catch {
    return false;
  }
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

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function shouldRevokeAccountSession(): boolean {
  try {
    return usesAccountSessionV2(readAccountSessionMode());
  } catch {
    // Logout must remain available under a malformed deployment setting.
    return false;
  }
}
