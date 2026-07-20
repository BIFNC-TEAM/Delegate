import { NextResponse } from "next/server";

import { syncRepresentativeOpenVikingResources } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const snapshot = await syncRepresentativeOpenVikingResources({
      representativeSlug: slug,
      trigger: "manual",
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to sync representative public knowledge into OpenViking.",
      },
      { status: 500 },
    );
  }
}
