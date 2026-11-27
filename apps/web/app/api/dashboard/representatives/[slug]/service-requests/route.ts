import { generateServiceRequestOptions } from "@delegate/model-runtime";
import { NextResponse } from "next/server";
import { serviceRequestPublicResult, executeServiceRequestOperation, queryServiceRequestOperation, getServiceRequestOwnerActor, ServiceRequestError } from "@delegate/web-data";
import { requireDashboardApiOwnerSession, dashboardAuthErrorResponse } from "../../../auth";
async function handle(request: Request, params: Promise<{ slug: string }>) {
  try {
    const { slug } = await params;
    const session = await requireDashboardApiOwnerSession();
    // This new write surface never accepts the unauthenticated local-owner fallback.
    if (!session?.ownerId) return response({ error: "Authentication required." }, 401);
    const actor = await getServiceRequestOwnerActor(slug, session.ownerId);
    if (request.method === "GET") return response(await queryServiceRequestOperation(actor, new URL(request.url).searchParams));
    const body: unknown = await request.json();

    return response(await executeServiceRequestOperation({ actor, generateOptions: generateServiceRequestOptions }, body));
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error);
    if (auth) return auth;
    return response({ error: error instanceof ServiceRequestError ? error.code : "Unable to process service request." }, error instanceof ServiceRequestError ? error.status : error instanceof SyntaxError ? 400 : 500);
  }
}
function response(value: unknown, status = 200) { return NextResponse.json(serviceRequestPublicResult(value), { status, headers: { "Cache-Control": "private, no-store" } }); }
export function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
export function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) { return handle(request, params); }
