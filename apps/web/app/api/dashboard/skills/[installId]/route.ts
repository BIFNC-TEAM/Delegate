import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  setWorkspaceSkillArchived,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../auth";
import { workspaceSkillApiErrorResponse } from "../errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ installId: string }> },
) {
  const { installId } = await params;
  const body = (await request.json().catch(() => null)) as {
    representativeSlug?: unknown;
    archived?: unknown;
  } | null;
  const representativeSlug = typeof body?.representativeSlug === "string" ? body.representativeSlug.trim() : "";
  if (!installId.trim() || !representativeSlug || typeof body?.archived !== "boolean") {
    return NextResponse.json({ error: "installId, representativeSlug, and archived are required." }, { status: 400 });
  }

  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const result = await setWorkspaceSkillArchived({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
      installId,
      archived: body.archived,
      changedBy: session?.ownerId ?? "local-owner",
    });
    return NextResponse.json({ result });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return workspaceSkillApiErrorResponse(
      error,
      "Failed to update workspace skill.",
    );
  }
}
