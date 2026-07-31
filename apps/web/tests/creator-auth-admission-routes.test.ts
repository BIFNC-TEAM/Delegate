import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildDelegateDevAuthProfile: vi.fn(),
  buildLogtoAuthorizeUrl: vi.fn(),
  buildVerifiedExternalAuthProfileFromLogtoIdToken: vi.fn(),
  createDelegateAuthSession: vi.fn(),
  createDelegateAuthState: vi.fn(),
  derivePkceCodeChallenge: vi.fn(),
  exchangeLogtoCodeForTokens: vi.fn(),
  generateAuthStateToken: vi.fn(),
  generatePkceCodeVerifier: vi.fn(),
  issueAccountSessionShadow: vi.fn(),
  isCreatorAdmissionRequiredError: vi.fn(),
  isDelegateAuthPersistenceUnavailableError: vi.fn(),
  isLogtoOidcConfigured: vi.fn(),
  readDelegateAuthSessionSecret: vi.fn(),
  readAccountSessionMode: vi.fn(),
  readLogtoOidcConfig: vi.fn(),
  resolveOwnerForAuth: vi.fn(),
  shouldUseDelegateAuthDevLogin: vi.fn(),
  signDelegateAuthSession: vi.fn(),
  signDelegateAuthState: vi.fn(),
  usesLegacyAccountSessionAuthority: vi.fn(),
  verifyDelegateAuthState: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE:
    "delegate_dashboard_session_v2",
  DELEGATE_OWNER_AUTH_SESSION_COOKIE: "delegate_owner_auth_session",
  DELEGATE_OWNER_AUTH_STATE_COOKIE: "delegate_owner_auth_state",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  LEGACY_DELEGATE_AUTH_STATE_COOKIE: "delegate_auth_state",
  buildDelegateDevAuthProfile: mocks.buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl: mocks.buildLogtoAuthorizeUrl,
  buildVerifiedExternalAuthProfileFromLogtoIdToken:
    mocks.buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession: mocks.createDelegateAuthSession,
  createDelegateAuthState: mocks.createDelegateAuthState,
  derivePkceCodeChallenge: mocks.derivePkceCodeChallenge,
  exchangeLogtoCodeForTokens: mocks.exchangeLogtoCodeForTokens,
  generateAuthStateToken: mocks.generateAuthStateToken,
  generatePkceCodeVerifier: mocks.generatePkceCodeVerifier,
  issueAccountSessionShadow: mocks.issueAccountSessionShadow,
  isCreatorAdmissionRequiredError: mocks.isCreatorAdmissionRequiredError,
  isDelegateAuthPersistenceUnavailableError:
    mocks.isDelegateAuthPersistenceUnavailableError,
  isLogtoOidcConfigured: mocks.isLogtoOidcConfigured,
  readDelegateAuthSessionSecret: mocks.readDelegateAuthSessionSecret,
  readAccountSessionMode: mocks.readAccountSessionMode,
  readLogtoOidcConfig: mocks.readLogtoOidcConfig,
  resolveOwnerForAuth: mocks.resolveOwnerForAuth,
  shouldUseDelegateAuthDevLogin: mocks.shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession: mocks.signDelegateAuthSession,
  signDelegateAuthState: mocks.signDelegateAuthState,
  usesLegacyAccountSessionAuthority:
    mocks.usesLegacyAccountSessionAuthority,
  verifyDelegateAuthState: mocks.verifyDelegateAuthState,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("../auth-guard", () => ({
  buildCreatorCanonicalAuthRequestUrl: vi.fn(() => null),
  buildCreatorRedirectUrl: vi.fn((pathname: string) =>
    new URL(pathname, "https://dashboard.example.com"),
  ),
  sanitizeCreatorReturnTo: vi.fn(
    (returnTo: string | null) => returnTo ?? "/dashboard",
  ),
}));

import { GET as completeCreatorLogin } from "../app/auth/callback/route";
import { GET as startCreatorLogin } from "../app/auth/login/route";

describe("creator admission auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const admissionError = Object.assign(
      new Error("Creator access requires an invitation."),
      { code: "CREATOR_ADMISSION_REQUIRED" },
    );

    mocks.readDelegateAuthSessionSecret.mockReturnValue("test-secret");
    mocks.readAccountSessionMode.mockReturnValue("legacy");
    mocks.usesLegacyAccountSessionAuthority.mockImplementation(
      (mode: string) => mode === "legacy" || mode === "shadow",
    );
    mocks.readLogtoOidcConfig.mockReturnValue({
      endpoint: "https://auth.example.com",
      appId: "app-1",
      appSecret: "secret",
      redirectUri: "https://dashboard.example.com/auth/callback",
    });
    mocks.verifyDelegateAuthState.mockReturnValue({
      version: 2,
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier:
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      returnTo: "/dashboard",
    });
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_owner_auth_state"
          ? { value: "signed-state" }
          : undefined,
      ),
    });
    mocks.exchangeLogtoCodeForTokens.mockResolvedValue({
      idToken: "id-token",
    });
    mocks.generatePkceCodeVerifier.mockReturnValue(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    mocks.derivePkceCodeChallenge.mockReturnValue(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    mocks.buildVerifiedExternalAuthProfileFromLogtoIdToken.mockResolvedValue({
      provider: "logto",
      issuer: "https://auth.example.com/oidc",
      subject: "uninvited-subject",
      email: "user@example.com",
    });
    mocks.buildDelegateDevAuthProfile.mockReturnValue({
      provider: "logto",
      issuer: "https://local-auth.delegate.invalid/oidc",
      subject: "delegate-dev-owner",
      email: "creator@delegate.local",
    });
    mocks.isCreatorAdmissionRequiredError.mockImplementation(
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CREATOR_ADMISSION_REQUIRED",
    );
    mocks.isDelegateAuthPersistenceUnavailableError.mockReturnValue(false);
    mocks.resolveOwnerForAuth.mockRejectedValue(admissionError);
    mocks.issueAccountSessionShadow.mockResolvedValue(
      issuedShadowSession("new-dashboard-v2-token"),
    );
  });

  it("starts every new Logto authorization with PKCE S256 state", async () => {
    mocks.isLogtoOidcConfigured.mockReturnValue(true);
    mocks.generateAuthStateToken
      .mockReturnValueOnce("state-1")
      .mockReturnValueOnce("nonce-1");
    mocks.createDelegateAuthState.mockReturnValue({
      version: 2,
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier:
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      returnTo: "/dashboard",
    });
    mocks.buildLogtoAuthorizeUrl.mockReturnValue(
      "https://auth.example.com/oidc/auth?state=state-1",
    );
    mocks.signDelegateAuthState.mockReturnValue("signed-pkce-state");

    const response = await startCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/login?returnTo=%2Fdashboard",
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.createDelegateAuthState).toHaveBeenCalledWith({
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier:
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      returnTo: "/dashboard",
    });
    expect(mocks.buildLogtoAuthorizeUrl).toHaveBeenCalledWith(
      expect.any(Object),
      {
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge:
          "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      },
    );
    expect(
      response.cookies.get("delegate_owner_auth_state")?.value,
    ).toBe("signed-pkce-state");
    expect(mocks.isLogtoOidcConfigured).toHaveBeenCalledWith("dashboard");
    expect(mocks.readLogtoOidcConfig).toHaveBeenCalledWith("dashboard");
  });

  it("redirects an uninvited Logto callback without creating a session", async () => {
    const response = await completeCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://dashboard.example.com/auth/error?reason=creator_access_required",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "delegate_owner_auth_state=",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "delegate_owner_auth_session=",
    );
    expect(
      response.cookies.get("delegate_dashboard_session_v2")?.value,
    ).toBe("");
    expect(mocks.createDelegateAuthSession).not.toHaveBeenCalled();
    expect(mocks.signDelegateAuthSession).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledWith(
      expect.any(Object),
      {
        code: "code-1",
        codeVerifier:
          "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      },
    );
  });

  it("lets an already-issued v1 callback finish without a verifier", async () => {
    mocks.verifyDelegateAuthState.mockReturnValue({
      version: 1,
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      returnTo: "/dashboard",
    });

    await completeCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/callback?code=code-1&state=state-1",
      ),
    );

    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledWith(
      expect.any(Object),
      {
        code: "code-1",
        codeVerifier: undefined,
      },
    );
  });

  it("does not access Account/AppSession v2 on a successful legacy callback", async () => {
    mocks.resolveOwnerForAuth.mockResolvedValue({
      owner: { id: "owner-1" },
      identityLink: { id: "owner-link-1" },
      created: false,
    });
    mocks.createDelegateAuthSession.mockReturnValue(legacyOwnerSession());
    mocks.signDelegateAuthSession.mockReturnValue("signed-legacy-session");

    const response = await completeCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.issueAccountSessionShadow).not.toHaveBeenCalled();
    expect(
      response.cookies.get("delegate_dashboard_session_v2"),
    ).toBeUndefined();
  });

  it("applies the same invitation boundary to explicit local development login", async () => {
    mocks.isLogtoOidcConfigured.mockReturnValue(false);
    mocks.shouldUseDelegateAuthDevLogin.mockReturnValue(true);

    const response = await startCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/login?returnTo=%2Fdashboard",
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://dashboard.example.com/auth/error?reason=creator_access_required",
    );
    expect(mocks.resolveOwnerForAuth).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "delegate-dev-owner" }),
    );
    expect(mocks.createDelegateAuthSession).not.toHaveBeenCalled();
    expect(
      response.cookies.get("delegate_dashboard_session_v2")?.value,
    ).toBe("");
  });

  it("atomically issues and rotates a Dashboard v2 session after a verified callback in shadow mode", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name === "delegate_owner_auth_state") {
          return { value: "signed-state" };
        }
        if (name === "delegate_dashboard_session_v2") {
          return { value: "old-dashboard-v2-token" };
        }
        return undefined;
      }),
    });
    mocks.resolveOwnerForAuth.mockResolvedValue({
      owner: { id: "owner-1" },
      identityLink: { id: "owner-link-1" },
      created: false,
    });
    mocks.createDelegateAuthSession.mockReturnValue(legacyOwnerSession());
    mocks.signDelegateAuthSession.mockReturnValue("signed-legacy-session");

    const response = await completeCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/callback?code=code-1&state=state-1",
        { headers: { "user-agent": "Browser/1.0" } },
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.issueAccountSessionShadow).toHaveBeenCalledWith({
      principal: expect.objectContaining({
        provider: "logto",
        issuer: "https://auth.example.com/oidc",
        subject: "uninvited-subject",
        verifiedAt: expect.any(Date),
        metadata: {
          verificationSource: "logto_jwks_callback",
        },
      }),
      persona: { kind: "owner", ownerId: "owner-1" },
      application: "DASHBOARD",
      previousToken: "old-dashboard-v2-token",
      userAgent: "Browser/1.0",
      now: expect.any(Date),
    });
    const appCookie = response.cookies.get(
      "delegate_dashboard_session_v2",
    );
    expect(appCookie?.value).toBe("new-dashboard-v2-token");
    expect(appCookie?.httpOnly).toBe(true);
    expect(appCookie?.sameSite).toBe("lax");
    expect(appCookie?.path).toBe("/");
  });

  it("uses only the explicit development bypass to issue a local shadow session", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.isLogtoOidcConfigured.mockReturnValue(false);
    mocks.shouldUseDelegateAuthDevLogin.mockReturnValue(true);
    mocks.resolveOwnerForAuth.mockResolvedValue({
      owner: { id: "owner-dev" },
      identityLink: { id: "owner-link-dev" },
      created: false,
    });
    mocks.createDelegateAuthSession.mockReturnValue(legacyOwnerSession());
    mocks.signDelegateAuthSession.mockReturnValue("signed-legacy-session");

    const response = await startCreatorLogin(
      new Request("https://dashboard.example.com/auth/login"),
    );

    expect(response.status).toBe(307);
    expect(mocks.issueAccountSessionShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({
          issuer: "https://local-auth.delegate.invalid/oidc",
          subject: "delegate-dev-owner",
          metadata: {
            verificationSource: "explicit_development_bypass",
          },
        }),
        persona: { kind: "owner", ownerId: "owner-dev" },
        application: "DASHBOARD",
      }),
    );
  });

  it.each(["enforce", "contract"])(
    "refuses %s while v2 read authority is not implemented",
    async (mode) => {
      mocks.readAccountSessionMode.mockReturnValue(mode);

      const response = await startCreatorLogin(
        new Request("https://dashboard.example.com/auth/login"),
      );

      expect(response.status).toBe(503);
      expect(mocks.isLogtoOidcConfigured).not.toHaveBeenCalled();
      expect(mocks.resolveOwnerForAuth).not.toHaveBeenCalled();
    },
  );

  it("refuses an in-flight callback in contract mode before token exchange", async () => {
    mocks.readAccountSessionMode.mockReturnValue("contract");

    const response = await completeCreatorLogin(
      new Request(
        "https://dashboard.example.com/auth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(503);
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
  });
});

function issuedShadowSession(token: string) {
  return {
    token,
    session: {
      issuedAt: new Date("2026-07-29T08:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-08-28T08:00:00.000Z"),
    },
  };
}

function legacyOwnerSession() {
  return {
    version: 1,
    actor: "owner",
    provider: "logto",
    issuer: "https://auth.example.com/oidc",
    subject: "uninvited-subject",
    ownerId: "owner-1",
    issuedAt: 1_783_166_400,
    expiresAt: 1_785_758_400,
  };
}
