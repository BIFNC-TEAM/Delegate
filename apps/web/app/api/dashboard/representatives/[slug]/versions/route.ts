import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
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
    const session = await requireDashboardRepresentativeAccess(slug);
    const snapshot = await getRepresentativeOperationsSnapshot({
      representativeSlug: slug,
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
    });
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
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = (await request.json().catch(() => ({}))) as {
      changeSummary?: unknown;
    };
    if (
      body.changeSummary !== undefined
      && body.changeSummary !== null
      && typeof body.changeSummary !== "string"
    ) {
      return NextResponse.json(
        { error: "Change summary must be a string." },
        { status: 400 },
      );
    }
    const changeSummary =
      typeof body.changeSummary === "string" ? body.changeSummary.trim() : "";
    if (changeSummary.length > 1000) {
      return NextResponse.json(
        { error: "Change summary is too long." },
        { status: 400 },
      );
    }
    const version = await publishRepresentativeVersion({
      representativeSlug: slug,
      publishedBy: session?.ownerId || "Owner",
      ...(changeSummary ? { changeSummary } : {}),
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
