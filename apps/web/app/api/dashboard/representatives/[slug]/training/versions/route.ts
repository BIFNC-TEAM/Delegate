import { NextResponse } from "next/server";

import { listCreatorTrainingVersions } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const url = new URL(request.url);
    const limitValue = Number(url.searchParams.get("limit") ?? 20);
    const versions = await listCreatorTrainingVersions(slug, {
      limit: Number.isFinite(limitValue) ? limitValue : 20,
    });

    return NextResponse.json({ versions });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load creator training versions.",
      },
      { status: 400 },
    );
  }
}
