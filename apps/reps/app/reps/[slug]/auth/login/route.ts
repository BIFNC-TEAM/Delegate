import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE,
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH,
  DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateRepresentativeAuthState,
  derivePkceCodeChallenge,
  generateAuthStateToken,
  generatePkceCodeVerifier,
  getPublicRepresentativeRuntime,
  isDelegateAuthPersistenceUnavailableError,
  isLogtoOidcConfigured,
  readDelegateAuthSessionSecret,
  readAccountSessionMode,
  readLogtoOidcConfig,
  resolveWebAudienceContact,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
  usesAccountSessionV2,
  usesLegacyAccountSessionAuthority,
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

    const accountSessionMode = readAccountSessionMode();
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    const setup = runtime.setup;

    const url = new URL(request.url);
    const returnTo = sanitizePublicAudienceReturnTo(url.searchParams.get("returnTo"), slug);
    const cookieStore = await cookies();
    let sessionState = readPublicChatSessionState({
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

    if (!isLogtoOidcConfigured("representatives")) {
      if (!shouldUseDelegateAuthDevLogin()) {
        throw new Error(
          "LOGTO_ENDPOINT, LOGTO_REPS_APP_ID, LOGTO_REPS_APP_SECRET, and NEXT_PUBLIC_REPRESENTATIVE_URL are required",
        );
      }

      const profile = buildDelegateDevAuthProfile({
        actor: "audience",
        issuer: process.env.DELEGATE_AUTH_DEV_ISSUER,
        subject: process.env.DELEGATE_AUTH_DEV_AUDIENCE_SUBJECT,
        email: process.env.DELEGATE_AUTH_DEV_AUDIENCE_EMAIL,
        name: process.env.DELEGATE_AUTH_DEV_AUDIENCE_NAME,
        representativeSlug: slug,
        audienceId: sessionState.audienceId,
      });
      const verifiedAt = new Date();
      let audienceIdentityId = contact.audienceIdentityId;
      try {
        const binding = await bindPublicAudienceAuthProfile({
          representativeId: setup.id,
          representativeSlug: slug,
          initialAudienceIdentityId: contact.audienceIdentityId,
          sessionState,
          profile,
        });
        audienceIdentityId = binding.audienceIdentityId;
        sessionState = binding.sessionState;
      } catch (error) {
        if (!isDelegateAuthPersistenceUnavailableError(error)) {
          throw error;
        }
      }
      const accountSessionOutcome =
        usesAccountSessionV2(accountSessionMode)
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
                  verificationSource: "explicit_development_bypass",
                },
              },
              persona: {
                kind: "audience",
                audienceIdentityId,
              },
              application: "PUBLIC_REPRESENTATIVES",
              publicAudienceId: sessionState.audienceId,
              allowCrossPersonaEnrollment: true,
              previousToken: cookieStore.get(
                DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
              )?.value,
              userAgent: readBoundedUserAgent(request),
              now: verifiedAt,
            })
          : null;
      const response = NextResponse.redirect(
        buildRepresentativeAuthRedirectUrl(request, returnTo),
      );
      if (usesLegacyAccountSessionAuthority(accountSessionMode)) {
        const session = createDelegateAuthSession({
          actor: "audience",
          issuer: profile.issuer,
          subject: profile.subject,
          audienceIdentityId,
          audienceId: sessionState.audienceId,
          email: profile.email ?? null,
        });
        response.cookies.set(
          DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
          signDelegateAuthSession(session, secret),
          {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecurePublicChatCookie(request),
            path: authCookiePath,
            maxAge: session.expiresAt - session.issuedAt,
          },
        );
      } else {
        response.cookies.set(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE, "", {
          httpOnly: true,
          sameSite: "lax",
          secure: shouldUseSecurePublicChatCookie(request),
          path: authCookiePath,
          maxAge: 0,
        });
      }
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
      if (accountSessionOutcome?.status === "issued") {
        setRepresentativesAppSessionCookie(
          response,
          request,
          accountSessionOutcome.session,
        );
      } else if (accountSessionOutcome?.status === "review_required") {
        if (!usesLegacyAccountSessionAuthority(accountSessionMode)) {
          throw new Error(
            "Account persona enrollment requires review before authentication can continue.",
          );
        }
        clearRepresentativesAppSessionCookie(response, request);
      }
      return response;
    }

    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const codeVerifier = generatePkceCodeVerifier();
    const authState = createDelegateRepresentativeAuthState({
      state,
      nonce,
      codeVerifier,
      returnTo,
      representativeSlug: slug,
      publicChat: sessionState,
    });
    const logtoConfig = readLogtoOidcConfig("representatives");
    const response = NextResponse.redirect(
      buildLogtoAuthorizeUrl(logtoConfig, {
        state,
        nonce,
        codeChallenge: derivePkceCodeChallenge(codeVerifier),
        prompt: "login",
      }),
    );

    response.cookies.set(
      DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE,
      signDelegateAuthState(authState, secret),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        path: DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH,
        maxAge: 10 * 60,
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
