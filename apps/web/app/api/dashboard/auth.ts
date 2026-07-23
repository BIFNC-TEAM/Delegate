import { NextResponse } from "next/server";

import {
  RepresentativeAccessError,
  assertOwnerCanAccessRepresentative,
} from "@delegate/web-data";

import { getOwnerAuthSession } from "../../auth/owner-session";
import { shouldRequireCreatorDashboardAuth } from "../../../auth-guard";

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

export async function authorizeDashboardRepresentativeAccess(representativeSlug: string) {
  try {
    await requireDashboardRepresentativeAccess(representativeSlug);
    return null;
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }
    return NextResponse.json({ error: "Failed to authorize dashboard access." }, { status: 500 });
  }
}

export function dashboardAuthErrorResponse(error: unknown) {
  if (error instanceof RepresentativeAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  return null;
}
