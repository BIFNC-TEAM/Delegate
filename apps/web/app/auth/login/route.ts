import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateAuthState,
  derivePkceCodeChallenge,
  generateAuthStateToken,
  generatePkceCodeVerifier,
  issueAccountSessionShadow,
  isDelegateAuthPersistenceUnavailableError,
  isCreatorAdmissionRequiredError,
  isLogtoOidcConfigured,
  readDelegateAuthSessionSecret,
  readAccountSessionMode,
  readLogtoOidcConfig,
  resolveOwnerForAuth,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
  usesLegacyAccountSessionAuthority,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
  sanitizeCreatorReturnTo,
} from "../../../auth-guard";

export async function GET(request: Request) {
  try {
    const canonicalRequestUrl = buildCreatorCanonicalAuthRequestUrl(request);
    if (canonicalRequestUrl) {
      return NextResponse.redirect(canonicalRequestUrl);
    }

    const accountSessionMode = readAccountSessionMode();
    if (!usesLegacyAccountSessionAuthority(accountSessionMode)) {
      return accountSessionAuthorityUnavailableResponse();
    }

    const url = new URL(request.url);
    const returnTo = sanitizeCreatorReturnTo(url.searchParams.get("returnTo"));
    const secret = readDelegateAuthSessionSecret();

    if (!isLogtoOidcConfigured("dashboard")) {
      if (!shouldUseDelegateAuthDevLogin()) {
        throw new Error(
          "LOGTO_ENDPOINT, LOGTO_DASHBOARD_APP_ID, LOGTO_DASHBOARD_APP_SECRET, and NEXT_PUBLIC_DASHBOARD_URL are required",
        );
      }

      const profile = buildDelegateDevAuthProfile({
        actor: "owner",
        issuer: process.env.DELEGATE_AUTH_DEV_ISSUER,
        subject: process.env.DELEGATE_AUTH_DEV_OWNER_SUBJECT,
        email: process.env.DELEGATE_AUTH_DEV_OWNER_EMAIL,
        name: process.env.DELEGATE_AUTH_DEV_OWNER_NAME,
      });
      const verifiedAt = new Date();
      let ownerId = "delegate-dev-owner";
      try {
        const { owner } = await resolveOwnerForAuth(profile);
        ownerId = owner.id;
      } catch (error) {
        if (!isDelegateAuthPersistenceUnavailableError(error)) {
          throw error;
        }
      }
      const shadowSession =
        accountSessionMode === "shadow"
          ? await issueAccountSessionShadow({
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
              persona: { kind: "owner", ownerId },
              application: "DASHBOARD",
              previousToken: (await cookies()).get(
                DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
              )?.value,
              userAgent: readBoundedUserAgent(request),
              now: verifiedAt,
            })
          : null;
      const session = createDelegateAuthSession({
        actor: "owner",
        issuer: profile.issuer,
        subject: profile.subject,
        ownerId,
        email: profile.email ?? null,
      });
      const response = NextResponse.redirect(
        buildCreatorRedirectUrl(returnTo, request.url),
      );
      response.cookies.set(DELEGATE_OWNER_AUTH_SESSION_COOKIE, signDelegateAuthSession(session, secret), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: session.expiresAt - session.issuedAt,
      });
      response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
      response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
      if (shadowSession) {
        setDashboardAppSessionCookie(response, shadowSession);
      }
      return response;
    }

    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const codeVerifier = generatePkceCodeVerifier();
    const authState = createDelegateAuthState({
      actor: "owner",
      state,
      nonce,
      codeVerifier,
      returnTo,
    });
    const response = NextResponse.redirect(
      buildLogtoAuthorizeUrl(readLogtoOidcConfig("dashboard"), {
        state,
        nonce,
        codeChallenge: derivePkceCodeChallenge(codeVerifier),
      }),
    );

    response.cookies.set(
      DELEGATE_OWNER_AUTH_STATE_COOKIE,
      signDelegateAuthState(authState, readDelegateAuthSessionSecret()),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 10 * 60,
      },
    );
    response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
    return response;
  } catch (error) {
    if (isCreatorAdmissionRequiredError(error)) {
      const response = NextResponse.redirect(
        buildCreatorRedirectUrl(
          "/auth/error?reason=creator_access_required",
          request.url,
        ),
        303,
      );
      response.cookies.delete(DELEGATE_OWNER_AUTH_SESSION_COOKIE);
      response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
      response.cookies.delete(DELEGATE_DASHBOARD_APP_SESSION_COOKIE);
      response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
      response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
      return response;
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start login.",
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

function readBoundedUserAgent(request: Request): string | null {
  return request.headers.get("user-agent")?.trim().slice(0, 512) || null;
}

function setDashboardAppSessionCookie(
  response: NextResponse,
  issued: Awaited<ReturnType<typeof issueAccountSessionShadow>>,
) {
  response.cookies.set(
    DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
    issued.token,
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
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
