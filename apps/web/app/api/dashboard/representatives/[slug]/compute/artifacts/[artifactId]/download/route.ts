import { NextResponse } from "next/server";

import { getRepresentativeComputeArtifactDownload } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../../auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; artifactId: string }> },
) {
  const { slug, artifactId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  try {
    const artifact = await getRepresentativeComputeArtifactDownload(slug, artifactId, {
      recordDownload: !inline,
    });
    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(artifact.buffer), {
      status: 200,
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.fileName}"`,
      },
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to download artifact.",
      },
      { status: 500 },
    );
  }
}
