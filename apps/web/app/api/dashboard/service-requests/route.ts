import { NextResponse } from "next/server";
import { queryServiceRequestOperation, serviceRequestPublicResult, ServiceRequestError } from "@delegate/web-data";
import { requireDashboardApiOwnerSession, dashboardAuthErrorResponse } from "../auth";
export async function GET(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    if (!session?.ownerId) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const result = await queryServiceRequestOperation({ role: "owner", ownerId: session.ownerId,
      representativeId: params.get("representativeId") ?? "" }, params);
    return NextResponse.json(serviceRequestPublicResult(result), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return dashboardAuthErrorResponse(error) ?? NextResponse.json({ error: error instanceof ServiceRequestError ? error.code : "service_unavailable" },
      { status: error instanceof ServiceRequestError ? error.status : 500 });
  }
}
