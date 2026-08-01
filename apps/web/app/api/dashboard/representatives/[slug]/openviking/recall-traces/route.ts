import { NextResponse } from "next/server";

import { getRepresentativeOpenVikingRecallUsage } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const usage = await getRepresentativeOpenVikingRecallUsage(slug);
    return withPrivateNoStore(
      NextResponse.json({
        usage: {
          today: Math.max(0, usage.today),
          total: Math.max(0, usage.total),
        },
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(
      NextResponse.json(
        {
          error: "Failed to load context usage records.",
        },
        { status: 500 },
      ),
    );
  }
}
