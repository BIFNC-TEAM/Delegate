import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createIdentityBindingChallenge: vi.fn(),
  listActivePrivateChannelIdentityBindings: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  resolveMatrixApplicationServiceConnectionId: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  createIdentityBindingChallenge: mocks.createIdentityBindingChallenge,
  listActivePrivateChannelIdentityBindings:
    mocks.listActivePrivateChannelIdentityBindings,
  privateChannelIdentityProviders: {
    matrix: "MATRIX",
    telegram: "TELEGRAM",
  },
  resolveMatrixApplicationServiceConnectionId:
    mocks.resolveMatrixApplicationServiceConnectionId,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: vi.fn() }),
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
}));

import {
  GET as listIdentityBindings,
  POST as createIdentityBinding,
} from "../app/reps/[slug]/identity-bindings/route";

describe("public identity binding principal enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
    mocks.resolveMatrixApplicationServiceConnectionId.mockReturnValue(
      "matrix-appservice",
    );
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "signed-device-audience",
        audienceIdentityId: "canonical-identity",
        businessKey: "audience:canonical-identity",
      },
      sessionState: {
        audienceId: "signed-device-audience",
        sessionToken: "public-session-token",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
      revalidate: vi.fn(),
    });
    mocks.listActivePrivateChannelIdentityBindings.mockResolvedValue([
      { id: "binding-1", provider: "MATRIX" },
    ]);
    mocks.createIdentityBindingChallenge.mockResolvedValue({
      token: "bind-token",
      expiresAt: new Date("2026-08-01T00:05:00.000Z"),
    });
  });

  it("returns 401 from GET before listing when the current subject is invalid", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("revoked_current_subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.listActivePrivateChannelIdentityBindings).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Sign in before binding a channel.",
    });
  });

  it("returns 401 from POST before creating when the current subject is invalid", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("revoked_current_subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.createIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it("uses only the resolver's canonical identity for GET and POST business calls", async () => {
    const listResponse = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    const createResponse = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(listResponse.status).toBe(200);
    expect(createResponse.status).toBe(201);
    expect(mocks.resolvePublicAudienceRequestPrincipal).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      cookieStore: expect.objectContaining({ get: expect.any(Function) }),
    });
    expect(mocks.listActivePrivateChannelIdentityBindings).toHaveBeenCalledWith(
      "canonical-identity",
    );
    expect(mocks.createIdentityBindingChallenge).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "MATRIX",
      issuer: "matrix.example",
      connectionId: "matrix-appservice",
      expectedProviderSubject: "@neo:matrix.example",
      metadata: {
        representativeSlug: "delegate",
        requestedFrom: "representative_web",
      },
    });
    expect(
      JSON.stringify(mocks.createIdentityBindingChallenge.mock.calls),
    ).not.toContain("signed-device-audience");
  });
});

function matrixBindingRequest() {
  return new Request("http://localhost/reps/delegate/identity-bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "matrix",
      providerSubject: "@neo:matrix.example",
    }),
  });
}
