import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  recordWorkspaceCapabilityOperationFailure,
  reviewWorkspaceSkillRelease,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";
import { workspaceSkillApiErrorResponse } from "../../../errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ installId: string; releaseId: string }> },
) {
  const { installId, releaseId } = await params;
  const body = (await request.json().catch(() => null)) as {
    representativeSlug?: unknown;
    action?: unknown;
    reviewNote?: unknown;
  } | null;
  const representativeSlug = typeof body?.representativeSlug === "string" ? body.representativeSlug.trim() : "";
  const action = body?.action === "adopt" || body?.action === "reject" || body?.action === "rollback"
    ? body.action
    : null;
  const reviewNote = typeof body?.reviewNote === "string" ? body.reviewNote.trim() : "";
  if (!installId.trim() || !releaseId.trim() || !representativeSlug || !action) {
    return NextResponse.json({ error: "installId, releaseId, representativeSlug, and a valid action are required." }, { status: 400 });
  }
  if (reviewNote.length > 1000) {
    return NextResponse.json({ error: "Review note is too long." }, { status: 400 });
  }

  let metricOwnerId: string | null = null;
  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    metricOwnerId = session?.ownerId ?? null;
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const result = await reviewWorkspaceSkillRelease({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
      installId,
      releaseId,
      action,
      reviewedBy: session?.ownerId ?? "local-owner",
      ...(reviewNote ? { reviewNote } : {}),
    });
    return NextResponse.json({ result });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    recordWorkspaceCapabilityOperationFailure({
      ownerId: metricOwnerId,
      representativeSlug,
      operation: "skill_release_review",
      error,
    });
    return workspaceSkillApiErrorResponse(
      error,
      "Failed to review skill release.",
    );
  }
}
