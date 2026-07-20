import { NextResponse } from "next/server";

import {
  getRepresentativeOpenVikingSnapshot,
  updateRepresentativeOpenVikingConfig,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const snapshot = await getRepresentativeOpenVikingSnapshot(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load OpenViking representative settings.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const snapshot = await updateRepresentativeOpenVikingConfig({
      representativeSlug: slug,
      input: {
        enabled: Boolean(body.enabled),
        agentIdOverride:
          typeof body.agentIdOverride === "string" && body.agentIdOverride.trim()
            ? body.agentIdOverride
            : undefined,
        autoRecall: Boolean(body.autoRecall),
        autoCapture: Boolean(body.autoCapture),
        captureMode: body.captureMode === "keyword" ? "keyword" : "semantic",
        recallLimit: Number(body.recallLimit ?? 0),
        recallScoreThreshold: Number(body.recallScoreThreshold ?? 0),
        targetUri:
          typeof body.targetUri === "string" && body.targetUri.trim()
            ? body.targetUri
            : undefined,
      },
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update OpenViking representative settings.",
      },
      { status: 400 },
    );
  }
}
