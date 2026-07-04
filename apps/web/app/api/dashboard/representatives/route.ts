import { NextResponse } from "next/server";

import {
  createRepresentative,
  listRepresentativeDirectoryItems,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
} from "../auth";

export async function GET() {
  try {
    const session = await requireDashboardApiOwnerSession();
    const representatives = await listRepresentativeDirectoryItems(session?.ownerId);
    return NextResponse.json({ representatives });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load representatives.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const body = (await request.json()) as Record<string, unknown>;
    const created = await createRepresentative(
      {
        ownerName: String(body.ownerName ?? ""),
        representativeName: String(body.representativeName ?? ""),
        slug:
          typeof body.slug === "string" && body.slug.trim().length > 0
            ? body.slug
            : undefined,
        tagline:
          typeof body.tagline === "string" && body.tagline.trim().length > 0
            ? body.tagline
            : undefined,
      },
      session?.ownerId ? { ownerId: session.ownerId } : {},
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create representative.",
      },
      { status: 400 },
    );
  }
}
