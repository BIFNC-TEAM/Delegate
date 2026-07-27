import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceWalletReconciliationReport: vi.fn(),
  requireDashboardRepresentativeBillingAccess: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  WorkspaceWalletReconciliationInputError:
    class WorkspaceWalletReconciliationInputError extends Error {},
  getWorkspaceWalletReconciliationReport:
    mocks.getWorkspaceWalletReconciliationReport,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

import {
  WorkspaceWalletReconciliationInputError,
} from "@delegate/web-data";

import { GET } from "../app/api/dashboard/wallet/reconciliation/route";

describe("dashboard wallet reconciliation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  it("requires billing access and passes the selected reconciliation scope", async () => {
    mocks.getWorkspaceWalletReconciliationReport.mockResolvedValue({
      status: "warning",
      summary: {
        checks: 8,
        passed: 7,
        warnings: 1,
        errors: 0,
      },
      issues: [
        {
          code: "legacy_ledger_coverage",
          severity: "warning",
          scopeId: "wallet-1",
        },
      ],
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation"
      + "?rep=delegate&representative=support&currency=cny",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "warning",
      summary: {
        warnings: 1,
        errors: 0,
      },
    });
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("delegate");
    expect(mocks.getWorkspaceWalletReconciliationReport).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      representative: "support",
      currency: "cny",
    });
  });

  it("defaults to all representatives and omits an empty currency", async () => {
    mocks.getWorkspaceWalletReconciliationReport.mockResolvedValue({
      status: "healthy",
      summary: {
        checks: 4,
        passed: 4,
        warnings: 0,
        errors: 0,
      },
      issues: [],
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation"
      + "?rep=delegate&representative=%20%20&currency=%20%20",
    ));

    expect(response.status).toBe(200);
    expect(mocks.getWorkspaceWalletReconciliationReport).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      representative: "all",
    });
  });

  it("requires an authenticated owner with billing permission", async () => {
    const unauthorized = Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
    mocks.requireDashboardRepresentativeBillingAccess.mockRejectedValue(
      new Error("auth"),
    );
    mocks.dashboardAuthErrorResponse.mockReturnValue(unauthorized);

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation?rep=delegate",
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getWorkspaceWalletReconciliationReport).not.toHaveBeenCalled();
  });

  it("keeps validation and not-found responses private", async () => {
    const missingRep = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation",
    ));
    expect(missingRep.status).toBe(400);
    expect(missingRep.headers.get("cache-control")).toBe("private, no-store");

    mocks.getWorkspaceWalletReconciliationReport.mockResolvedValue(null);
    const missingWorkspace = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation?rep=delegate",
    ));
    expect(missingWorkspace.status).toBe(404);
    expect(missingWorkspace.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns reconciliation input errors without exposing them as server errors", async () => {
    mocks.getWorkspaceWalletReconciliationReport.mockRejectedValue(
      new WorkspaceWalletReconciliationInputError("Invalid wallet currency."),
    );

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation"
      + "?rep=delegate&currency=bitcoin",
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Invalid wallet currency.",
    });
  });

  it("redacts unexpected database errors", async () => {
    mocks.getWorkspaceWalletReconciliationReport.mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet/reconciliation?rep=delegate",
    ));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Failed to load wallet reconciliation report.");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
  });
});
