import { NextResponse } from "next/server";

import {
  getRepresentativeComputeSnapshot,
  upsertRepresentativeMcpBinding,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

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
    const snapshot = await getRepresentativeComputeSnapshot(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json({
      representative: {
        slug: snapshot.representative.slug,
        displayName: snapshot.representative.displayName,
      },
      bindings: snapshot.representative.mcpBindings,
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load MCP bindings.",
      },
      { status: 500 },
    );
  }
}

export async function POST(
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
    const binding = await upsertRepresentativeMcpBinding({
      representativeSlug: slug,
      representativeSkillPackLinkId:
        typeof body.representativeSkillPackLinkId === "string"
          ? body.representativeSkillPackLinkId
          : undefined,
      slug: String(body.slug ?? ""),
      displayName: String(body.displayName ?? ""),
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : undefined,
      serverUrl: String(body.serverUrl ?? ""),
      transportKind: body.transportKind === "sse" ? "sse" : "streamable_http",
      allowedToolNames: Array.isArray(body.allowedToolNames)
        ? body.allowedToolNames.filter((value): value is string => typeof value === "string")
        : [],
      defaultToolName:
        typeof body.defaultToolName === "string" && body.defaultToolName.trim()
          ? body.defaultToolName.trim()
          : undefined,
      enabled: body.enabled !== false,
      approvalRequired: body.approvalRequired !== false,
      estimatedCostCentsPerCall:
        typeof body.estimatedCostCentsPerCall === "number" &&
        Number.isFinite(body.estimatedCostCentsPerCall)
          ? Math.max(0, Math.trunc(body.estimatedCostCentsPerCall))
          : 0,
      maxRetries:
        typeof body.maxRetries === "number" && Number.isFinite(body.maxRetries)
          ? Math.max(0, Math.min(5, Math.trunc(body.maxRetries)))
          : 2,
      retryBackoffMs:
        typeof body.retryBackoffMs === "number" && Number.isFinite(body.retryBackoffMs)
          ? Math.max(100, Math.min(30000, Math.trunc(body.retryBackoffMs)))
          : 1000,
    });

    return NextResponse.json(binding, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create MCP binding.",
      },
      { status: 400 },
    );
  }
}
