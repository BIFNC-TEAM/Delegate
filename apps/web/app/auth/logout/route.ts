import { NextResponse } from "next/server";

import {
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
} from "@delegate/web-data";

import {
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl,
} from "../../../auth-guard";

export async function GET(request: Request) {
  try {
    const canonicalRequestUrl = buildCreatorCanonicalAuthRequestUrl(request);
    if (canonicalRequestUrl) {
      return NextResponse.redirect(canonicalRequestUrl);
    }

    const url = new URL(request.url);
    const response = NextResponse.redirect(
      buildCreatorRedirectUrl(
        url.searchParams.get("returnTo") ?? "/",
        request.url,
        process.env,
        "/",
      ),
    );
    response.cookies.delete(DELEGATE_OWNER_AUTH_SESSION_COOKIE);
    response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
    response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to log out.",
      },
      { status: 500 },
    );
  }
}
