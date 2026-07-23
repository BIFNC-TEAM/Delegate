import { NextResponse } from "next/server";

import { getWorkspaceCapabilityHealthSnapshot } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const snapshot = await getWorkspaceCapabilityHealthSnapshot({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: slug,
    });
    if (!snapshot) {
      return NextResponse.json(
        { error: "Workspace not found." },
        { status: 404 },
      );
    }
    const response = NextResponse.json(snapshot);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: "Failed to load capability health." },
      { status: 500 },
    );
  }
}
