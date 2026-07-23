import { NextResponse } from "next/server";

import {
  assertOwnerCanResolveApproval,
  resolveRepresentativeComputeApproval,
  resolveWorkspaceSkillApproval,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../auth";
import { computeApprovalApiErrorResponse } from "../errors";

export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) {
      await assertOwnerCanResolveApproval({
        ownerId: session.ownerId,
        representativeSlug: slug,
        approvalId,
      });
    }
    const bodyValue: unknown = await request.json().catch(() => null);
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      return NextResponse.json({ error: "A valid JSON request body is required." }, { status: 400 });
    }
    const body = bodyValue as Record<string, unknown>;
    if (body.resolution !== "approved" && body.resolution !== "rejected") {
      return NextResponse.json({ error: "Invalid approval resolution." }, { status: 400 });
    }
    const resolution = body.resolution;
    const decisionNote = typeof body.decisionNote === "string" ? body.decisionNote.trim() : "";
    if (decisionNote.length > 1000) {
      return NextResponse.json({ error: "Decision note is too long." }, { status: 400 });
    }

    const skillDecision = await resolveWorkspaceSkillApproval({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: slug,
      approvalId,
      resolution,
      resolvedBy: session?.ownerId ?? "local-owner",
      ...(decisionNote ? { decisionNote } : {}),
    });
    if (skillDecision.handled) return NextResponse.json(skillDecision.result);

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

    return computeApprovalApiErrorResponse(error);
  }
}
