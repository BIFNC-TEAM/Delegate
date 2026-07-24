import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicRepresentativeRuntime: vi.fn(),
  resolveWebAudienceContact: vi.fn(),
  resolveWebAudienceConversation: vi.fn(),
  createWebAudienceComputeSession: vi.fn(),
  normalizePublicComputeSessionRequest: vi.fn(),
  assertPublicAudienceResourceOwner: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
  setPublicAudienceSessionCookie: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  resolveWebAudienceContact: mocks.resolveWebAudienceContact,
  resolveWebAudienceConversation: mocks.resolveWebAudienceConversation,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: vi.fn() }),
}));

vi.mock("../app/reps/[slug]/web-compute", () => ({
  createWebAudienceComputeSession: mocks.createWebAudienceComputeSession,
  normalizePublicComputeSessionRequest:
    mocks.normalizePublicComputeSessionRequest,
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  assertPublicAudienceResourceOwner:
    mocks.assertPublicAudienceResourceOwner,
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie:
    mocks.setPublicAudienceSessionCookie,
}));

import { POST as createComputeSession } from "../app/reps/[slug]/compute/route";

describe("public principal compute route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: {
        id: "rep-1",
        compute: { enabled: true },
      },
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "signed-device-audience",
        audienceIdentityId: "identity-account",
        businessKey: "audience:identity-account",
      },
      sessionState: {
        audienceId: "signed-device-audience",
        sessionToken: "public-session-token",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
    mocks.resolveWebAudienceContact.mockResolvedValue({
      id: "contact-1",
      audienceIdentityId: "identity-account",
    });
    mocks.resolveWebAudienceConversation.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "identity-account",
    });
    mocks.normalizePublicComputeSessionRequest.mockReturnValue({
      subagentId: "browser-agent",
      requestedCapabilities: ["browser"],
      reason: "Open the account dashboard.",
    });
    mocks.createWebAudienceComputeSession.mockResolvedValue({
      id: "compute-session-1",
      status: "pending",
    });
    mocks.assertPublicAudienceResourceOwner.mockImplementation(
      (principal, actualIdentityId) => {
        if (principal.audienceIdentityId !== actualIdentityId) {
          throw new Error("principal_resource_mismatch");
        }
      },
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
  });

  it("uses the signed device thread under the canonical identity", async () => {
    const response = await createComputeSession(
      computeRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveWebAudienceContact).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "delegate",
      audienceId: "signed-device-audience",
    });
    expect(mocks.resolveWebAudienceConversation).toHaveBeenCalledWith({
      representativeId: "rep-1",
      contactId: "contact-1",
      audienceId: "signed-device-audience",
    });
    expect(mocks.assertPublicAudienceResourceOwner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        audienceIdentityId: "identity-account",
      }),
      "identity-account",
    );
    expect(mocks.setPublicAudienceSessionCookie).toHaveBeenCalledWith(
      response,
      expect.any(Request),
      "delegate",
      expect.objectContaining({
        audienceId: "signed-device-audience",
      }),
    );
    const body = await response.text();
    expect(body).not.toContain("identity-account");
    expect(body).not.toContain("signed-device-audience");
  });

  it("fails closed before creating compute when resource ownership differs", async () => {
    mocks.resolveWebAudienceContact.mockResolvedValue({
      id: "contact-other",
      audienceIdentityId: "identity-other",
    });
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await createComputeSession(
      computeRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveWebAudienceConversation).not.toHaveBeenCalled();
    expect(mocks.createWebAudienceComputeSession).not.toHaveBeenCalled();
    const body = await response.text();
    expect(body).not.toContain("identity-account");
    expect(body).not.toContain("identity-other");
  });

  it("never downgrades a rejected authenticated principal to anonymous", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("authenticated_principal_invalid"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await createComputeSession(
      computeRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveWebAudienceContact).not.toHaveBeenCalled();
    expect(mocks.createWebAudienceComputeSession).not.toHaveBeenCalled();
  });
});

describe("public principal route coverage", () => {
  const routePaths = [
    "../app/reps/[slug]/chat/route.ts",
    "../app/reps/[slug]/chat/events/route.ts",
    "../app/reps/[slug]/chat/runs/[runId]/events/route.ts",
    "../app/reps/[slug]/chat/artifacts/[artifactId]/download/route.ts",
    "../app/reps/[slug]/compute/route.ts",
  ];

  it.each(routePaths)(
    "%s resolves the server-authoritative principal instead of a raw audience key",
    (routePath) => {
      const source = readFileSync(resolve(__dirname, routePath), "utf8");
      expect(source).toContain("resolvePublicAudienceRequestPrincipal");
      expect(source).not.toContain("buildWebAudienceKey");
    },
  );
});

function computeRequest() {
  return new Request("http://localhost/reps/delegate/compute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subagentId: "browser-agent",
      requestedCapabilities: ["browser"],
      reason: "Open the account dashboard.",
    }),
  });
}
