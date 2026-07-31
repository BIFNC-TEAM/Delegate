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
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession,
  exchangeLogtoCodeForTokens,
  getPublicRepresentativeRuntime,
  readAccountSessionMode,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  resolveWebAudienceContact,
  signDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
  verifyDelegateAuthState,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../../reps/[slug]/public-chat";
import { bindPublicAudienceAuthProfile } from "../../reps/[slug]/public-auth-binding";
import {
  issuePublicAudienceAccountSessionShadow,
  type PublicAudienceAccountSessionShadowOutcome,
} from "../../reps/[slug]/public-account-session-shadow";
import {
  buildRepresentativeAuthRedirectUrl,
  getRepresentativeAuthCookiePath,
  sanitizePublicAudienceReturnTo,
} from "../../reps/[slug]/public-auth";

export async function GET(request: Request) {
  try {
    const accountSessionMode = readAccountSessionMode();
    if (!usesLegacyAccountSessionAuthority(accountSessionMode)) {
      return accountSessionAuthorityUnavailableResponse();
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return NextResponse.json(
        { error: "Missing Logto callback code or state." },
        { status: 400 },
      );
    }

    const cookieStore = await cookies();
    const secret = readDelegateAuthSessionSecret();
    const authState = verifyDelegateAuthState(
      cookieStore.get(DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE)?.value,
      secret,
    );
    if (
      !authState ||
      authState.version !== 3 ||
      authState.state !== state ||
      authState.actor !== "audience"
    ) {
      return NextResponse.json(
        { error: "Invalid or expired login state." },
        { status: 400 },
      );
    }

    // Both the representative and the complete anonymous-chat binding state
    // come exclusively from the verified, server-signed state cookie. The root
    // callback deliberately ignores Host and any slug/audience query values.
    const slug = authState.representativeSlug;
    let sessionState = authState.publicChat;
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return NextResponse.json(
        { error: "Representative is not publicly available." },
        { status: runtime.status === "paused" ? 423 : 404 },
      );
    }
    const setup = runtime.setup;

    const logtoConfig = readLogtoOidcConfig("representatives");
    const tokens = await exchangeLogtoCodeForTokens(logtoConfig, {
      code,
      codeVerifier: authState.codeVerifier,
    });
    if (!tokens.idToken) {
      return NextResponse.json(
        { error: "Logto did not return an id_token." },
        { status: 400 },
      );
    }

    const profile =
      await buildVerifiedExternalAuthProfileFromLogtoIdToken(logtoConfig, {
        idToken: tokens.idToken,
        nonce: authState.nonce,
      });
    const contact = await resolveWebAudienceContact({
      representativeId: setup.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    if (!contact.audienceIdentityId) {
      throw new Error("Audience identity is required before login callback.");
    }

    const verifiedAt = new Date();
    const binding = await bindPublicAudienceAuthProfile({
      representativeId: setup.id,
      representativeSlug: slug,
      initialAudienceIdentityId: contact.audienceIdentityId,
      sessionState,
      profile,
      now: verifiedAt,
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
      now: verifiedAt,
    });
    const authCookiePath = getRepresentativeAuthCookiePath(slug);
    const returnTo = sanitizePublicAudienceReturnTo(
      authState.returnTo,
      slug,
    );
    const secure = shouldUseSecurePublicChatCookie(request);
    const response = NextResponse.redirect(
      buildRepresentativeAuthRedirectUrl(request, returnTo),
    );
    response.cookies.set(
      DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
      signDelegateAuthSession(session, secret),
      {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: authCookiePath,
        maxAge: session.expiresAt - session.issuedAt,
      },
    );
    response.cookies.set(
      getPublicChatCookieName(slug),
      writePublicChatSessionState({
        representativeSlug: slug,
        state: sessionState,
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure,
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: authCookiePath,
      },
    );
    clearScopedLegacyCookies(response, authCookiePath, secure);
    response.cookies.set(DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH,
      maxAge: 0,
    });
    if (shadowOutcome?.status === "issued") {
      setRepresentativesAppSessionCookie(
        response,
        secure,
        shadowOutcome.session,
      );
    } else if (shadowOutcome?.status === "review_required") {
      clearRepresentativesAppSessionCookie(response, secure);
    }
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to complete representative login.",
      },
      { status: 500 },
    );
  }
}

function clearScopedLegacyCookies(
  response: NextResponse,
  authCookiePath: string,
  secure: boolean,
) {
  for (const name of [
    DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
    LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
    LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  ]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: authCookiePath,
      maxAge: 0,
    });
  }
}

function accountSessionAuthorityUnavailableResponse() {
  return NextResponse.json(
    {
      error: "Account/AppSession v2 authority is not enabled in this build.",
    },
    { status: 503 },
  );
}

function readBoundedUserAgent(request: Request): string | null {
  return request.headers.get("user-agent")?.trim().slice(0, 512) || null;
}

function setRepresentativesAppSessionCookie(
  response: NextResponse,
  secure: boolean,
  issued: Extract<
    PublicAudienceAccountSessionShadowOutcome,
    { status: "issued" }
  >["session"],
) {
  response.cookies.set(DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE, issued.token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.floor(
      (issued.session.absoluteExpiresAt.getTime() -
        issued.session.issuedAt.getTime()) /
        1_000,
    ),
  });
}

function clearRepresentativesAppSessionCookie(
  response: NextResponse,
  secure: boolean,
) {
  response.cookies.set(DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}
