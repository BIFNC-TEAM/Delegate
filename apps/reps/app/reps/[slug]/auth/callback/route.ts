import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession,
  exchangeLogtoCodeForTokens,
  getPublicRepresentativeRuntime,
  isLegacyRepresentativeCallbackEnabled,
  readLegacyRepresentativeLogtoOidcConfig,
  readDelegateAuthSessionSecret,
  readAccountSessionMode,
  resolveWebAudienceContact,
  signDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
  verifyDelegateAuthState,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../../public-chat";
import { bindPublicAudienceAuthProfile } from "../../public-auth-binding";
import {
  issuePublicAudienceAccountSessionShadow,
  type PublicAudienceAccountSessionShadowOutcome,
} from "../../public-account-session-shadow";
import {
  buildRepresentativeAuthRedirectUrl,
  getRepresentativeAuthCookiePath,
} from "../../public-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    // This endpoint exists only to finish already-issued v1/v2 state. It must
    // never redirect an authorization response to the new callback because the
    // authorization code is bound to this exact legacy redirect_uri.
    if (!isLegacyRepresentativeCallbackEnabled()) {
      return legacyCallbackGoneResponse();
    }

    const accountSessionMode = readAccountSessionMode();
    if (!usesLegacyAccountSessionAuthority(accountSessionMode)) {
      return accountSessionAuthorityUnavailableResponse();
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return legacyCallbackGoneResponse();
    }

    const cookieStore = await cookies();
    const secret = readDelegateAuthSessionSecret();
    const authStateCandidates = [
      verifyDelegateAuthState(
        cookieStore.get(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE)?.value,
        secret,
      ),
      verifyDelegateAuthState(
        cookieStore.get(LEGACY_DELEGATE_AUTH_STATE_COOKIE)?.value,
        secret,
      ),
    ];
    const authState = authStateCandidates.find(
      (candidate) =>
        candidate &&
        (candidate.version === 1 || candidate.version === 2) &&
        candidate.state === state &&
        candidate.actor === "audience" &&
        candidate.representativeSlug === slug &&
        Boolean(candidate.audienceId),
    );
    if (!authState || !authState.audienceId) {
      return legacyCallbackGoneResponse();
    }

    let logtoConfig: ReturnType<
      typeof readLegacyRepresentativeLogtoOidcConfig
    >;
    try {
      logtoConfig = readLegacyRepresentativeLogtoOidcConfig(slug);
    } catch {
      return legacyCallbackGoneResponse();
    }

    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    const setup = runtime.setup;

    const tokens = await exchangeLogtoCodeForTokens(logtoConfig, {
      code,
      codeVerifier: authState.version === 2 ? authState.codeVerifier : undefined,
    });
    if (!tokens.idToken) {
      return NextResponse.json({ error: "Logto did not return an id_token." }, { status: 400 });
    }

    const cookieSessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    let sessionState =
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
    const verifiedAt = new Date();
    const binding = await bindPublicAudienceAuthProfile({
      representativeId: setup.id,
      representativeSlug: slug,
      initialAudienceIdentityId: contact.audienceIdentityId,
      sessionState,
      profile,
    });
    sessionState = binding.sessionState;
    const shadowOutcome =
      accountSessionMode === "shadow"
        ? await issuePublicAudienceAccountSessionShadow({
            principal: {
              provider: "logto",
              issuer: profile.issuer,
              subject: profile.subject,
              verifiedAt,
              email: profile.email,
              emailVerified: profile.emailVerified,
              phone: profile.phone,
              phoneVerified: profile.phoneVerified,
              displayName: profile.name,
              metadata: {
                verificationSource: "logto_jwks_callback",
              },
            },
            persona: {
              kind: "audience",
              audienceIdentityId: binding.audienceIdentityId,
            },
            application: "PUBLIC_REPRESENTATIVES",
            previousToken: cookieStore.get(
              DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
            )?.value,
            userAgent: readBoundedUserAgent(request),
            now: verifiedAt,
          })
        : null;
    const session = createDelegateAuthSession({
      actor: "audience",
      issuer: profile.issuer,
      subject: profile.subject,
      audienceIdentityId: binding.audienceIdentityId,
      audienceId: sessionState.audienceId,
      email: profile.email ?? null,
    });
    const authCookiePath = getRepresentativeAuthCookiePath(slug);
    const response = NextResponse.redirect(
      buildRepresentativeAuthRedirectUrl(request, authState.returnTo),
    );
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
    if (shadowOutcome?.status === "issued") {
      setRepresentativesAppSessionCookie(
        response,
        request,
        shadowOutcome.session,
      );
    } else if (shadowOutcome?.status === "review_required") {
      clearRepresentativesAppSessionCookie(response, request);
    }
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

function accountSessionAuthorityUnavailableResponse() {
  return NextResponse.json(
    {
      error:
        "Account/AppSession v2 authority is not enabled in this build.",
    },
    { status: 503 },
  );
}

function legacyCallbackGoneResponse() {
  return NextResponse.json(
    {
      error:
        "This legacy representative login callback is no longer available. Start a new login.",
    },
    { status: 410 },
  );
}

function readBoundedUserAgent(request: Request): string | null {
  return request.headers.get("user-agent")?.trim().slice(0, 512) || null;
}

function setRepresentativesAppSessionCookie(
  response: NextResponse,
  request: Request,
  issued: Extract<
    PublicAudienceAccountSessionShadowOutcome,
    { status: "issued" }
  >["session"],
) {
  response.cookies.set(
    DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
    issued.token,
    {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      path: "/",
      maxAge: Math.floor(
        (
          issued.session.absoluteExpiresAt.getTime()
          - issued.session.issuedAt.getTime()
        ) / 1_000,
      ),
    },
  );
}

function clearRepresentativesAppSessionCookie(
  response: NextResponse,
  request: Request,
) {
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
}
