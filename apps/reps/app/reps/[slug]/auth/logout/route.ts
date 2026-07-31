import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE,
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  readAccountSessionMode,
  revokeAppSession,
} from "@delegate/web-data";

import {
  createPublicChatSessionState,
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../../public-chat";
import {
  buildRepresentativeCanonicalAuthRequestUrl,
  buildRepresentativeAuthRedirectUrl,
  getRepresentativeAuthCookiePath,
  sanitizePublicAudienceReturnTo,
} from "../../public-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const canonicalRequestUrl =
      buildRepresentativeCanonicalAuthRequestUrl(request);
    if (canonicalRequestUrl) {
      return NextResponse.redirect(canonicalRequestUrl);
    }

    const url = new URL(request.url);
    const returnTo = sanitizePublicAudienceReturnTo(
      url.searchParams.get("returnTo"),
      slug,
    );
    const authCookiePath = getRepresentativeAuthCookiePath(slug);
    if (shouldRevokeShadowSession()) {
      const cookieStore = await cookies();
      const currentAppSession = cookieStore.get(
        DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
      )?.value;
      try {
        if (currentAppSession) {
          await revokeAppSession({
            token: currentAppSession,
            application: "PUBLIC_REPRESENTATIVES",
            reason: "USER_LOGOUT",
          });
        }
      } catch {
        // Cookie deletion and anonymous public-chat rotation still complete
        // when the shadow database is temporarily unavailable.
      }
    }
    const response = NextResponse.redirect(
      buildRepresentativeAuthRedirectUrl(request, returnTo),
    );

    response.cookies.set(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 0,
    });
    response.cookies.set(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 0,
    });
    response.cookies.set(DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH,
      maxAge: 0,
    });
    response.cookies.set(LEGACY_DELEGATE_AUTH_SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 0,
    });
    response.cookies.set(LEGACY_DELEGATE_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 0,
    });
    response.cookies.set(
      DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
      "",
      {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        path: "/",
        maxAge: 0,
      },
    );
    response.cookies.set(
      getPublicChatCookieName(slug),
      writePublicChatSessionState({
        representativeSlug: slug,
        state: createPublicChatSessionState(),
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        path: authCookiePath,
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
      },
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to log out of the representative.",
      },
      { status: 500 },
    );
  }
}

function shouldRevokeShadowSession(): boolean {
  try {
    return readAccountSessionMode() === "shadow";
  } catch {
    // Logout must remain available under a malformed deployment setting.
    return false;
  }
}
