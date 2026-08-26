import { NextResponse } from "next/server";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_STATE_COOKIE,
} from "@delegate/web-data";

import { buildCreatorRedirectUrl } from "../../auth-guard";

export function clearCreatorAuthCookiesAndRedirect(
  request: Request,
  pathname: string,
) {
  const response = NextResponse.redirect(
    buildCreatorRedirectUrl(pathname, request.url),
    303,
  );
  response.cookies.delete(DELEGATE_OWNER_AUTH_SESSION_COOKIE);
  response.cookies.delete(DELEGATE_OWNER_AUTH_STATE_COOKIE);
  response.cookies.delete(DELEGATE_DASHBOARD_APP_SESSION_COOKIE);
  response.cookies.delete(LEGACY_DELEGATE_AUTH_SESSION_COOKIE);
  response.cookies.delete(LEGACY_DELEGATE_AUTH_STATE_COOKIE);
  return response;
}
