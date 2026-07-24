import { NextResponse } from "next/server";

import { refreshOwnerChannelHealth } from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../../auth";
import { channelManagementErrorResponse } from "../../errors";
import { resolveChannelRequestMetadata } from "../../request-metadata";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bindingId: string }> },
) {
  const { bindingId } = await params;
  try {
    const session = await requireDashboardApiOwnerSession();
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const binding = await refreshOwnerChannelHealth({
      ownerId: actorId,
      actorId,
      bindingId,
      ...requestMetadata,
    });
    return NextResponse.json(
      {
        binding,
        requestId: requestMetadata.requestId,
        checkScope: "configuration_and_recent_delivery_history",
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to refresh channel health.",
    );
  }
}
