import { NextResponse } from "next/server";

import {
  assertOwnerCanApproveCompute,
  ComputeBrokerError,
  resolveRepresentativeComputeApproval,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../auth";

export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanApproveCompute(session.ownerId);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.resolution !== "approved" && body.resolution !== "rejected") {
      return NextResponse.json({ error: "Invalid approval resolution." }, { status: 400 });
    }
    const resolution = body.resolution;
    const decisionNote = typeof body.decisionNote === "string" ? body.decisionNote.trim() : "";
    if (decisionNote.length > 1000) {
      return NextResponse.json({ error: "Decision note is too long." }, { status: 400 });
    }

    const result = await resolveRepresentativeComputeApproval({
      representativeSlug: slug,
      approvalId,
      resolution,
      resolvedBy: session?.ownerId ?? "local-owner",
      ...(decisionNote ? { decisionNote } : {}),
    });

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    if (error instanceof ComputeBrokerError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
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
