import { NextResponse } from "next/server";

import {
  getRepresentativeOperationsSnapshot,
  publishRepresentativeVersion,
} from "@delegate/web-data";

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
    await requireDashboardRepresentativeAccess(slug);
    const snapshot = await getRepresentativeOperationsSnapshot(slug);
    if (!snapshot) return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load representative versions." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = (await request.json().catch(() => ({}))) as { changeSummary?: string };
    const version = await publishRepresentativeVersion({
      representativeSlug: slug,
      publishedBy: session?.ownerId || "Owner",
      ...(body.changeSummary ? { changeSummary: body.changeSummary } : {}),
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to publish representative version." },
      { status: 500 },
    );
  }
}
