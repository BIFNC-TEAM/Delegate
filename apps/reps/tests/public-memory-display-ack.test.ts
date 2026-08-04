import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PublicMemoryDisplayError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  class MemoryUseExecutionError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  }
  return {
    acknowledgePublicMemoryDisplay: vi.fn(),
    cookies: vi.fn(),
    getPublicRepresentativeRuntime: vi.fn(),
    publicAudiencePrincipalErrorStatus: vi.fn(),
    resolvePublicAudienceRequestPrincipal: vi.fn(),
    setPublicAudienceSessionCookie: vi.fn(),
    PublicMemoryDisplayError,
    MemoryUseExecutionError,
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

vi.mock("@delegate/web-data", () => ({
  acknowledgePublicMemoryDisplay: mocks.acknowledgePublicMemoryDisplay,
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  PublicMemoryDisplayError: mocks.PublicMemoryDisplayError,
  MemoryUseExecutionError: mocks.MemoryUseExecutionError,
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie: mocks.setPublicAudienceSessionCookie,
}));

import { POST as acknowledgeDisplay } from "../app/reps/[slug]/chat/runs/[runId]/display-ack/route";

describe("public memory display acknowledgement route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({ get: vi.fn() });
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "representative_1" },
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "anonymous",
        audienceId: "audience_1",
        audienceIdentityId: "audience_identity_1",
      },
      sessionState: {
        audienceId: "audience_1",
        sessionToken: "session-token-long-enough-for-test",
        expiresAt: "2026-08-10T00:00:00.000Z",
      },
    });
    mocks.acknowledgePublicMemoryDisplay.mockResolvedValue({
      acknowledged: true,
      displayedCount: 2,
    });
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
  });

  it("binds the acknowledgement to the server-authoritative audience and run", async () => {
    const request = displayRequest();
    const response = await acknowledgeDisplay(request, {
      params: Promise.resolve({ slug: "delegate", runId: "generation_run_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      acknowledged: true,
      displayedCount: 2,
    });
    expect(mocks.acknowledgePublicMemoryDisplay).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      generationRunId: "generation_run_1",
      outputMessageId: "output_message_1",
      audienceIdentityId: "audience_identity_1",
      audienceId: "audience_1",
    });
    expect(mocks.setPublicAudienceSessionCookie).toHaveBeenCalledWith(
      response,
      request,
      "delegate",
      expect.objectContaining({ audienceId: "audience_1" }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed when the active principal is invalid", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("authenticated_principal_invalid"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await acknowledgeDisplay(displayRequest(), {
      params: Promise.resolve({ slug: "delegate", runId: "generation_run_1" }),
    });

    expect(response.status).toBe(401);
    expect(mocks.acknowledgePublicMemoryDisplay).not.toHaveBeenCalled();
  });

  it("does not reveal a run owned by a different public audience", async () => {
    mocks.acknowledgePublicMemoryDisplay.mockRejectedValue(
      new mocks.PublicMemoryDisplayError(
        "public_memory_display_not_found",
        "not owned",
        404,
      ),
    );

    const response = await acknowledgeDisplay(displayRequest(), {
      params: Promise.resolve({ slug: "delegate", runId: "generation_run_other" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Generation output not found.",
      code: "public_memory_display_not_found",
    });
    expect(mocks.setPublicAudienceSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects a missing output message before resolving the audience", async () => {
    const response = await acknowledgeDisplay(
      new Request("http://localhost/reps/delegate/chat/runs/run-1/display-ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ slug: "delegate", runId: "run-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.resolvePublicAudienceRequestPrincipal).not.toHaveBeenCalled();
    expect(mocks.acknowledgePublicMemoryDisplay).not.toHaveBeenCalled();
  });
});

function displayRequest() {
  return new Request(
    "http://localhost/reps/delegate/chat/runs/generation_run_1/display-ack",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outputMessageId: "output_message_1" }),
    },
  );
}
