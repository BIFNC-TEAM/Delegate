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
  isCreatorRegistrationRequiredError,
  isLogtoOidcConfigured,
  readDelegateAuthSessionSecret,
  readAccountSessionMode,
  readLogtoOidcConfig,
  resolveOwnerForAuth,
  resolveOwnerForRegistration,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
  usesAccountSessionV2,
  usesLegacyAccountSessionAuthority,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
  sanitizeCreatorReturnTo,
} from "../../../auth-guard";
import { clearCreatorAuthCookiesAndRedirect } from "../creator-auth-response";

export async function GET(request: Request) {
  try {
    const canonicalRequestUrl = buildCreatorCanonicalAuthRequestUrl(request);
    if (canonicalRequestUrl) {
      return NextResponse.redirect(canonicalRequestUrl);
    }

    const accountSessionMode = readAccountSessionMode();
    const url = new URL(request.url);
    const creatorFlow = readCreatorAuthFlow(url.searchParams.get("flow"));
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
        const { owner } = await (creatorFlow === "register"
          ? resolveOwnerForRegistration(profile)
          : resolveOwnerForAuth(profile));
        ownerId = owner.id;
      } catch (error) {
        if (!isDelegateAuthPersistenceUnavailableError(error)) {
          throw error;
        }
      }
      const accountSession =
        usesAccountSessionV2(accountSessionMode)
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
              allowCrossPersonaEnrollment: creatorFlow === "register",
              previousToken: (await cookies()).get(
                DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
              )?.value,
              userAgent: readBoundedUserAgent(request),
              now: verifiedAt,
            })
          : null;
      const response = NextResponse.redirect(
        buildCreatorRedirectUrl(returnTo, request.url),
      );
      if (usesLegacyAccountSessionAuthority(accountSessionMode)) {
        const session = createDelegateAuthSession({
          actor: "owner",
          issuer: profile.issuer,
          subject: profile.subject,
          ownerId,
          email: profile.email ?? null,
        });
        response.cookies.set(
          DELEGATE_OWNER_AUTH_SESSION_COOKIE,
          signDelegateAuthSession(session, secret),
          {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            maxAge: session.expiresAt - session.issuedAt,
          },
        );
      } else {
        response.cookies.delete(DELEGATE_OWNER_AUTH_SESSION_COOKIE);
      }
      response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
      response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
      if (accountSession) {
        setDashboardAppSessionCookie(response, accountSession);
      }
      return response;
    }

    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const codeVerifier = generatePkceCodeVerifier();
    const authState = createDelegateAuthState({
      actor: "owner",
      creatorFlow,
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
        firstScreen: creatorFlow,
        uiLocales: readLogtoUiLocales(url.searchParams.get("lang")),
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
    if (isCreatorRegistrationRequiredError(error)) {
      return clearCreatorAuthCookiesAndRedirect(
        request,
        "/auth/error?reason=creator_registration_required",
      );
    }
    if (isCreatorAdmissionRequiredError(error)) {
      return clearCreatorAuthCookiesAndRedirect(
        request,
        "/auth/error?reason=creator_access_required",
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start login.",
      },
      { status: 500 },
    );
  }
}

function readCreatorAuthFlow(value: string | null): "sign_in" | "register" {
  return value?.trim().toLowerCase() === "register"
    ? "register"
    : "sign_in";
}

function readLogtoUiLocales(value: string | null): string | undefined {
  if (value?.trim().toLowerCase() === "zh") return "zh-CN";
  if (value?.trim().toLowerCase() === "en") return "en";
  return undefined;
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
