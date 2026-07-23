import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  getRepresentativeMcpBindingsSnapshot,
  upsertRepresentativeMcpBinding,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { mcpBindingApiErrorResponse } from "./errors";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const snapshot = await getRepresentativeMcpBindingsSnapshot(slug);
    if (!snapshot) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Representative not found." }, { status: 404 }),
      );
    }

    return withPrivateNoStore(NextResponse.json(snapshot));
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(
      mcpBindingApiErrorResponse(error, "Failed to load MCP bindings."),
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const bodyValue: unknown = await request.json().catch(() => null);
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      return NextResponse.json({ error: "A valid JSON request body is required." }, { status: 400 });
    }
    const body = bodyValue as Record<string, unknown>;
    const binding = await upsertRepresentativeMcpBinding({
      representativeSlug: slug,
      changedBy: session?.ownerId ?? "local-owner",
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
      maxRetries: 0,
      retryBackoffMs: 1000,
    });

    return NextResponse.json(binding, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return mcpBindingApiErrorResponse(error, "Failed to create MCP binding.");
  }
}
