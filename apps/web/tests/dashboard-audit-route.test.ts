import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceAuditExport: vi.fn(),
  getWorkspaceAuditSnapshot: vi.fn(),
  requireDashboardApiOwnerSession: vi.fn(),
  requireDashboardRepresentativeAccess: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  WorkspaceAuditInputError: class WorkspaceAuditInputError extends Error {},
  getWorkspaceAuditExport: mocks.getWorkspaceAuditExport,
  getWorkspaceAuditSnapshot: mocks.getWorkspaceAuditSnapshot,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: () => null,
  requireDashboardApiOwnerSession: mocks.requireDashboardApiOwnerSession,
  requireDashboardRepresentativeAccess: mocks.requireDashboardRepresentativeAccess,
}));

import { GET } from "../app/api/dashboard/audit/route";

describe("dashboard workspace audit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardApiOwnerSession.mockResolvedValue({ ownerId: "owner-1" });
    mocks.requireDashboardRepresentativeAccess.mockResolvedValue({ ownerId: "owner-1" });
  });

  it("passes owner scope, filters, and keyset pagination to the data layer", async () => {
    mocks.getWorkspaceAuditSnapshot.mockResolvedValue({
      workspace: { ownerId: "owner-1", representativeCount: 1 },
      metrics: { total: 0, last24Hours: 0, decisions: 0, anomalies: 0 },
      categories: [],
      page: { filteredTotal: 0, limit: 25, hasMore: false, nextCursor: null },
      events: [],
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/audit?rep=delegate&category=skills&query=install&limit=25&cursor=opaque",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardApiOwnerSession).toHaveBeenCalledOnce();
    expect(mocks.requireDashboardRepresentativeAccess).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceAuditSnapshot).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      category: "skills",
      query: "install",
      limit: 25,
      cursor: "opaque",
    });
  });

  it("loads owner-only settings audit events without requiring a representative", async () => {
    mocks.getWorkspaceAuditSnapshot.mockResolvedValue({
      workspace: { ownerId: "owner-1", representativeCount: 0 },
      metrics: { total: 1, last24Hours: 1, decisions: 0, anomalies: 0 },
      categories: [{ id: "settings", count: 1 }],
      page: { filteredTotal: 1, limit: 50, hasMore: false, nextCursor: null },
      events: [],
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/audit?category=settings",
    ));

    expect(response.status).toBe(200);
    expect(mocks.requireDashboardRepresentativeAccess).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceAuditSnapshot).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "",
      category: "settings",
    });
  });

  it("streams every filtered event through the allowlisted CSV serializer", async () => {
    async function* events() {
      yield {
        id: "event-1",
        type: "approval_resolved",
        category: "approvals",
        representativeSlug: "delegate",
        representativeName: "Delegate",
        actor: "=1+1",
        summary: "approval resolved",
        resource: { kind: "approval", id: "approval-1" },
        traceId: null,
        anomaly: false,
        metadata: { decision: "APPROVE" },
        createdAt: "2026-07-23T16:00:00.000Z",
      };
      yield {
        id: "event-2",
        type: "workflow_failed",
        category: "workflow",
        representativeSlug: "delegate",
        representativeName: "Delegate",
        actor: null,
        summary: "workflow failed",
        resource: null,
        traceId: "trace-2",
        anomaly: true,
        metadata: { status: "FAILED" },
        createdAt: "2026-07-23T15:00:00.000Z",
      };
    }
    mocks.getWorkspaceAuditExport.mockResolvedValue({
      filteredTotal: 2,
      events: events(),
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/audit?rep=delegate&category=all&query=work&format=csv",
    ));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-workspace-audit-result-count")).toBe("2");
    expect(body).toContain("event_type");
    expect(body).toContain("\"'=1+1\"");
    expect(body).toContain("approval_resolved");
    expect(body).toContain("workflow_failed");
    expect(body).not.toContain("event-1");
    expect(mocks.getWorkspaceAuditExport).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      category: "all",
      query: "work",
    });
  });

  it("does not expose unexpected server exception messages", async () => {
    mocks.getWorkspaceAuditSnapshot.mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const response = await GET(new Request(
      "http://localhost/api/dashboard/audit?rep=delegate&category=all",
    ));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("Failed to load workspace audit events.");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
  });
});
