import { NextResponse } from "next/server";

import {
  DELEGATE_AUTH_STATE_COOKIE,
  buildLogtoAuthorizeUrl,
  createDelegateAuthState,
  generateAuthStateToken,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  signDelegateAuthState,
} from "@delegate/web-data";

import { sanitizeCreatorReturnTo } from "../../../auth-guard";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const actor = url.searchParams.get("actor") === "audience" ? "audience" : "owner";
    const returnTo = sanitizeCreatorReturnTo(url.searchParams.get("returnTo"));
    const state = generateAuthStateToken();
    const nonce = generateAuthStateToken();
    const authState = createDelegateAuthState({
      actor,
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
      DELEGATE_AUTH_STATE_COOKIE,
      signDelegateAuthState(authState, readDelegateAuthSessionSecret()),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 10 * 60,
      },
    );
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
