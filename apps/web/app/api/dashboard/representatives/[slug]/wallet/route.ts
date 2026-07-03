import { NextResponse } from "next/server";

import { getAgentWalletDashboardSnapshot } from "@delegate/web-data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const snapshot = await getAgentWalletDashboardSnapshot(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load agent wallet dashboard.",
      },
      { status: 500 },
    );
  }
}
