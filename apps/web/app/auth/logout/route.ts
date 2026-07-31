import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  readAccountSessionMode,
  revokeAppSession,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
  sanitizeCreatorReturnTo,
} from "../../../auth-guard";

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
    if (shouldRevokeShadowSession()) {
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
      buildCreatorRedirectUrl(
        `/auth/error?reason=signed_out&returnTo=${encodeURIComponent(returnTo)}`,
        request.url,
      ),
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

function isTrustedLogoutRequest(request: Request): boolean {
  const expectedOrigin = buildCreatorRedirectUrl(
    "/",
    request.url,
  ).origin;
  const requestOrigin = request.headers.get("origin")?.trim();
  if (requestOrigin) {
    try {
      return new URL(requestOrigin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
}

function shouldRevokeShadowSession(): boolean {
  try {
    return readAccountSessionMode() === "shadow";
  } catch {
    // Logout must remain available under a malformed deployment setting.
    return false;
  }
}
