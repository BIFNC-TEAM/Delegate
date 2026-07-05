import { NextResponse } from "next/server";

import { getRepresentativeResourceGovernance } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const snapshot = await getRepresentativeResourceGovernance(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load resource governance.",
      },
      { status: 500 },
    );
  }
}
