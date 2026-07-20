import { NextResponse } from "next/server";

import { getPublicRepresentativeRuntime, getRepresentativeDeliverableDownload } from "@delegate/web-data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; deliverableId: string }> },
) {
  const { slug, deliverableId } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    }
    const deliverable = await getRepresentativeDeliverableDownload(slug, deliverableId, {
      publicOnly: true,
    });
    if (!deliverable) {
      return NextResponse.json({ error: "Deliverable not found." }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(deliverable.buffer), {
      status: 200,
      headers: {
        "Content-Type": deliverable.mimeType,
        "Content-Disposition": `attachment; filename="${deliverable.fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to download deliverable.",
      },
      { status: 500 },
    );
  }
}
