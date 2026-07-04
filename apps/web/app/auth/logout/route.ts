import { NextResponse } from "next/server";

import { DELEGATE_AUTH_SESSION_COOKIE, DELEGATE_AUTH_STATE_COOKIE } from "@delegate/web-data";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  const response = NextResponse.redirect(
    new URL(returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", request.url),
  );
  response.cookies.delete(DELEGATE_AUTH_SESSION_COOKIE);
  response.cookies.delete(DELEGATE_AUTH_STATE_COOKIE);
  return response;
}
