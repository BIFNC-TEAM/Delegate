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


export async function POST(request: Request) {
  try {
    const actor = await principal();
    const expectedOrigin = new URL(process.env.NEXT_PUBLIC_DASHBOARD_URL || request.url).origin;
    if (request.headers.get("origin") !== expectedOrigin) throw new IdentityProfileError(403, "Origin mismatch.");
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data;")) throw new IdentityProfileError(415, "Choose an image file.");
    const limit = 5 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > limit + 65536) throw new IdentityProfileError(413, "Avatar exceeds 5 MB.");
    if (!request.body) throw new IdentityProfileError(400, "Missing avatar file.");
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > limit + 65536) { await reader.cancel(); throw new IdentityProfileError(413, "Avatar exceeds 5 MB."); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData()
      .catch(() => { throw new IdentityProfileError(400, "Invalid upload form."); });
    const entries = [...form.entries()]; const file = form.get("avatar");
    if (entries.length !== 1 || entries[0]?.[0] !== "avatar" || !(file instanceof File) || !file.size) throw new IdentityProfileError(400, "Choose one avatar image.");
    if (file.size > limit) throw new IdentityProfileError(413, "Avatar exceeds 5 MB.");
    const bytes = Buffer.from(await file.arrayBuffer());
    return withPrivateNoStore(NextResponse.json(await requestOwnerProfile(actor, "avatar-upload", { base64: bytes.toString("base64") })));
  } catch (error) { return failure(error); }
}
