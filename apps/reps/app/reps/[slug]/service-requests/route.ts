import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { serviceRequestPublicResult, executeServiceRequestOperation, queryServiceRequestOperation, getServiceRequestVisitorContext,
  getPublicRepresentativeRuntime, ServiceRequestError } from "@delegate/web-data";
import { resolvePublicAudienceRequestPrincipal, publicAudiencePrincipalErrorStatus, setPublicAudienceSessionCookie } from "../public-principal";
async function handle(request: Request, params: Promise<{ slug: string }>) {
  try {
    const { slug } = await params;
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return response({ error: "Representative unavailable." }, 404);
    const principal = await resolvePublicAudienceRequestPrincipal({ representativeSlug: slug, cookieStore: await cookies() });
    await principal.revalidate();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    if (!conversationId) return response({ error: "conversationId is required." }, 400);
    const context = await getServiceRequestVisitorContext(slug, principal.principal.audienceIdentityId, conversationId);
    const result = request.method === "GET" ? await queryServiceRequestOperation(context.actor, url.searchParams)
      : await executeServiceRequestOperation(context, await request.json());
    await principal.revalidate();
    const output = response(result);
    setPublicAudienceSessionCookie(output, request, slug, principal.sessionState);
    return output;
  } catch (error) {
    const status = publicAudiencePrincipalErrorStatus(error);
    return response({ error: error instanceof ServiceRequestError ? error.code : "Unable to process service request." },
      status ?? (error instanceof ServiceRequestError ? error.status : error instanceof SyntaxError ? 400 : 500));
  }
}
function response(value: unknown, status = 200) { return NextResponse.json(serviceRequestPublicResult(value), { status, headers: { "Cache-Control": "private, no-store" } }); }
export function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
export function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
