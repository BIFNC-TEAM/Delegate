import { NextResponse } from "next/server";

import {
  getRepresentativeComputeArtifactDetail,
  updateRepresentativeComputeArtifact,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; artifactId: string }> },
) {
  const { slug, artifactId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const detail = await getRepresentativeComputeArtifactDetail(slug, artifactId);
    if (!detail) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load artifact detail.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; artifactId: string }> },
) {
  const { slug, artifactId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const result = await updateRepresentativeComputeArtifact(slug, artifactId, body);
    if (!result) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update artifact.",
      },
      { status: 500 },
    );
  }
}
