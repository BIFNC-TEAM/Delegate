import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PublicAudiencePrincipalError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "PublicAudiencePrincipalError";
    }
  }

  return {
    PublicAudiencePrincipalError,
    readDelegateAuthSessionSecret: vi.fn(),
    resolvePublicAudiencePrincipal: vi.fn(),
    verifyDelegateAuthSession: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE: "delegate_audience_auth_session",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  PublicAudiencePrincipalError: mocks.PublicAudiencePrincipalError,
  readDelegateAuthSessionSecret: mocks.readDelegateAuthSessionSecret,
  resolvePublicAudiencePrincipal: mocks.resolvePublicAudiencePrincipal,
  verifyDelegateAuthSession: mocks.verifyDelegateAuthSession,
}));

import { resolvePublicAudienceRequestPrincipal } from "../app/reps/[slug]/public-principal";

describe("public request principal revalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDelegateAuthSessionSecret.mockReturnValue("session-secret");
  });

  it("reuses the captured verified session to revalidate current canonical identity state", async () => {
    const verifiedSession = {
      version: 1 as const,
      actor: "audience" as const,
      provider: "logto" as const,
      subject: "logto-subject",
      audienceIdentityId: "session-identity",
      audienceId: "signed-device-audience",
      issuedAt: 1_700_000_000,
      expiresAt: 4_102_444_800,
    };
    const canonicalPrincipal = {
      mode: "authenticated" as const,
      audienceId: "signed-device-audience",
      audienceIdentityId: "canonical-identity",
      businessKey: "audience:canonical-identity",
    };
    mocks.verifyDelegateAuthSession.mockReturnValue(verifiedSession);
    mocks.resolvePublicAudiencePrincipal.mockResolvedValue(canonicalPrincipal);

    const audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: "delegate",
      cookieStore: {
        get(name) {
          return name === "delegate_audience_auth_session"
            ? { value: "verified-cookie" }
            : undefined;
        },
      },
    });
    await audienceRequest.revalidate();

    expect(mocks.resolvePublicAudiencePrincipal).toHaveBeenCalledTimes(2);
    expect(mocks.resolvePublicAudiencePrincipal).toHaveBeenNthCalledWith(2, {
      audienceId: "signed-device-audience",
      verifiedAuthSession: verifiedSession,
    });
  });

  it("fails revalidation when the current link no longer resolves to the captured principal", async () => {
    const verifiedSession = {
      version: 1 as const,
      actor: "audience" as const,
      provider: "logto" as const,
      subject: "logto-subject",
      audienceIdentityId: "session-identity",
      audienceId: "signed-device-audience",
      issuedAt: 1_700_000_000,
      expiresAt: 4_102_444_800,
    };
    mocks.verifyDelegateAuthSession.mockReturnValue(verifiedSession);
    mocks.resolvePublicAudiencePrincipal
      .mockResolvedValueOnce({
        mode: "authenticated",
        audienceId: "signed-device-audience",
        audienceIdentityId: "canonical-identity",
        businessKey: "audience:canonical-identity",
      })
      .mockResolvedValueOnce({
        mode: "authenticated",
        audienceId: "signed-device-audience",
        audienceIdentityId: "different-canonical-identity",
        businessKey: "audience:different-canonical-identity",
      });

    const audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: "delegate",
      cookieStore: {
        get(name) {
          return name === "delegate_audience_auth_session"
            ? { value: "verified-cookie" }
            : undefined;
        },
      },
    });

    await expect(audienceRequest.revalidate()).rejects.toMatchObject({
      code: "AUTHENTICATED_PRINCIPAL_INVALID",
    });
  });
});
