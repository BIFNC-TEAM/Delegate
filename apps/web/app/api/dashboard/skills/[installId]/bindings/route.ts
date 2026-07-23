import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  setWorkspaceSkillRepresentativeBinding,
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
    enabled?: unknown;
  } | null;
  const representativeSlug = typeof body?.representativeSlug === "string"
    ? body.representativeSlug.trim()
    : "";
  if (!installId.trim() || !representativeSlug || typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { error: "installId, representativeSlug, and enabled are required." },
      { status: 400 },
    );
  }

  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const binding = await setWorkspaceSkillRepresentativeBinding({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      installId,
      representativeSlug,
      enabled: body.enabled,
      changedBy: session?.ownerId ?? "local-owner",
    });
    return NextResponse.json({ binding });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return workspaceSkillApiErrorResponse(
      error,
      "Failed to update skill binding.",
    );
  }
}
