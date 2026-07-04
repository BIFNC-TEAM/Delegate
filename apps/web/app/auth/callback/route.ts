import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUTH_SESSION_COOKIE,
  DELEGATE_AUTH_STATE_COOKIE,
  buildExternalAuthProfileFromLogtoIdToken,
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
    const authState = verifyDelegateAuthState(cookieStore.get(DELEGATE_AUTH_STATE_COOKIE)?.value, secret);
    if (!authState || authState.state !== state || authState.actor !== "owner") {
      return NextResponse.json({ error: "Invalid or expired login state." }, { status: 400 });
    }

    const tokens = await exchangeLogtoCodeForTokens(readLogtoOidcConfig(), { code });
    if (!tokens.idToken) {
      return NextResponse.json({ error: "Logto did not return an id_token." }, { status: 400 });
    }

    const profile = buildExternalAuthProfileFromLogtoIdToken(tokens.idToken);
    const { owner } = await resolveOwnerForAuth(profile);
    const session = createDelegateAuthSession({
      actor: "owner",
      subject: profile.subject,
      ownerId: owner.id,
      email: profile.email ?? null,
    });
    const response = NextResponse.redirect(new URL(authState.returnTo, request.url));
    response.cookies.set(DELEGATE_AUTH_SESSION_COOKIE, signDelegateAuthSession(session, secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.expiresAt - session.issuedAt,
    });
    response.cookies.delete(DELEGATE_AUTH_STATE_COOKIE);
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
