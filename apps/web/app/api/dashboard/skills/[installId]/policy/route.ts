import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  setWorkspaceSkillUpdatePolicy,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../auth";
import { workspaceSkillApiErrorResponse } from "../../errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ installId: string }> },
) {
  const { installId } = await params;
  const body = (await request.json().catch(() => null)) as {
    representativeSlug?: unknown;
    updatePolicy?: unknown;
  } | null;
  const representativeSlug = typeof body?.representativeSlug === "string"
    ? body.representativeSlug.trim()
    : "";
  const updatePolicy = body?.updatePolicy === "manual"
    || body?.updatePolicy === "review_required"
    || body?.updatePolicy === "patch_auto"
    ? body.updatePolicy
    : null;
  if (!installId.trim() || !representativeSlug || !updatePolicy) {
    return NextResponse.json(
      { error: "installId, representativeSlug, and a valid updatePolicy are required." },
      { status: 400 },
    );
  }
  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const result = await setWorkspaceSkillUpdatePolicy({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
      installId,
      updatePolicy,
      changedBy: session?.ownerId ?? "local-owner",
    });
    return NextResponse.json({ result });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return workspaceSkillApiErrorResponse(
      error,
      "Failed to update the skill update policy.",
    );
  }
}
