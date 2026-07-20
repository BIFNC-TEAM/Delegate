import { NextResponse } from "next/server";

import { listConversationInboxSnapshot } from "@delegate/web-data";

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
    const snapshot = await listConversationInboxSnapshot(slug, session?.ownerId || "local-owner");
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }
    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load conversations." },
      { status: 500 },
    );
  }
}
