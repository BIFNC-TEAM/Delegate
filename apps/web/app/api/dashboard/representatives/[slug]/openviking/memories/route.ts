import { NextResponse } from "next/server";

import { getRepresentativeOpenVikingMemoryPreview } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { toDashboardGovernedMemoryDto } from "../safe-dto";

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
    const memories = await getRepresentativeOpenVikingMemoryPreview(slug);
    return withPrivateNoStore(
      NextResponse.json({
        memories: memories.map(toDashboardGovernedMemoryDto),
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
          error: "Failed to load governed memory records.",
        },
        { status: 500 },
      ),
    );
  }
}
