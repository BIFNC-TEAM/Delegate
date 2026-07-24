import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceWalletSnapshot: vi.fn(),
  requireDashboardRepresentativeBillingAccess: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  WorkspaceWalletInputError: class WorkspaceWalletInputError extends Error {},
  getWorkspaceWalletSnapshot: mocks.getWorkspaceWalletSnapshot,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

import { GET } from "../app/api/dashboard/wallet/route";

describe("dashboard workspace wallet route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires billing access and passes workspace filters to the read model", async () => {
    mocks.getWorkspaceWalletSnapshot.mockResolvedValue({
      workspace: {
        ownerId: "owner-1",
        representativeCount: 2,
        asOf: "2026-07-23T16:00:00.000Z",
      },
      representatives: [],
      currencies: ["CNY", "USD"],
      filters: {
        view: "transactions",
        representative: "support",
        currency: "CNY",
        eventType: "refund",
        query: "order",
        from: "2026-07-01",
        to: "2026-07-23",
      },
      metrics: {
        grossSalesCents: 0,
        releasedCreatorIncomeCents: 0,
        pendingEarningsCents: 0,
        withdrawableCents: 0,
        payoutInProgressCents: 0,
      },
      primaryAction: { kind: "none", reason: null },
      eventTypes: [],
      page: {
        filteredTotal: 0,
        limit: 25,
        hasMore: false,
        nextCursor: null,
      },
      events: [],
      settlements: [],
      ledgerEntries: [],
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet"
      + "?rep=delegate&view=transactions&representative=support"
      + "&currency=cny&eventType=refund&query=order"
      + "&from=2026-07-01&to=2026-07-23"
      + "&asOf=2026-07-23T16%3A00%3A00.000Z"
      + "&cursor=opaque&limit=25",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      capabilities: {
        mockWithdrawalOperations: true,
      },
    });
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("delegate");
    expect(mocks.getWorkspaceWalletSnapshot).toHaveBeenCalledWith({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      view: "transactions",
      representative: "support",
      currency: "cny",
      eventType: "refund",
      query: "order",
      from: "2026-07-01",
      to: "2026-07-23",
      asOf: "2026-07-23T16:00:00.000Z",
      cursor: "opaque",
      limit: 25,
    });
  });

  it("never advertises local mock withdrawal operations in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.getWorkspaceWalletSnapshot.mockResolvedValue({
      workspace: {
        ownerId: "owner-1",
        representativeCount: 1,
        asOf: "2026-07-23T16:00:00.000Z",
      },
    });

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet?rep=delegate",
    ));

    await expect(response.json()).resolves.toMatchObject({
      capabilities: {
        mockWithdrawalOperations: false,
      },
    });
  });

  it("requires an authenticated owner with billing permission even in development", async () => {
    const unauthorized = Response.json(
      { error: "Authentication required." },
      {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
    mocks.requireDashboardRepresentativeBillingAccess.mockRejectedValue(
      new Error("auth"),
    );
    mocks.dashboardAuthErrorResponse.mockReturnValue(unauthorized);

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet?rep=delegate",
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getWorkspaceWalletSnapshot).not.toHaveBeenCalled();
  });

  it("keeps validation and not-found responses private", async () => {
    const missingRep = await GET(new Request(
      "http://localhost/api/dashboard/wallet",
    ));
    expect(missingRep.status).toBe(400);
    expect(missingRep.headers.get("cache-control")).toBe("private, no-store");

    mocks.getWorkspaceWalletSnapshot.mockResolvedValue(null);
    const missingWorkspace = await GET(new Request(
      "http://localhost/api/dashboard/wallet?rep=delegate",
    ));
    expect(missingWorkspace.status).toBe(404);
    expect(missingWorkspace.headers.get("cache-control")).toBe("private, no-store");
  });

  it("redacts unexpected database errors", async () => {
    mocks.getWorkspaceWalletSnapshot.mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const response = await GET(new Request(
      "http://localhost/api/dashboard/wallet?rep=delegate",
    ));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Failed to load workspace wallet and billing.");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
  });
});
