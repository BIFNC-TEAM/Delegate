import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RepresentativeSetupConflictError extends Error {
    readonly code = "KNOWLEDGE_PACK_CONFLICT";
    readonly statusCode = 409;

    constructor() {
      super("The representative knowledge draft changed.");
    }
  }

  return {
    RepresentativeSetupConflictError,
    assertOwnerCanManageSkills: vi.fn(),
    requireDashboardRepresentativeAccess: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    updateRepresentativeSetup: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  RepresentativeSetupConflictError: mocks.RepresentativeSetupConflictError,
  assertOwnerCanManageSkills: mocks.assertOwnerCanManageSkills,
  getRepresentativeSetupSnapshot: vi.fn(),
  maybeSyncRepresentativeOpenVikingResources: vi.fn(),
  updateRepresentativeSetup: mocks.updateRepresentativeSetup,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  authorizeDashboardRepresentativeAccess: vi.fn(),
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess: mocks.requireDashboardRepresentativeAccess,
}));

import { PATCH } from "../app/api/dashboard/representatives/[slug]/setup/route";

describe("representative setup optimistic concurrency route", () => {
  it("forwards the client baseline and maps a stale KnowledgePack to 409", async () => {
    mocks.requireDashboardRepresentativeAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
    mocks.updateRepresentativeSetup.mockRejectedValue(
      new mocks.RepresentativeSetupConflictError(),
    );

    const response = await PATCH(
      new Request("http://localhost/api/dashboard/representatives/lin/setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledgePackRevision: 7,
        }),
      }),
      { params: Promise.resolve({ slug: "lin" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The representative knowledge draft changed.",
      code: "KNOWLEDGE_PACK_CONFLICT",
    });
    expect(mocks.updateRepresentativeSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        representativeSlug: "lin",
        input: expect.objectContaining({
          knowledgePackRevision: 7,
        }),
      }),
    );
  });
});
