import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PublicAudienceHandoffControlError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode = 409,
    ) {
      super(message);
    }
  }
  return {
    PublicAudienceHandoffControlError,
    controlPublicAudienceHandoff: vi.fn(),
    cookies: vi.fn(),
    getPublicRepresentativeRuntime: vi.fn(),
    publicAudiencePrincipalErrorStatus: vi.fn(),
    resolvePublicAudienceRequestPrincipal: vi.fn(),
    revalidate: vi.fn(),
    setPublicAudienceSessionCookie: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@delegate/web-data", () => ({
  controlPublicAudienceHandoff: mocks.controlPublicAudienceHandoff,
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  PublicAudienceHandoffControlError:
    mocks.PublicAudienceHandoffControlError,
}));
vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie:
    mocks.setPublicAudienceSessionCookie,
}));

import { PATCH } from "../app/reps/[slug]/handoff/route";

describe("public audience handoff control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({ get: vi.fn() });
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        audienceIdentityId: "audience-identity-1",
        audienceId: "audience-session-1",
      },
      sessionState: {
        audienceId: "audience-session-1",
        sessionToken: "session-token",
        expiresAt: "2026-08-18T00:00:00.000Z",
      },
      revalidate: mocks.revalidate,
    });
    mocks.revalidate.mockResolvedValue(undefined);
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
  });

  it.each(["cancel_request", "end_human_service"] as const)(
    "scopes %s to the server-resolved public audience",
    async (action) => {
      mocks.controlPublicAudienceHandoff.mockResolvedValue({
        action,
        changed: true,
        conversationState: "active",
      });
      const request = new Request(
        "http://localhost/reps/representative/handoff",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );

      const response = await PATCH(request, {
        params: Promise.resolve({ slug: "representative" }),
      });

      expect(response.status).toBe(200);
      expect(mocks.revalidate).toHaveBeenCalledOnce();
      expect(mocks.controlPublicAudienceHandoff).toHaveBeenCalledWith({
        representativeSlug: "representative",
        audienceIdentityId: "audience-identity-1",
        audienceId: "audience-session-1",
        action,
      });
      expect(mocks.setPublicAudienceSessionCookie).toHaveBeenCalledOnce();
    },
  );

  it("returns a stable conflict when the wrong lifecycle action is requested", async () => {
    mocks.controlPublicAudienceHandoff.mockRejectedValue(
      new mocks.PublicAudienceHandoffControlError(
        "human_service_active",
        "Human service is already active; end the human service instead.",
      ),
    );
    const response = await PATCH(
      new Request("http://localhost/reps/representative/handoff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_request" }),
      }),
      { params: Promise.resolve({ slug: "representative" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Human service is already active; end the human service instead.",
      code: "human_service_active",
    });
  });

  it("rejects unsupported actions before changing conversation state", async () => {
    const response = await PATCH(
      new Request("http://localhost/reps/representative/handoff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_everything" }),
      }),
      { params: Promise.resolve({ slug: "representative" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.controlPublicAudienceHandoff).not.toHaveBeenCalled();
  });
});
