import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  readAccountSessionMode,
  readDelegateAuthSessionSecret,
  observeAccountSessionParity,
  resolveAccountSessionAuthority,
  verifyDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
  type DashboardAccountSessionPrincipal,
  type DelegateAuthSession,
} from "@delegate/web-data";

import { sanitizeCreatorReturnTo, shouldRequireCreatorDashboardAuth } from "../../auth-guard";

export type OwnerAuthSession =
  | DelegateAuthSession
  | DashboardAccountSessionPrincipal;

export async function getOwnerAuthSession(): Promise<OwnerAuthSession | null> {
  const accountSessionMode = readAccountSessionMode();
  const cookieStore = await cookies();
  if (!usesLegacyAccountSessionAuthority(accountSessionMode)) {
    const token = cookieStore.get(
      DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
    )?.value;
    if (!token) return null;
    const principal = await resolveAccountSessionAuthority({
      token,
      application: "DASHBOARD",
    });
    return principal?.actor === "owner" ? principal : null;
  }
  const secret = readDelegateAuthSessionSecret();
  const session =
    verifyDelegateAuthSession(cookieStore.get(DELEGATE_OWNER_AUTH_SESSION_COOKIE)?.value, secret) ??
    verifyDelegateAuthSession(cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value, secret);
  const ownerSession = session?.actor === "owner" ? session : null;
  if (accountSessionMode === "shadow" && ownerSession?.ownerId) {
    const v2Token = cookieStore.get(
      DELEGATE_DASHBOARD_APP_SESSION_COOKIE,
    )?.value ?? null;
    const v2Principal = v2Token
      ? await resolveAccountSessionAuthority({
          token: v2Token,
          application: "DASHBOARD",
        }).catch(() => null)
      : null;
    observeAccountSessionParity({
      application: "DASHBOARD",
      legacy: {
        actor: "owner",
        issuer: ownerSession.issuer,
        subject: ownerSession.subject,
        personaId: ownerSession.ownerId,
      },
      v2:
        v2Principal?.actor === "owner"
          ? {
              actor: "owner",
              issuer: v2Principal.issuer,
              subject: v2Principal.subject,
              personaId: v2Principal.ownerId,
            }
          : null,
      v2Token,
    });
  }
  return ownerSession;
}

export async function requireOwnerAuthSession(
  returnTo = "/dashboard",
): Promise<OwnerAuthSession | null> {
  const session = await getOwnerAuthSession();
  if (session || !shouldRequireCreatorDashboardAuth()) {
    return session;
  }

  redirect(`/auth/login?actor=owner&returnTo=${encodeURIComponent(sanitizeCreatorReturnTo(returnTo))}`);
}
