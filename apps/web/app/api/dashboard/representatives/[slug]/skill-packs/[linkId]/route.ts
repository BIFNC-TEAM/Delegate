import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  setRepresentativeSkillPackEnabled,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; linkId: string }> },
) {
  const { slug, linkId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
    }

    const skillPack = await setRepresentativeSkillPackEnabled({
      representativeSlug: slug,
      linkId,
      enabled: body.enabled,
    });

    return NextResponse.json({ skillPack });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update representative skill pack.",
      },
      { status: 500 },
    );
  }
}
