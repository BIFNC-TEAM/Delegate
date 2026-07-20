import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
} from "@delegate/web-data";

import { shouldUseSecurePublicChatCookie } from "../../public-chat";
import {
  getRepresentativeAuthCookiePath,
  sanitizePublicAudienceReturnTo,
} from "../../public-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const returnTo = sanitizePublicAudienceReturnTo(url.searchParams.get("returnTo"), slug);
  const authCookiePath = getRepresentativeAuthCookiePath(slug);
  const response = NextResponse.redirect(new URL(returnTo, request.url));

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
}
