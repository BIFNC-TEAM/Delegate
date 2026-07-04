import { NextResponse } from "next/server";

import { listCreatorTrainingVersions } from "@delegate/web-data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const url = new URL(request.url);
    const limitValue = Number(url.searchParams.get("limit") ?? 20);
    const versions = await listCreatorTrainingVersions(slug, {
      limit: Number.isFinite(limitValue) ? limitValue : 20,
    });

    return NextResponse.json({ versions });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load creator training versions.",
      },
      { status: 400 },
    );
  }
}
