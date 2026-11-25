import { generateServiceRequestOptions } from "@delegate/model-runtime";
import { NextResponse } from "next/server";
import { serviceRequestPublicResult, executeServiceRequestOperation, queryServiceRequestOperation, getServiceRequestOwnerActor, ServiceRequestError } from "@delegate/web-data";
import { requireDashboardRepresentativeAccess, dashboardAuthErrorResponse } from "../../../auth";
async function handle(request: Request, params: Promise<{ slug: string }>) {
  try {
    const { slug } = await params;
    const session = await requireDashboardRepresentativeAccess(slug);
    // This new write surface never accepts the unauthenticated local-owner fallback.
    if (!session?.ownerId) return response({ error: "Authentication required." }, 401);
    const actor = await getServiceRequestOwnerActor(slug, session.ownerId);
    if (request.method === "GET") return response(await queryServiceRequestOperation(actor, new URL(request.url).searchParams));
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const value = body as Record<string, unknown>;
      const item = value.item as { content?: unknown } | undefined;
      if (value.operation === "successor" && value.mode === "follow_up" && typeof item?.content === "string" && item.content.length <= 8000) {
        value.options = await generateServiceRequestOptions(item.content);
      }
    }
    return response(await executeServiceRequestOperation({ actor }, body));
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error);
    if (auth) return auth;
    return response({ error: error instanceof ServiceRequestError ? error.code : "Unable to process service request." }, error instanceof ServiceRequestError ? error.status : error instanceof SyntaxError ? 400 : 500);
  }
}
function response(value: unknown, status = 200) { return NextResponse.json(serviceRequestPublicResult(value), { status, headers: { "Cache-Control": "private, no-store" } }); }
export function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
export function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
