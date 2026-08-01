import { NextResponse } from "next/server";

import {
  RepresentativeAccessError,
  assertOwnerCanAccessRepresentative,
  assertOwnerCanManageBilling,
} from "@delegate/web-data";

import { getOwnerAuthSession } from "../../auth/owner-session";
import { shouldRequireCreatorDashboardAuth } from "../../../auth-guard";
import { withPrivateNoStore } from "../private-response";

export async function requireDashboardApiOwnerSession() {
  const session = await getOwnerAuthSession();
  if (session?.ownerId?.trim()) {
    return session;
  }
  if (!session && !shouldRequireCreatorDashboardAuth()) return null;

  throw new RepresentativeAccessError("Authentication required.", 401);
}

export async function requireDashboardRepresentativeAccess(representativeSlug: string) {
  const session = await requireDashboardApiOwnerSession();
  if (!session?.ownerId) {
    return session;
  }

  await assertOwnerCanAccessRepresentative({
    ownerId: session.ownerId,
    representativeSlug,
  });
  return session;
}

export function resolveDashboardSessionActor(
  session: {
    ownerId?: string | undefined;
    email?: string | null | undefined;
  } | null,
) {
  const ownerId = session?.ownerId?.trim();
  if (ownerId) return ownerId;

  const email = session?.email?.trim().toLowerCase();
  if (email) return email;

  if (!session && !shouldRequireCreatorDashboardAuth()) {
    return "local-owner";
  }
  throw new RepresentativeAccessError("Authentication required.", 401);
}

export async function requireDashboardRepresentativeAccessActor(
  representativeSlug: string,
) {
  const session = await requireDashboardRepresentativeAccess(representativeSlug);
  return resolveDashboardSessionActor(session);
}

export async function requireDashboardBillingAccess() {
  const session = await requireDashboardApiOwnerSession();
  const ownerId = session?.ownerId?.trim();
  if (!ownerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }

  await assertOwnerCanManageBilling(ownerId);
  return { ...session, ownerId };
}

export async function requireDashboardRepresentativeBillingAccess(
  representativeSlug: string,
) {
  const session = await requireDashboardBillingAccess();
  await assertOwnerCanAccessRepresentative({
    ownerId: session.ownerId,
    representativeSlug,
  });
  return session;
}

export async function authorizeDashboardRepresentativeAccess(representativeSlug: string) {
  try {
    await requireDashboardRepresentativeAccess(representativeSlug);
    return null;
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }
    return withPrivateNoStore(
      NextResponse.json({ error: "Failed to authorize dashboard access." }, { status: 500 }),
    );
  }
}

export function dashboardAuthErrorResponse(error: unknown) {
  if (error instanceof RepresentativeAccessError) {
    return withPrivateNoStore(
      NextResponse.json({ error: error.message }, { status: error.statusCode }),
    );
  }
  return null;
}
