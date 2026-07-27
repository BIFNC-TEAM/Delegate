import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
} from "@delegate/web-data";

import { shouldUseSecurePublicChatCookie } from "../../public-chat";
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
