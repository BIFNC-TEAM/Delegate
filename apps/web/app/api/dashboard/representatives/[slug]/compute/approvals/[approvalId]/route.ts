import { NextResponse } from "next/server";

import { resolveRepresentativeComputeApproval } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../auth";

export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const resolution =
      body.resolution === "approved" || body.resolution === "rejected"
        ? body.resolution
        : "rejected";

    const result = await resolveRepresentativeComputeApproval({
      representativeSlug: slug,
      approvalId,
      resolution,
      ...(typeof body.resolvedBy === "string" && body.resolvedBy.trim()
        ? { resolvedBy: body.resolvedBy.trim() }
        : {}),
    });

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resolve compute approval.",
      },
      { status: 400 },
    );
  }
}
