import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateAuthState,
  generateAuthStateToken,
  getPublicRepresentativeRuntime,
  isDelegateAuthPersistenceUnavailableError,
  isLogtoOidcConfigured,
  linkAudienceIdentityToAuth,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  resolveWebAudienceContact,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../../public-chat";
import {
  buildRepresentativeAuthCallbackUrl,
  getRepresentativeAuthCookiePath,
  sanitizePublicAudienceReturnTo,
} from "../../public-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    const setup = runtime.setup;

    const url = new URL(request.url);
    const returnTo = sanitizePublicAudienceReturnTo(url.searchParams.get("returnTo"), slug);
    const cookieStore = await cookies();
    const sessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const contact = await resolveWebAudienceContact({
      representativeId: setup.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    if (!contact.audienceIdentityId) {
      throw new Error("Audience identity is required before login.");
    }

    const authCookiePath = getRepresentativeAuthCookiePath(slug);
    const secret = readDelegateAuthSessionSecret();
    const publicChatCookieValue = writePublicChatSessionState({
      representativeSlug: slug,
      state: sessionState,
    });

    if (!isLogtoOidcConfigured()) {
      if (!shouldUseDelegateAuthDevLogin()) {
        throw new Error("LOGTO_ENDPOINT, LOGTO_APP_ID, LOGTO_APP_SECRET, and LOGTO_REDIRECT_URI are required");
      }

      const profile = buildDelegateDevAuthProfile({
        actor: "audience",
        subject: process.env.DELEGATE_AUTH_DEV_AUDIENCE_SUBJECT,
        email: process.env.DELEGATE_AUTH_DEV_AUDIENCE_EMAIL,
        name: process.env.DELEGATE_AUTH_DEV_AUDIENCE_NAME,
        representativeSlug: slug,
        audienceId: sessionState.audienceId,
      });
      let audienceIdentityId = contact.audienceIdentityId;
      try {
        const audienceIdentity = await linkAudienceIdentityToAuth({
          audienceIdentityId: contact.audienceIdentityId,
          profile,
        });
        audienceIdentityId = audienceIdentity.id;
      } catch (error) {
        if (!isDelegateAuthPersistenceUnavailableError(error)) {
          throw error;
        }
      }
      const session = createDelegateAuthSession({
        actor: "audience",
        subject: profile.subject,
        audienceIdentityId,
        audienceId: sessionState.audienceId,
        email: profile.email ?? null,
      });
      const response = NextResponse.redirect(new URL(returnTo, request.url));
      response.cookies.set(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE, signDelegateAuthSession(session, secret), {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        path: authCookiePath,
        maxAge: session.expiresAt - session.issuedAt,
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
      response.cookies.set(getPublicChatCookieName(slug), publicChatCookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: authCookiePath,
      });
      return response;
    }

    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const authState = createDelegateAuthState({
      actor: "audience",
      state,
      nonce,
      returnTo,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    const logtoConfig = {
      ...readLogtoOidcConfig(),
      redirectUri: buildRepresentativeAuthCallbackUrl(request, slug),
    };
    const response = NextResponse.redirect(
      buildLogtoAuthorizeUrl(logtoConfig, {
        state,
        nonce,
      }),
    );

    response.cookies.set(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE, signDelegateAuthState(authState, secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 10 * 60,
    });
    response.cookies.set(LEGACY_DELEGATE_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: authCookiePath,
      maxAge: 0,
    });
    response.cookies.set(getPublicChatCookieName(slug), publicChatCookieValue, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
      path: authCookiePath,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start representative login.",
      },
      { status: 500 },
    );
  }
}
