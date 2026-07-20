import { NextResponse } from "next/server";

import { setHandoffRequestStatus } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; handoffId: string }> },
) {
  const { slug, handoffId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }
  const body = (await request.json()) as {
    status?: "open" | "reviewing" | "accepted" | "declined" | "closed";
  };

  if (!body.status) {
    return NextResponse.json({ error: "status is required." }, { status: 400 });
  }

  try {
    const handoff = await setHandoffRequestStatus({
      representativeSlug: slug,
      handoffId,
      status: body.status,
    });

    return NextResponse.json({ handoff });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update handoff request status.",
      },
      { status: 500 },
    );
  }
}
