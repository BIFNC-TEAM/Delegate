import { searchClawHubRepresentativeSkills } from "@delegate/registry";
import { NextResponse } from "next/server";

import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
} from "../../../dashboard/auth";
import { withPrivateNoStore } from "../../../private-response";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim() ?? "";
  const limit = Number.parseInt(searchParams.get("limit") ?? "8", 10);

  try {
    await requireDashboardApiOwnerSession();
    const results = await searchClawHubRepresentativeSkills({
      query,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 8,
    });

    return withPrivateNoStore(NextResponse.json({ results }));
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(NextResponse.json(
      { error: "ClawHub skill search is temporarily unavailable." },
      { status: 502 },
    ));
  }
}
