import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  readAccountSessionMode,
  readDelegateAuthSessionSecret,
  verifyDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
  type DelegateAuthSession,
} from "@delegate/web-data";

import { sanitizeCreatorReturnTo, shouldRequireCreatorDashboardAuth } from "../../auth-guard";

export async function getOwnerAuthSession(): Promise<DelegateAuthSession | null> {
  if (!usesLegacyAccountSessionAuthority(readAccountSessionMode())) {
    return null;
  }
  const cookieStore = await cookies();
  const secret = readDelegateAuthSessionSecret();
  const session =
    verifyDelegateAuthSession(cookieStore.get(DELEGATE_OWNER_AUTH_SESSION_COOKIE)?.value, secret) ??
    verifyDelegateAuthSession(cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value, secret);
  return session?.actor === "owner" ? session : null;
}

export async function requireOwnerAuthSession(returnTo = "/dashboard"): Promise<DelegateAuthSession | null> {
  const session = await getOwnerAuthSession();
  if (session || !shouldRequireCreatorDashboardAuth()) {
    return session;
  }

  redirect(`/auth/login?actor=owner&returnTo=${encodeURIComponent(sanitizeCreatorReturnTo(returnTo))}`);
}
