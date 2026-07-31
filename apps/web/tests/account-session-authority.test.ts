import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  readAccountSessionMode: vi.fn(),
  readDelegateAuthSessionSecret: vi.fn(),
  usesLegacyAccountSessionAuthority: vi.fn(),
  verifyDelegateAuthSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  DELEGATE_OWNER_AUTH_SESSION_COOKIE: "delegate_owner_auth_session",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  readAccountSessionMode: mocks.readAccountSessionMode,
  readDelegateAuthSessionSecret: mocks.readDelegateAuthSessionSecret,
  usesLegacyAccountSessionAuthority:
    mocks.usesLegacyAccountSessionAuthority,
  verifyDelegateAuthSession: mocks.verifyDelegateAuthSession,
}));

import { getOwnerAuthSession } from "../app/auth/owner-session";

describe("Dashboard account-session authority guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAccountSessionMode.mockReturnValue("legacy");
    mocks.usesLegacyAccountSessionAuthority.mockImplementation(
      (mode: string) => mode === "legacy" || mode === "shadow",
    );
    mocks.readDelegateAuthSessionSecret.mockReturnValue("session-secret");
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_owner_auth_session"
          ? { value: "signed-owner-session" }
          : undefined,
      ),
    });
    mocks.verifyDelegateAuthSession.mockReturnValue({
      version: 1,
      actor: "owner",
      provider: "logto",
      issuer: "https://auth.example.com/oidc",
      subject: "owner-subject",
      ownerId: "owner-1",
      issuedAt: 1_700_000_000,
      expiresAt: 4_102_444_800,
    });
  });

  it.each(["legacy", "shadow"])(
    "continues the bounded legacy authority in %s",
    async (mode) => {
      mocks.readAccountSessionMode.mockReturnValue(mode);

      await expect(getOwnerAuthSession()).resolves.toMatchObject({
        actor: "owner",
        ownerId: "owner-1",
      });
      expect(mocks.verifyDelegateAuthSession).toHaveBeenCalledWith(
        "signed-owner-session",
        "session-secret",
      );
    },
  );

  it.each(["enforce", "contract"])(
    "returns unauthenticated in %s without reading the legacy cookie",
    async (mode) => {
      mocks.readAccountSessionMode.mockReturnValue(mode);

      await expect(getOwnerAuthSession()).resolves.toBeNull();
      expect(mocks.cookies).not.toHaveBeenCalled();
      expect(mocks.readDelegateAuthSessionSecret).not.toHaveBeenCalled();
      expect(mocks.verifyDelegateAuthSession).not.toHaveBeenCalled();
    },
  );
});
