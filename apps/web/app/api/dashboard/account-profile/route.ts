import { requestOwnerProfile } from "./client";
import { NextResponse } from "next/server";
import { IdentityProfileError } from "@delegate/web-data/owner-identity-profile";
import { requireDashboardApiOwnerSession, dashboardAuthErrorResponse } from "../auth";
import { withPrivateNoStore } from "../../private-response";

async function principal() {
  const session = await requireDashboardApiOwnerSession();
  if (!session?.ownerId || !session.issuer || !session.subject) throw new IdentityProfileError(401, "Authentication required.");
  return { ownerId: session.ownerId, issuer: session.issuer, subject: session.subject };
}
function failure(error: unknown) {
  return dashboardAuthErrorResponse(error) ?? withPrivateNoStore(NextResponse.json({ error: error instanceof IdentityProfileError ? error.message : "Account profile is temporarily unavailable." }, { status: error instanceof IdentityProfileError ? error.status : 503 }));
}
export async function GET() {
  try { return withPrivateNoStore(NextResponse.json(await requestOwnerProfile(await principal(), "get"))); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const actor = await principal();
    const expectedOrigin = new URL(process.env.NEXT_PUBLIC_DASHBOARD_URL || request.url).origin;
    if (request.headers.get('origin') !== expectedOrigin) throw new IdentityProfileError(403, "Origin mismatch.");
    const body = await request.json().catch(() => { throw new IdentityProfileError(400, "Invalid JSON request."); });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== 'avatar')) throw new IdentityProfileError(400, "Invalid avatar request.");
    return withPrivateNoStore(NextResponse.json(await requestOwnerProfile(actor, "avatar", body.avatar)));
  } catch (error) { return failure(error); }
}
