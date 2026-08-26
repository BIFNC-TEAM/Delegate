import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  readAccountSessionMode: vi.fn(),
  readDelegateAuthSessionSecret: vi.fn(),
  observeAccountSessionParity: vi.fn(),
  resolveAccountSessionAuthority: vi.fn(),
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
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE: "delegate_dashboard_session_v2",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  readAccountSessionMode: mocks.readAccountSessionMode,
  readDelegateAuthSessionSecret: mocks.readDelegateAuthSessionSecret,
  observeAccountSessionParity: mocks.observeAccountSessionParity,
  resolveAccountSessionAuthority: mocks.resolveAccountSessionAuthority,
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
      get: vi.fn((name: string) => {
        if (name === "delegate_owner_auth_session") {
          return { value: "signed-owner-session" };
        }
        if (name === "delegate_dashboard_session_v2") {
          return { value: "opaque-dashboard-token" };
        }
        return undefined;
      }),
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
    mocks.resolveAccountSessionAuthority.mockResolvedValue({
      version: 2,
      actor: "owner",
      provider: "logto",
      accountId: "account-1",
      authIdentityId: "identity-1",
      issuer: "https://auth.example.com/oidc",
      subject: "owner-subject",
      ownerId: "owner-1",
      email: "owner@example.com",
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

  it("compares but does not promote v2 authority during shadow", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");

    const session = await getOwnerAuthSession();

    expect(session).toMatchObject({ version: 1, ownerId: "owner-1" });
    expect(mocks.resolveAccountSessionAuthority).toHaveBeenCalledWith({
      token: "opaque-dashboard-token",
      application: "DASHBOARD",
    });
    expect(mocks.observeAccountSessionParity).toHaveBeenCalledWith(
      expect.objectContaining({
        application: "DASHBOARD",
        v2Token: "opaque-dashboard-token",
      }),
    );
  });

  it.each(["enforce", "contract"])(
    "uses only AppSession v2 authority in %s",
    async (mode) => {
      mocks.readAccountSessionMode.mockReturnValue(mode);

      await expect(getOwnerAuthSession()).resolves.toMatchObject({
        version: 2,
        actor: "owner",
        ownerId: "owner-1",
      });
      expect(mocks.resolveAccountSessionAuthority).toHaveBeenCalledWith({
        token: "opaque-dashboard-token",
        application: "DASHBOARD",
      });
      expect(mocks.readDelegateAuthSessionSecret).not.toHaveBeenCalled();
      expect(mocks.verifyDelegateAuthSession).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the v2 token has no current Owner authority", async () => {
    mocks.readAccountSessionMode.mockReturnValue("enforce");
    mocks.resolveAccountSessionAuthority.mockResolvedValue(null);

    await expect(getOwnerAuthSession()).resolves.toBeNull();
  });
});
