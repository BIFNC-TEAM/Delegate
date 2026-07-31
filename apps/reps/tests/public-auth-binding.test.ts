import { describe, expect, it, vi } from "vitest";

import { AudienceAuthSessionRotationRequiredError } from "@delegate/web-data";

import { bindPublicAudienceAuthProfile } from "../app/reps/[slug]/public-auth-binding";

const profile = {
  provider: "logto" as const,
  issuer: "https://auth.example.com/oidc",
  subject: "logto-user-b",
  email: "user-b@example.com",
  name: "User B",
  emailVerified: true,
};

const existingSessionState = {
  audienceId: "aud_existing",
  sessionToken: "existing-session-token-with-enough-entropy",
  expiresAt: "2026-08-05T12:00:00.000Z",
};

describe("public audience auth binding", () => {
  it("preserves an anonymous chat session when it can be bound safely", async () => {
    const dependencies = {
      linkAudienceIdentityToAuth: vi.fn().mockResolvedValue({
        id: "identity-existing",
        status: "REGISTERED",
        lastSeenAt: new Date("2026-07-29T12:00:00.000Z"),
      }),
      resolveWebAudienceContact: vi.fn(),
      createPublicChatSessionState: vi.fn(),
    };

    const result = await bindPublicAudienceAuthProfile(
      {
        representativeId: "rep-1",
        representativeSlug: "demo",
        initialAudienceIdentityId: "identity-existing",
        sessionState: existingSessionState,
        profile,
      },
      dependencies as never,
    );

    expect(result).toEqual({
      audienceIdentityId: "identity-existing",
      sessionState: existingSessionState,
      rotated: false,
    });
    expect(dependencies.createPublicChatSessionState).not.toHaveBeenCalled();
    expect(dependencies.resolveWebAudienceContact).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "demo",
      audienceId: "aud_existing",
      displayName: "User B",
      username: "user-b@example.com",
    });
  });

  it("rotates the browser chat identity before switching registered accounts", async () => {
    const rotatedSessionState = {
      audienceId: "aud_rotated",
      sessionToken: "rotated-session-token-with-enough-entropy",
      expiresAt: "2026-08-05T12:00:00.000Z",
    };
    const linkAudienceIdentityToAuth = vi
      .fn()
      .mockRejectedValueOnce(new AudienceAuthSessionRotationRequiredError())
      .mockResolvedValueOnce({
        id: "identity-account-b",
        status: "REGISTERED",
        lastSeenAt: new Date("2026-07-29T12:00:00.000Z"),
      });
    const dependencies = {
      linkAudienceIdentityToAuth,
      resolveWebAudienceContact: vi.fn().mockResolvedValue({
        id: "contact-b",
        representativeId: "rep-1",
        audienceIdentityId: "identity-fresh-anonymous",
      }),
      createPublicChatSessionState: vi.fn().mockReturnValue(rotatedSessionState),
    };

    const result = await bindPublicAudienceAuthProfile(
      {
        representativeId: "rep-1",
        representativeSlug: "demo",
        initialAudienceIdentityId: "identity-account-a",
        sessionState: existingSessionState,
        profile,
      },
      dependencies as never,
    );

    expect(result).toEqual({
      audienceIdentityId: "identity-account-b",
      sessionState: rotatedSessionState,
      rotated: true,
    });
    expect(dependencies.resolveWebAudienceContact).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "demo",
      audienceId: "aud_rotated",
      displayName: "User B",
      username: "user-b@example.com",
    });
    expect(linkAudienceIdentityToAuth).toHaveBeenNthCalledWith(1, {
      audienceIdentityId: "identity-account-a",
      profile,
    });
    expect(linkAudienceIdentityToAuth).toHaveBeenNthCalledWith(2, {
      audienceIdentityId: "identity-fresh-anonymous",
      profile,
    });
  });

  it("does not rotate the browser session for unrelated persistence errors", async () => {
    const dependencies = {
      linkAudienceIdentityToAuth: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
      resolveWebAudienceContact: vi.fn(),
      createPublicChatSessionState: vi.fn(),
    };

    await expect(
      bindPublicAudienceAuthProfile(
        {
          representativeId: "rep-1",
          representativeSlug: "demo",
          initialAudienceIdentityId: "identity-existing",
          sessionState: existingSessionState,
          profile,
        },
        dependencies as never,
      ),
    ).rejects.toThrow("database unavailable");
    expect(dependencies.createPublicChatSessionState).not.toHaveBeenCalled();
    expect(dependencies.resolveWebAudienceContact).not.toHaveBeenCalled();
  });
});
