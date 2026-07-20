import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession,
  exchangeLogtoCodeForTokens,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  resolveOwnerForAuth,
  signDelegateAuthSession,
  verifyDelegateAuthState,
} from "@delegate/web-data";

export async function GET(request: Request) {
  try {
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

    const logtoConfig = readLogtoOidcConfig();
    const tokens = await exchangeLogtoCodeForTokens(logtoConfig, { code });
    if (!tokens.idToken) {
      return NextResponse.json({ error: "Logto did not return an id_token." }, { status: 400 });
    }

    const profile = await buildVerifiedExternalAuthProfileFromLogtoIdToken(logtoConfig, {
      idToken: tokens.idToken,
      nonce: authState.nonce,
    });
    const { owner } = await resolveOwnerForAuth(profile);
    const session = createDelegateAuthSession({
      actor: "owner",
      subject: profile.subject,
      ownerId: owner.id,
      email: profile.email ?? null,
    });
    const response = NextResponse.redirect(new URL(authState.returnTo, request.url));
    response.cookies.set(DELEGATE_OWNER_AUTH_SESSION_COOKIE, signDelegateAuthSession(session, secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.expiresAt - session.issuedAt,
    });
    response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to complete login.",
      },
      { status: 500 },
    );
  }
}
