import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPublicCitationSources, getPublicRepresentativeRuntime, PublicCitationSourceError } from "@delegate/web-data";
import { publicAudiencePrincipalErrorStatus, resolvePublicAudienceRequestPrincipal, setPublicAudienceSessionCookie } from "../../public-principal";

const privateJson = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return privateJson({ error: "Representative is not publicly available." }, runtime.status === "paused" ? 423 : 404);
    const payload: unknown = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return privateJson({ error: "Invalid citation request." }, 400);
    const body = payload as Record<string, unknown>;
    if (Object.keys(body).some(key => !["messageId", "rangeId"].includes(key)) || typeof body.messageId !== "string" || typeof body.rangeId !== "string"
      || !body.messageId.trim() || !body.rangeId.trim() || body.messageId.length > 191 || body.rangeId.length > 191) return privateJson({ error: "Invalid citation request." }, 400);
    const { principal, sessionState } = await resolvePublicAudienceRequestPrincipal({ representativeSlug: slug, cookieStore: await cookies() });
    const result = await getPublicCitationSources({ representativeSlug: slug, audienceIdentityId: principal.audienceIdentityId, audienceId: principal.audienceId,
      messageId: body.messageId.trim(), rangeId: body.rangeId.trim() });
    const response = privateJson(result, 200);
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    const principalStatus = publicAudiencePrincipalErrorStatus(error);
    if (principalStatus) return privateJson({ error: principalStatus === 401 ? "Authentication required." : "Audience account requires reconciliation." }, principalStatus);
    if (error instanceof PublicCitationSourceError) return privateJson({ error: error.status === 404 ? "Citation not found." : "Invalid citation request." }, error.status);
    console.error("Failed to load public citation sources.");
    return privateJson({ error: "Source information is unavailable." }, 500);
  }
}
