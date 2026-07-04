import { NextResponse } from "next/server";

import {
  RepresentativeAccessError,
  assertOwnerCanAccessRepresentative,
} from "@delegate/web-data";

import { getOwnerAuthSession } from "../../auth/owner-session";
import { shouldRequireCreatorDashboardAuth } from "../../../auth-guard";

export async function requireDashboardApiOwnerSession() {
  const session = await getOwnerAuthSession();
  if (session || !shouldRequireCreatorDashboardAuth()) {
    return session;
  }

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

export function dashboardAuthErrorResponse(error: unknown) {
  if (error instanceof RepresentativeAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  return null;
}
