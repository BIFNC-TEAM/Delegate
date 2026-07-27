import { NextResponse } from "next/server";

import {
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateAuthState,
  generateAuthStateToken,
  isDelegateAuthPersistenceUnavailableError,
  isLogtoOidcConfigured,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  resolveOwnerForAuth,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
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

    const url = new URL(request.url);
    const returnTo = sanitizeCreatorReturnTo(url.searchParams.get("returnTo"));
    const secret = readDelegateAuthSessionSecret();

    if (!isLogtoOidcConfigured()) {
      if (!shouldUseDelegateAuthDevLogin()) {
        throw new Error("LOGTO_ENDPOINT, LOGTO_APP_ID, LOGTO_APP_SECRET, and LOGTO_REDIRECT_URI are required");
      }

      const profile = buildDelegateDevAuthProfile({
        actor: "owner",
        subject: process.env.DELEGATE_AUTH_DEV_OWNER_SUBJECT,
        email: process.env.DELEGATE_AUTH_DEV_OWNER_EMAIL,
        name: process.env.DELEGATE_AUTH_DEV_OWNER_NAME,
      });
      let ownerId = "delegate-dev-owner";
      try {
        const { owner } = await resolveOwnerForAuth(profile);
        ownerId = owner.id;
      } catch (error) {
        if (!isDelegateAuthPersistenceUnavailableError(error)) {
          throw error;
        }
      }
      const session = createDelegateAuthSession({
        actor: "owner",
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
      return response;
    }

    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const authState = createDelegateAuthState({
      actor: "owner",
      state,
      nonce,
      returnTo,
    });
    const response = NextResponse.redirect(
      buildLogtoAuthorizeUrl(readLogtoOidcConfig(), {
        state,
        nonce,
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
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start login.",
      },
      { status: 500 },
    );
  }
}
