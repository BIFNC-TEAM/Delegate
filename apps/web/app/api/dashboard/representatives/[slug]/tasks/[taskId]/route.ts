import { NextResponse } from "next/server";

import {
  applyRepresentativeDelegationTaskAction,
  ComputeBrokerError,
  DelegationTaskActionError,
  getRepresentativeDelegationTaskDetail,
  resolveRepresentativeComputeApproval,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; taskId: string }> },
) {
  const { slug, taskId } = await params;
  try {
    await requireDashboardRepresentativeAccess(slug);
    const detail = await getRepresentativeDelegationTaskDetail(slug, taskId);
    if (!detail) return NextResponse.json({ error: "Delegation task not found." }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load delegation task." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; taskId: string }> },
) {
  const { slug, taskId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = (await request.json()) as { action?: "cancel" | "retry" | "continue" };
    if (!body.action || !["cancel", "retry", "continue"].includes(body.action)) {
      return NextResponse.json({ error: "Invalid delegation task action." }, { status: 400 });
    }
    const actorId = session?.ownerId || "local-owner";
    const current = await getRepresentativeDelegationTaskDetail(slug, taskId);
    if (!current) return NextResponse.json({ error: "Delegation task not found." }, { status: 404 });

    if (body.action === "cancel" && current.pendingApprovalId) {
      await resolveRepresentativeComputeApproval({
        representativeSlug: slug,
        approvalId: current.pendingApprovalId,
        resolution: "rejected",
        resolvedBy: actorId,
        decisionNote: "Owner canceled the delegated task.",
      });
      const detail = await getRepresentativeDelegationTaskDetail(slug, taskId);
      return NextResponse.json(detail);
    }

    const detail = await applyRepresentativeDelegationTaskAction({
      representativeSlug: slug,
      taskId,
      action: body.action,
      actorId,
    });
    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof DelegationTaskActionError || error instanceof ComputeBrokerError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update delegation task." },
      { status: 500 },
    );
  }
}
