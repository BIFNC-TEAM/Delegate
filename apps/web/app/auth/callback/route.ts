import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession,
  exchangeLogtoCodeForTokens,
  issueAccountSessionShadow,
  isCreatorAdmissionRequiredError,
  isCreatorRegistrationRequiredError,
  readDelegateAuthSessionSecret,
  readAccountSessionMode,
  readLogtoOidcConfig,
  resolveOwnerForAuth,
  resolveOwnerForRegistration,
  signDelegateAuthSession,
  usesAccountSessionV2,
  usesLegacyAccountSessionAuthority,
  verifyDelegateAuthState,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
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
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return NextResponse.json({ error: "Missing Logto callback code or state." }, { status: 400 });
    }

    const cookieStore = await cookies();
    const secret = readDelegateAuthSessionSecret();
    const authState =
      verifyDelegateAuthState(cookieStore.get(DELEGATE_OWNER_AUTH_STATE_COOKIE)?.value, secret) ??
      verifyDelegateAuthState(cookieStore.get(LEGACY_DELEGATE_AUTH_STATE_COOKIE)?.value, secret);
    if (!authState || authState.state !== state || authState.actor !== "owner") {
      return NextResponse.json({ error: "Invalid or expired login state." }, { status: 400 });
    }

    const logtoConfig = readLogtoOidcConfig("dashboard");
    const tokens = await exchangeLogtoCodeForTokens(logtoConfig, {
      code,
      codeVerifier: authState.version === 2 ? authState.codeVerifier : undefined,
    });
    if (!tokens.idToken) {
      return NextResponse.json({ error: "Logto did not return an id_token." }, { status: 400 });
    }

    const profile = await buildVerifiedExternalAuthProfileFromLogtoIdToken(logtoConfig, {
      idToken: tokens.idToken,
      nonce: authState.nonce,
    });
    const verifiedAt = new Date();
    const creatorFlow =
      authState.version === 2 && authState.creatorFlow === "register"
        ? "register"
        : "sign_in";
    const { owner } = await (creatorFlow === "register"
      ? resolveOwnerForRegistration(profile)
      : resolveOwnerForAuth(profile));
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
                verificationSource: "logto_jwks_callback",
              },
            },
            persona: { kind: "owner", ownerId: owner.id },
            application: "DASHBOARD",
            allowCrossPersonaEnrollment: creatorFlow === "register",
            previousToken: cookieStore.get(
              DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
            )?.value,
            userAgent: readBoundedUserAgent(request),
            now: verifiedAt,
          })
        : null;
    const response = NextResponse.redirect(
      buildCreatorRedirectUrl(authState.returnTo, request.url),
    );
    if (usesLegacyAccountSessionAuthority(accountSessionMode)) {
      const session = createDelegateAuthSession({
        actor: "owner",
        issuer: profile.issuer,
        subject: profile.subject,
        ownerId: owner.id,
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
    response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
    if (accountSession) {
      setDashboardAppSessionCookie(response, accountSession);
    }
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
        error: error instanceof Error ? error.message : "Failed to complete login.",
      },
      { status: 500 },
    );
  }
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
