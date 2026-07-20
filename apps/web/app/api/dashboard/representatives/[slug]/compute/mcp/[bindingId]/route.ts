import { NextResponse } from "next/server";

import { upsertRepresentativeMcpBinding } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; bindingId: string }> },
) {
  const { slug, bindingId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const binding = await upsertRepresentativeMcpBinding({
      representativeSlug: slug,
      bindingId,
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

    return NextResponse.json(binding);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update MCP binding.",
      },
      { status: 400 },
    );
  }
}
