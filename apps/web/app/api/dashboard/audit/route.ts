import { NextResponse } from "next/server";

import {
  getWorkspaceAuditExport,
  getWorkspaceAuditSnapshot,
  WorkspaceAuditInputError,
  type WorkspaceAuditCategory,
} from "@delegate/web-data";

import {
  createWorkspaceAuditCsvStream,
} from "../../../dashboard/dashboard-audit-csv";
import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
  requireDashboardRepresentativeAccess,
} from "../auth";

const categories = new Set<WorkspaceAuditCategory>([
  "skills", "publishing", "approvals", "wallet", "tools", "workflow", "conversation", "settings", "security", "other",
]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const representativeSlug = url.searchParams.get("rep")?.trim() ?? "";
  const rawCategory = url.searchParams.get("category")?.trim() ?? "all";
  const category = rawCategory === "all" || categories.has(rawCategory as WorkspaceAuditCategory)
    ? rawCategory as WorkspaceAuditCategory | "all"
    : null;
  const query = url.searchParams.get("query")?.trim() ?? "";
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const rawLimit = url.searchParams.get("limit")?.trim();
  const limit = rawLimit ? Number(rawLimit) : undefined;
  const format = url.searchParams.get("format")?.trim() || "json";
  if (
    !category
    || (format !== "json" && format !== "csv")
    || (rawLimit && !Number.isFinite(limit))
  ) {
    return NextResponse.json({ error: "A valid category is required." }, { status: 400 });
  }
  try {
    const ownerSession = await requireDashboardApiOwnerSession();
    const session = ownerSession?.ownerId
      ? ownerSession
      : representativeSlug
        ? await requireDashboardRepresentativeAccess(representativeSlug)
        : ownerSession;
    if (!session?.ownerId && !representativeSlug) {
      return NextResponse.json(
        { error: "Authentication or rep is required." },
        {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    if (format === "csv") {
      const auditExport = await getWorkspaceAuditExport({
        ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
        activeRepresentativeSlug: representativeSlug,
        category,
        ...(query ? { query } : {}),
      });
      if (!auditExport) {
        return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
      }
      const stream = createWorkspaceAuditCsvStream(
        auditExport.events,
        request.signal,
      );
      const safeSlug = (representativeSlug || "workspace")
        .replace(/[^a-z0-9._-]+/gi, "-")
        .slice(0, 80) || "workspace";
      return new Response(stream, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="delegate-workspace-audit-${safeSlug}.csv"`,
          "Content-Type": "text/csv; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Workspace-Audit-Result-Count": String(auditExport.filteredTotal),
        },
      });
    }
    const snapshot = await getWorkspaceAuditSnapshot({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
      category,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!snapshot) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof WorkspaceAuditInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: format === "csv"
        ? "Failed to export workspace audit events."
        : "Failed to load workspace audit events." },
      { status: 500 },
    );
  }
}
