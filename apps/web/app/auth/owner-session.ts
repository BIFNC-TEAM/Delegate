import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  DELEGATE_AUTH_SESSION_COOKIE,
  readDelegateAuthSessionSecret,
  verifyDelegateAuthSession,
  type DelegateAuthSession,
} from "@delegate/web-data";

import { sanitizeCreatorReturnTo, shouldRequireCreatorDashboardAuth } from "../../auth-guard";

export async function getOwnerAuthSession(): Promise<DelegateAuthSession | null> {
  const cookieStore = await cookies();
  const session = verifyDelegateAuthSession(
    cookieStore.get(DELEGATE_AUTH_SESSION_COOKIE)?.value,
    readDelegateAuthSessionSecret(),
  );
  return session?.actor === "owner" ? session : null;
}

export async function requireOwnerAuthSession(returnTo = "/dashboard"): Promise<DelegateAuthSession | null> {
  const session = await getOwnerAuthSession();
  if (session || !shouldRequireCreatorDashboardAuth()) {
    return session;
  }

  redirect(`/auth/login?actor=owner&returnTo=${encodeURIComponent(sanitizeCreatorReturnTo(returnTo))}`);
}
