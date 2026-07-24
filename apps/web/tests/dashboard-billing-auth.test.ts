import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RepresentativeAccessError extends Error {
    statusCode: 401 | 403 | 404;

    constructor(message: string, statusCode: 401 | 403 | 404) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    RepresentativeAccessError,
    assertOwnerCanAccessRepresentative: vi.fn(),
    assertOwnerCanManageBilling: vi.fn(),
    getOwnerAuthSession: vi.fn(),
    shouldRequireCreatorDashboardAuth: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  RepresentativeAccessError: mocks.RepresentativeAccessError,
  assertOwnerCanAccessRepresentative: mocks.assertOwnerCanAccessRepresentative,
  assertOwnerCanManageBilling: mocks.assertOwnerCanManageBilling,
}));

vi.mock("../app/auth/owner-session", () => ({
  getOwnerAuthSession: mocks.getOwnerAuthSession,
}));

vi.mock("../auth-guard", () => ({
  shouldRequireCreatorDashboardAuth: mocks.shouldRequireCreatorDashboardAuth,
}));

import {
  dashboardAuthErrorResponse,
  requireDashboardBillingAccess,
  requireDashboardRepresentativeBillingAccess,
} from "../app/api/dashboard/auth";

describe("dashboard billing authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldRequireCreatorDashboardAuth.mockReturnValue(false);
    mocks.assertOwnerCanManageBilling.mockResolvedValue(undefined);
    mocks.assertOwnerCanAccessRepresentative.mockResolvedValue({
      id: "rep-1",
      slug: "delegate",
      ownerId: "owner-1",
    });
  });

  it("requires an authenticated owner even when general dashboard auth is optional", async () => {
    mocks.getOwnerAuthSession.mockResolvedValue(null);

    await expect(requireDashboardBillingAccess()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(mocks.assertOwnerCanManageBilling).not.toHaveBeenCalled();
  });

  it("enforces workspace billing permission and returns a normalized owner id", async () => {
    mocks.getOwnerAuthSession.mockResolvedValue({
      actor: "owner",
      ownerId: " owner-1 ",
    });

    await expect(requireDashboardBillingAccess()).resolves.toMatchObject({
      ownerId: "owner-1",
    });
    expect(mocks.assertOwnerCanManageBilling).toHaveBeenCalledWith("owner-1");
  });

  it("checks billing permission before representative ownership", async () => {
    mocks.getOwnerAuthSession.mockResolvedValue({
      actor: "owner",
      ownerId: "owner-1",
    });
    const permissionError = new mocks.RepresentativeAccessError(
      "You do not have permission to manage workspace billing.",
      403,
    );
    mocks.assertOwnerCanManageBilling.mockRejectedValue(permissionError);

    await expect(
      requireDashboardRepresentativeBillingAccess("delegate"),
    ).rejects.toBe(permissionError);
    expect(mocks.assertOwnerCanAccessRepresentative).not.toHaveBeenCalled();
  });

  it("marks authorization errors private and non-cacheable", async () => {
    const response = dashboardAuthErrorResponse(
      new mocks.RepresentativeAccessError("Authentication required.", 401),
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    await expect(response?.json()).resolves.toEqual({
      error: "Authentication required.",
    });
  });
});
