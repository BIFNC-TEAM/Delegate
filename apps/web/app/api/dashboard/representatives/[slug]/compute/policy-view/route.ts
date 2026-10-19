import { NextResponse } from "next/server";
import { getRepresentativeComputePolicyView } from "@delegate/web-data";
import { dashboardAuthErrorResponse, requireDashboardRepresentativeAccess } from "../../../../auth";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    await requireDashboardRepresentativeAccess(slug);
    const view = await getRepresentativeComputePolicyView(slug);
    return NextResponse.json(view ?? { error: "Representative not found." }, {
      status: view ? 200 : 404, headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: "Current compute policy is unavailable." }, {
      status: 503, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
