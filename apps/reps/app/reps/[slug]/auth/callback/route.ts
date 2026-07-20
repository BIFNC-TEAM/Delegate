import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession,
  exchangeLogtoCodeForTokens,
  getPublicRepresentativeRuntime,
  linkAudienceIdentityToAuth,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  resolveWebAudienceContact,
  signDelegateAuthSession,
  verifyDelegateAuthState,
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
} from "../../public-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return NextResponse.json({ error: "Missing Logto callback code or state." }, { status: 400 });
    }

    const cookieStore = await cookies();
    const secret = readDelegateAuthSessionSecret();
    const authState = verifyDelegateAuthState(
      cookieStore.get(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE)?.value ??
        cookieStore.get(LEGACY_DELEGATE_AUTH_STATE_COOKIE)?.value,
      secret,
    );
    if (
      !authState ||
      authState.state !== state ||
      authState.actor !== "audience" ||
      authState.representativeSlug !== slug ||
      !authState.audienceId
    ) {
      return NextResponse.json({ error: "Invalid or expired login state." }, { status: 400 });
    }

    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    const setup = runtime.setup;

    const logtoConfig = {
      ...readLogtoOidcConfig(),
      redirectUri: buildRepresentativeAuthCallbackUrl(request, slug),
    };
    const tokens = await exchangeLogtoCodeForTokens(logtoConfig, { code });
    if (!tokens.idToken) {
      return NextResponse.json({ error: "Logto did not return an id_token." }, { status: 400 });
    }

    const cookieSessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const sessionState =
      cookieSessionState.audienceId === authState.audienceId
        ? cookieSessionState
        : { ...cookieSessionState, audienceId: authState.audienceId };
    const contact = await resolveWebAudienceContact({
      representativeId: setup.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    if (!contact.audienceIdentityId) {
      throw new Error("Audience identity is required before login callback.");
    }

    const profile = await buildVerifiedExternalAuthProfileFromLogtoIdToken(logtoConfig, {
      idToken: tokens.idToken,
      nonce: authState.nonce,
    });
    const audienceIdentity = await linkAudienceIdentityToAuth({
      audienceIdentityId: contact.audienceIdentityId,
      profile,
    });
    const session = createDelegateAuthSession({
      actor: "audience",
      subject: profile.subject,
      audienceIdentityId: audienceIdentity.id,
      audienceId: sessionState.audienceId,
      email: profile.email ?? null,
    });
    const authCookiePath = getRepresentativeAuthCookiePath(slug);
    const response = NextResponse.redirect(new URL(authState.returnTo, request.url));
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
    response.cookies.set(
      getPublicChatCookieName(slug),
      writePublicChatSessionState({
        representativeSlug: slug,
        state: sessionState,
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: authCookiePath,
      },
    );
    response.cookies.set(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE, "", {
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
        error: error instanceof Error ? error.message : "Failed to complete representative login.",
      },
      { status: 500 },
    );
  }
}
