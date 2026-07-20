import { NextResponse } from "next/server";

import { activateRepresentativeVersion } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../auth";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; versionId: string }> },
) {
  const { slug, versionId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const version = await activateRepresentativeVersion({
      representativeSlug: slug,
      versionId,
      activatedBy: session?.ownerId || "Owner",
    });
    return NextResponse.json({ version });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to activate representative version." },
      { status: 500 },
    );
  }
}
