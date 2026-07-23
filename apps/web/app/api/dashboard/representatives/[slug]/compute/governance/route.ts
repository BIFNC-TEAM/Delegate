import { NextResponse } from "next/server";

import { organizationGovernanceOverlaysSchema } from "@delegate/compute-protocol";
import {
  assertOwnerCanManageSkills,
  updateRepresentativeOrganizationGovernance,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = organizationGovernanceOverlaysSchema.parse(await request.json());
    const governance = await updateRepresentativeOrganizationGovernance({
      representativeSlug: slug,
      governance: body,
    });

    return NextResponse.json({ governance });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update representative governance.",
      },
      { status: 400 },
    );
  }
}
