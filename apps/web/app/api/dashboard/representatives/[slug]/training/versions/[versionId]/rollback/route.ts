import { NextResponse } from "next/server";

import { rollbackCreatorTrainingVersion } from "@delegate/web-data";

type RouteContext = {
  params: Promise<{ slug: string; versionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { slug, versionId } = await context.params;
    const version = await rollbackCreatorTrainingVersion(slug, versionId);

    return NextResponse.json({ version });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to roll back training version." },
      { status: 400 },
    );
  }
}
