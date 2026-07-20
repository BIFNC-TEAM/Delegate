import { NextResponse } from "next/server";

import { getOpenVikingHealthSnapshot } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
} from "../../auth";

export async function GET() {
  try {
    await requireDashboardApiOwnerSession();
    const health = await getOpenVikingHealthSnapshot();
    return NextResponse.json(health);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to check OpenViking health.",
      },
      { status: 500 },
    );
  }
}
