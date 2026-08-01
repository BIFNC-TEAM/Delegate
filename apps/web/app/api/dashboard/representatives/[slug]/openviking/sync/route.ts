import { NextResponse } from "next/server";

import { syncRepresentativeOpenVikingResources } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { toDashboardGovernedContextDto } from "../safe-dto";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const snapshot = await syncRepresentativeOpenVikingResources({
      representativeSlug: slug,
      trigger: "manual",
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
    });
    return withPrivateNoStore(
      NextResponse.json(toDashboardGovernedContextDto(snapshot)),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(
      NextResponse.json(
        {
          error: "Failed to sync the current published representative version.",
        },
        { status: 500 },
      ),
    );
  }
}
