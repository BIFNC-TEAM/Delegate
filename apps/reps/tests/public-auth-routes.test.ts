import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieStore: vi.fn(),
  getPublicRepresentativeRuntime: vi.fn(),
  buildLogtoAuthorizeUrl: vi.fn(),
  buildDelegateDevAuthProfile: vi.fn(),
  buildVerifiedExternalAuthProfileFromLogtoIdToken: vi.fn(),
  createDelegateAuthSession: vi.fn(),
  createDelegateRepresentativeAuthState: vi.fn(),
  derivePkceCodeChallenge: vi.fn(),
  exchangeLogtoCodeForTokens: vi.fn(),
  generateAuthStateToken: vi.fn(),
  generatePkceCodeVerifier: vi.fn(),
  issueAccountSessionShadow: vi.fn(),
  isAudienceAuthSessionRotationRequiredError: vi.fn(),
  isLegacyRepresentativeCallbackEnabled: vi.fn(),
  isLogtoOidcConfigured: vi.fn(),
  linkAudienceIdentityToAuth: vi.fn(),
  readDelegateAuthSessionSecret: vi.fn(),
  readAccountSessionMode: vi.fn(),
  readLegacyRepresentativeLogtoOidcConfig: vi.fn(),
  readLogtoOidcConfig: vi.fn(),
  resolveWebAudienceContact: vi.fn(),
  revokeAppSession: vi.fn(),
  signDelegateAuthSession: vi.fn(),
  signDelegateAuthState: vi.fn(),
  verifyDelegateAuthState: vi.fn(),
  usesLegacyAccountSessionAuthority: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookieStore,
}));

vi.mock("@delegate/web-data", () => ({
  AudienceAuthSessionRotationRequiredError: class extends Error {},
  isAudienceAuthSessionRotationRequiredError:
    mocks.isAudienceAuthSessionRotationRequiredError,
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE:
    "delegate_audience_auth_session",
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE:
    "delegate_audience_auth_state",
  DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE:
    "delegate_reps_session_v2",
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE:
    "delegate_representatives_auth_state_v3",
  DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH:
    "/auth/callback",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  LEGACY_DELEGATE_AUTH_STATE_COOKIE: "delegate_auth_state",
  buildDelegateDevAuthProfile: mocks.buildDelegateDevAuthProfile,
  buildLogtoAuthorizeUrl: mocks.buildLogtoAuthorizeUrl,
  buildVerifiedExternalAuthProfileFromLogtoIdToken:
    mocks.buildVerifiedExternalAuthProfileFromLogtoIdToken,
  createDelegateAuthSession: mocks.createDelegateAuthSession,
  createDelegateRepresentativeAuthState:
    mocks.createDelegateRepresentativeAuthState,
  derivePkceCodeChallenge: mocks.derivePkceCodeChallenge,
  exchangeLogtoCodeForTokens: mocks.exchangeLogtoCodeForTokens,
  generateAuthStateToken: mocks.generateAuthStateToken,
  generatePkceCodeVerifier: mocks.generatePkceCodeVerifier,
  issueAccountSessionShadow: mocks.issueAccountSessionShadow,
  getPublicRepresentativeRuntime:
    mocks.getPublicRepresentativeRuntime,
  isDelegateAuthPersistenceUnavailableError: vi.fn(),
  isLegacyRepresentativeCallbackEnabled:
    mocks.isLegacyRepresentativeCallbackEnabled,
  isLogtoOidcConfigured: mocks.isLogtoOidcConfigured,
  linkAudienceIdentityToAuth: mocks.linkAudienceIdentityToAuth,
  readDelegateAuthSessionSecret: mocks.readDelegateAuthSessionSecret,
  readAccountSessionMode: mocks.readAccountSessionMode,
  readLegacyRepresentativeLogtoOidcConfig:
    mocks.readLegacyRepresentativeLogtoOidcConfig,
  readLogtoOidcConfig: mocks.readLogtoOidcConfig,
  resolveWebAudienceContact: mocks.resolveWebAudienceContact,
  revokeAppSession: mocks.revokeAppSession,
  shouldUseDelegateAuthDevLogin: vi.fn(),
  signDelegateAuthSession: mocks.signDelegateAuthSession,
  signDelegateAuthState: mocks.signDelegateAuthState,
  verifyDelegateAuthState: mocks.verifyDelegateAuthState,
  usesLegacyAccountSessionAuthority:
    mocks.usesLegacyAccountSessionAuthority,
}));

import { GET as fixedCallback } from "../app/auth/callback/route";
import { GET as legacyCallback } from "../app/reps/[slug]/auth/callback/route";
import { GET as login } from "../app/reps/[slug]/auth/login/route";
import { GET as logout } from "../app/reps/[slug]/auth/logout/route";
import {
  createPublicChatSessionState,
  getPublicChatCookieName,
  readPublicChatSessionState,
  writePublicChatSessionState,
} from "../app/reps/[slug]/public-chat";

const originalNodeEnv = process.env.NODE_ENV;
const originalRepresentativeUrl =
  process.env.NEXT_PUBLIC_REPRESENTATIVE_URL;
const originalPublicChatSecret =
  process.env.REP_PUBLIC_CHAT_SESSION_SECRET;
const pkceCodeVerifier =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const pkceCodeChallenge =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const authRouteCases = [
  {
    name: "login",
    handler: login,
    path:
      "/reps/demo/auth/login?returnTo=%2Freps%2Fdemo%3Flang%3Dzh",
  },
  {
    name: "logout",
    handler: logout,
    path: "/reps/demo/auth/logout?returnTo=%2Freps%2Fdemo",
  },
] as const;

describe("public representative canonical auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "missing",
    });
    restoreEnv("NODE_ENV", "production");
    restoreEnv(
      "NEXT_PUBLIC_REPRESENTATIVE_URL",
      "https://reps.example.com",
    );
    restoreEnv(
      "REP_PUBLIC_CHAT_SESSION_SECRET",
      "public-auth-routes-test-secret",
    );
    mocks.cookieStore.mockResolvedValue({
      get: vi.fn(() => undefined),
    });
    mocks.isAudienceAuthSessionRotationRequiredError.mockReturnValue(false);
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(false);
    mocks.isLogtoOidcConfigured.mockReturnValue(false);
    mocks.readDelegateAuthSessionSecret.mockReturnValue("auth-session-secret");
    mocks.readAccountSessionMode.mockReturnValue("legacy");
    mocks.usesLegacyAccountSessionAuthority.mockImplementation(
      (mode: string) => mode === "legacy" || mode === "shadow",
    );
    mocks.readLogtoOidcConfig.mockReturnValue({
      endpoint: "https://auth.example.com",
      appId: "reps-app",
      appSecret: "reps-secret",
      redirectUri: "https://reps.example.com/auth/callback",
    });
    mocks.readLegacyRepresentativeLogtoOidcConfig.mockReturnValue({
      endpoint: "https://legacy-auth.example.com",
      appId: "legacy-reps-app",
      appSecret: "legacy-reps-secret",
      redirectUri:
        "https://reps.example.com/reps/demo/auth/callback",
    });
    mocks.generatePkceCodeVerifier.mockReturnValue(pkceCodeVerifier);
    mocks.derivePkceCodeChallenge.mockReturnValue(pkceCodeChallenge);
    mocks.buildDelegateDevAuthProfile.mockReturnValue({
      provider: "logto",
      issuer: "https://local-auth.delegate.invalid/oidc",
      subject: "delegate-dev-audience",
      email: "audience@delegate.local",
      emailVerified: true,
      name: "Local Delegate User",
    });
    mocks.issueAccountSessionShadow.mockResolvedValue(
      issuedShadowSession("new-reps-v2-token"),
    );
    mocks.revokeAppSession.mockResolvedValue(true);
  });

  afterAll(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv(
      "NEXT_PUBLIC_REPRESENTATIVE_URL",
      originalRepresentativeUrl,
    );
    restoreEnv(
      "REP_PUBLIC_CHAT_SESSION_SECRET",
      originalPublicChatSecret,
    );
  });

  it.each(authRouteCases)(
    "redirects an alias-host $name request before reading or writing cookies",
    async ({ handler, path }) => {
      const response = await handler(
        new Request(`http://127.0.0.1:3002${path}`, {
          headers: {
            host: "alias.example",
            "x-forwarded-host": "reps.example.com",
            "x-forwarded-proto": "https",
          },
        }),
        { params: Promise.resolve({ slug: "demo" }) },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `https://reps.example.com${path}`,
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocks.cookieStore).not.toHaveBeenCalled();
      expect(
        mocks.getPublicRepresentativeRuntime,
      ).not.toHaveBeenCalled();
    },
  );

  it("returns 410 without redirecting or exchanging when the legacy callback window is unavailable", async () => {
    const response = await legacyCallback(
      new Request(
        "http://127.0.0.1:3002/reps/demo/auth/callback?code=code-1&state=state-1",
        {
          headers: {
            host: "alias.example",
            "x-forwarded-proto": "https",
          },
        },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.cookieStore).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
  });

  it.each(authRouteCases)(
    "fails closed in $name when the production canonical origin is missing",
    async ({ handler, path }) => {
      delete process.env.NEXT_PUBLIC_REPRESENTATIVE_URL;

      const response = await handler(
        new Request(`https://reps.example.com${path}`, {
          headers: { host: "reps.example.com" },
        }),
        { params: Promise.resolve({ slug: "demo" }) },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error:
          "NEXT_PUBLIC_REPRESENTATIVE_URL is required in production.",
      });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocks.cookieStore).not.toHaveBeenCalled();
      expect(
        mocks.getPublicRepresentativeRuntime,
      ).not.toHaveBeenCalled();
    },
  );

  it("ignores a forged loopback X-Forwarded-Host on a canonical proxy request", async () => {
    const response = await login(
      new Request("http://127.0.0.1:3002/reps/demo/auth/login", {
        headers: {
          host: "reps.example.com",
          "x-forwarded-host": "localhost:3002",
          "x-forwarded-proto": "https",
        },
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.getPublicRepresentativeRuntime).toHaveBeenCalledWith(
      "demo",
    );
  });

  it("starts public Logto authorization with PKCE S256 state", async () => {
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "rep-1" },
    });
    mocks.resolveWebAudienceContact.mockResolvedValue({
      audienceIdentityId: "audience-identity-1",
    });
    mocks.isLogtoOidcConfigured.mockReturnValue(true);
    mocks.generateAuthStateToken
      .mockReturnValueOnce("state-1")
      .mockReturnValueOnce("nonce-1");
    mocks.createDelegateRepresentativeAuthState.mockReturnValue({
      version: 3,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      publicChat: {
        audienceId: "aud_1",
        sessionToken: "signed-public-chat-session-token",
        expiresAt: "2026-08-05T00:00:00.000Z",
      },
    });
    mocks.buildLogtoAuthorizeUrl.mockReturnValue(
      "https://auth.example.com/oidc/auth?state=state-1",
    );
    mocks.signDelegateAuthState.mockReturnValue("signed-pkce-state");

    const response = await login(
      new Request(
        "https://reps.example.com/reps/demo/auth/login?returnTo=%2Freps%2Fdemo",
        { headers: { host: "reps.example.com" } },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(
      mocks.createDelegateRepresentativeAuthState,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "state-1",
        nonce: "nonce-1",
        codeVerifier: pkceCodeVerifier,
        representativeSlug: "demo",
        publicChat: expect.objectContaining({
          audienceId: expect.any(String),
          sessionToken: expect.any(String),
          expiresAt: expect.any(String),
        }),
      }),
    );
    expect(mocks.buildLogtoAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://reps.example.com/auth/callback",
      }),
      {
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: pkceCodeChallenge,
        prompt: "login",
      },
    );
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.value,
    ).toBe("signed-pkce-state");
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.path,
    ).toBe("/auth/callback");
    expect(mocks.isLogtoOidcConfigured).toHaveBeenCalledWith(
      "representatives",
    );
    expect(mocks.readLogtoOidcConfig).toHaveBeenCalledWith(
      "representatives",
    );
  });

  it("uses only signed v3 state at the fixed callback and reconstructs the scoped public-chat cookie", async () => {
    configureSuccessfulFixedCallback({
      version: 3,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/other",
      representativeSlug: "demo",
      publicChat: {
        audienceId: "aud_1",
        sessionToken: "signed-public-chat-session-token",
        expiresAt: "2026-08-05T00:00:00.000Z",
      },
    });

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1&slug=forged",
        { headers: { host: "reps.example.com" } },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://reps.example.com/reps/demo#chat",
    );
    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledWith(
      expect.any(Object),
      {
        code: "code-1",
        codeVerifier: pkceCodeVerifier,
      },
    );
    expect(
      mocks.getPublicRepresentativeRuntime,
    ).toHaveBeenCalledWith("demo");
    expect(mocks.resolveWebAudienceContact).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "demo",
      audienceId: "aud_1",
    });
    expect(
      response.cookies.get(getPublicChatCookieName("demo"))?.path,
    ).toBe("/reps/demo");
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.value,
    ).toBe("");
    expect(mocks.issueAccountSessionShadow).not.toHaveBeenCalled();
    expect(
      response.cookies.get("delegate_reps_session_v2"),
    ).toBeUndefined();
  });

  it("rejects v1/v2 state at the fixed callback before runtime or token access", async () => {
    mocks.cookieStore.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_representatives_auth_state_v3"
          ? { value: "signed-old-state" }
          : undefined,
      ),
    });
    mocks.verifyDelegateAuthState.mockReturnValue({
      version: 2,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    });

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.getPublicRepresentativeRuntime).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
  });

  it("lets an already-issued public v1 callback finish in place only during the legacy window", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    configureSuccessfulLegacyCallback({
      version: 1,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    });

    await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
        { headers: { host: "reps.example.com" } },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://legacy-auth.example.com",
        appId: "legacy-reps-app",
        redirectUri:
          "https://reps.example.com/reps/demo/auth/callback",
      }),
      {
        code: "code-1",
        codeVerifier: undefined,
      },
    );
    expect(
      mocks.readLegacyRepresentativeLogtoOidcConfig,
    ).toHaveBeenCalledWith("demo");
  });

  it("lets an already-issued public v2 callback finish in place with its PKCE verifier", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    configureSuccessfulLegacyCallback({
      version: 2,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    });

    const response = await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
        { headers: { host: "reps.example.com" } },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledWith(
      expect.any(Object),
      {
        code: "code-1",
        codeVerifier: pkceCodeVerifier,
      },
    );
  });

  it("selects the matching legacy cookie when a newer valid cookie has unrelated state", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    const matchingState = {
      version: 2,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    };
    configureSuccessfulLegacyCallback(matchingState);
    mocks.cookieStore.mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name === "delegate_audience_auth_state") {
          return { value: "signed-newer-unrelated-state" };
        }
        if (name === "delegate_auth_state") {
          return { value: "signed-matching-legacy-state" };
        }
        return undefined;
      }),
    });
    mocks.verifyDelegateAuthState
      .mockReset()
      .mockReturnValueOnce({
        ...matchingState,
        state: "other-state",
      })
      .mockReturnValueOnce(matchingState);

    const response = await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledTimes(1);
  });

  it("returns 410 with zero token calls when the legacy tuple is incomplete", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    mocks.verifyDelegateAuthState.mockReturnValue({
      version: 2,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    });
    mocks.readLegacyRepresentativeLogtoOidcConfig.mockImplementation(() => {
      throw new Error("LOGTO_REPS_LEGACY_APP_SECRET is required");
    });

    const response = await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(410);
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
  });

  it("returns 410 before legacy config or token access for invalid signed state", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    mocks.verifyDelegateAuthState.mockReturnValue(null);

    const response = await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(410);
    expect(
      mocks.readLegacyRepresentativeLogtoOidcConfig,
    ).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
  });

  it("applies the cross-persona shadow fallback to an in-flight legacy callback", async () => {
    mocks.isLegacyRepresentativeCallbackEnabled.mockReturnValue(true);
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    configureSuccessfulLegacyCallback({
      version: 2,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      audienceId: "aud_1",
    }, "old-reps-v2-token");
    mocks.issueAccountSessionShadow.mockRejectedValue(
      accountSessionPersonaConflict(
        "CROSS_PERSONA_REVIEW_REQUIRED",
      ),
    );
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const response = await legacyCallback(
      new Request(
        "https://reps.example.com/reps/demo/auth/callback?code=code-1&state=state-1",
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(
      response.cookies.get("delegate_audience_auth_session")?.value,
    ).toBe("signed-auth-session");
    expect(response.cookies.get("delegate_reps_session_v2")).toMatchObject({
      value: "",
      path: "/",
    });
    expect(mocks.revokeAppSession).toHaveBeenCalledWith({
      token: "old-reps-v2-token",
      application: "PUBLIC_REPRESENTATIVES",
      reason: "CROSS_PERSONA_REVIEW_REQUIRED",
      now: expect.any(Date),
    });
    warning.mockRestore();
  });

  it("issues and rotates the platform-scoped Reps v2 cookie after a verified callback in shadow mode", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    configureSuccessfulFixedCallback({
      version: 3,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      publicChat: {
        audienceId: "aud_1",
        sessionToken: "signed-public-chat-session-token",
        expiresAt: "2026-08-05T00:00:00.000Z",
      },
    }, "old-reps-v2-token");

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1",
        {
          headers: {
            host: "reps.example.com",
            "user-agent": "Browser/2.0",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.issueAccountSessionShadow).toHaveBeenCalledWith({
      principal: expect.objectContaining({
        provider: "logto",
        issuer: "https://auth.example.com/oidc",
        subject: "logto-user-1",
        verifiedAt: expect.any(Date),
        metadata: {
          verificationSource: "logto_jwks_callback",
        },
      }),
      persona: {
        kind: "audience",
        audienceIdentityId: "audience-identity-1",
      },
      application: "PUBLIC_REPRESENTATIVES",
      previousToken: "old-reps-v2-token",
      userAgent: "Browser/2.0",
      now: expect.any(Date),
    });
    const appCookie = response.cookies.get("delegate_reps_session_v2");
    expect(appCookie?.value).toBe("new-reps-v2-token");
    expect(appCookie?.path).toBe("/");
    expect(appCookie?.httpOnly).toBe(true);
    expect(appCookie?.sameSite).toBe("lax");
  });

  it("keeps legacy audience login authoritative when cross-persona shadow attachment requires review", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    configureSuccessfulFixedCallback({
      version: 3,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      publicChat: {
        audienceId: "aud_1",
        sessionToken: "signed-public-chat-session-token",
        expiresAt: "2026-08-05T00:00:00.000Z",
      },
    }, "old-reps-v2-token");
    mocks.issueAccountSessionShadow.mockRejectedValue(
      accountSessionPersonaConflict(
        "CROSS_PERSONA_REVIEW_REQUIRED",
      ),
    );
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1",
        {
          headers: {
            host: "reps.example.com",
            "user-agent": "Browser/2.0",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.exchangeLogtoCodeForTokens).toHaveBeenCalledTimes(1);
    expect(
      response.cookies.get("delegate_audience_auth_session")?.value,
    ).toBe("signed-auth-session");
    expect(
      response.cookies.get(getPublicChatCookieName("demo"))?.value,
    ).toBeTruthy();
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.value,
    ).toBe("");
    expect(response.cookies.get("delegate_reps_session_v2")).toMatchObject({
      value: "",
      path: "/",
    });
    expect(mocks.revokeAppSession).toHaveBeenCalledWith({
      token: "old-reps-v2-token",
      application: "PUBLIC_REPRESENTATIVES",
      reason: "CROSS_PERSONA_REVIEW_REQUIRED",
      now: expect.any(Date),
    });
    expect(warning).toHaveBeenCalledWith(
      "Account/AppSession shadow issuance requires cross-persona review.",
      expect.objectContaining({
        event: "account_session_shadow_review_required",
        application: "PUBLIC_REPRESENTATIVES",
        reason: "CROSS_PERSONA_REVIEW_REQUIRED",
      }),
    );
    warning.mockRestore();
  });

  it("still fails closed for non-review AccountSession persona conflicts", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    configureSuccessfulFixedCallback({
      version: 3,
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: pkceCodeVerifier,
      returnTo: "/reps/demo",
      representativeSlug: "demo",
      publicChat: {
        audienceId: "aud_1",
        sessionToken: "signed-public-chat-session-token",
        expiresAt: "2026-08-05T00:00:00.000Z",
      },
    });
    mocks.issueAccountSessionShadow.mockRejectedValue(
      accountSessionPersonaConflict("ACCOUNT_CONFLICT"),
    );

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1",
        { headers: { host: "reps.example.com" } },
      ),
    );

    expect(response.status).toBe(500);
    expect(
      response.cookies.get("delegate_audience_auth_session"),
    ).toBeUndefined();
    expect(mocks.revokeAppSession).not.toHaveBeenCalled();
  });

  it("issues a Reps v2 session only through the explicit local development bypass", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "rep-1" },
    });
    mocks.resolveWebAudienceContact.mockResolvedValue({
      audienceIdentityId: "audience-identity-1",
    });
    mocks.linkAudienceIdentityToAuth.mockResolvedValue({
      id: "audience-identity-1",
    });
    mocks.isLogtoOidcConfigured.mockReturnValue(false);
    const webData = await import("@delegate/web-data");
    vi.mocked(webData.shouldUseDelegateAuthDevLogin).mockReturnValue(true);
    vi.mocked(webData.isDelegateAuthPersistenceUnavailableError)
      .mockReturnValue(false);
    mocks.createDelegateAuthSession.mockReturnValue(
      legacyAudienceSession(),
    );
    mocks.signDelegateAuthSession.mockReturnValue("signed-auth-session");

    const response = await login(
      new Request("https://reps.example.com/reps/demo/auth/login", {
        headers: { host: "reps.example.com" },
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(mocks.issueAccountSessionShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({
          issuer: "https://local-auth.delegate.invalid/oidc",
          subject: "delegate-dev-audience",
          metadata: {
            verificationSource: "explicit_development_bypass",
          },
        }),
        persona: {
          kind: "audience",
          audienceIdentityId: "audience-identity-1",
        },
        application: "PUBLIC_REPRESENTATIVES",
      }),
    );
  });

  it("clears the stale Reps v2 cookie when dev-login review fallback cannot revoke it", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "rep-1" },
    });
    mocks.resolveWebAudienceContact.mockResolvedValue({
      audienceIdentityId: "audience-identity-1",
    });
    mocks.linkAudienceIdentityToAuth.mockResolvedValue({
      id: "audience-identity-1",
    });
    mocks.isLogtoOidcConfigured.mockReturnValue(false);
    const webData = await import("@delegate/web-data");
    vi.mocked(webData.shouldUseDelegateAuthDevLogin).mockReturnValue(true);
    vi.mocked(webData.isDelegateAuthPersistenceUnavailableError)
      .mockReturnValue(false);
    mocks.createDelegateAuthSession.mockReturnValue(
      legacyAudienceSession(),
    );
    mocks.signDelegateAuthSession.mockReturnValue("signed-auth-session");
    mocks.cookieStore.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_reps_session_v2"
          ? { value: "old-reps-v2-token" }
          : undefined,
      ),
    });
    mocks.issueAccountSessionShadow.mockRejectedValue(
      accountSessionPersonaConflict(
        "CROSS_PERSONA_REVIEW_REQUIRED",
      ),
    );
    mocks.revokeAppSession.mockRejectedValue(
      new Error("database unavailable"),
    );
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const response = await login(
      new Request("https://reps.example.com/reps/demo/auth/login", {
        headers: { host: "reps.example.com" },
      }),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    expect(response.cookies.get("delegate_reps_session_v2")).toMatchObject({
      value: "",
      path: "/",
    });
    expect(warning).toHaveBeenCalledWith(
      "Account/AppSession shadow issuance requires cross-persona review.",
      expect.objectContaining({
        previousSessionPresent: true,
        previousSessionRevoked: false,
        previousSessionRevocationFailed: true,
      }),
    );
    warning.mockRestore();
  });

  it.each(["enforce", "contract"])(
    "refuses public login in %s until v2 read authority exists",
    async (mode) => {
      mocks.readAccountSessionMode.mockReturnValue(mode);

      const response = await login(
        new Request("https://reps.example.com/reps/demo/auth/login", {
          headers: { host: "reps.example.com" },
        }),
        { params: Promise.resolve({ slug: "demo" }) },
      );

      expect(response.status).toBe(503);
      expect(mocks.getPublicRepresentativeRuntime).not.toHaveBeenCalled();
    },
  );

  it("refuses an in-flight public callback in enforce mode before token exchange", async () => {
    mocks.readAccountSessionMode.mockReturnValue("enforce");

    const response = await fixedCallback(
      new Request(
        "https://reps.example.com/auth/callback?code=code-1&state=state-1",
        { headers: { host: "reps.example.com" } },
      ),
    );

    expect(response.status).toBe(503);
    expect(mocks.cookieStore).not.toHaveBeenCalled();
    expect(mocks.exchangeLogtoCodeForTokens).not.toHaveBeenCalled();
    expect(mocks.getPublicRepresentativeRuntime).not.toHaveBeenCalled();
  });

  it("rotates the public chat cookie when the audience logs out", async () => {
    const previousState = createPublicChatSessionState({
      now: new Date("2026-07-29T12:00:00.000Z"),
    });
    const chatCookieName = getPublicChatCookieName("demo");
    const response = await logout(
      new Request(
        "https://reps.example.com/reps/demo/auth/logout?returnTo=%2Freps%2Fdemo",
        {
          headers: {
            host: "reps.example.com",
            cookie: `${chatCookieName}=${writePublicChatSessionState({
              representativeSlug: "demo",
              state: previousState,
            })}`,
          },
        },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(response.status).toBe(307);
    const rotatedCookie = response.cookies.get(chatCookieName);
    expect(rotatedCookie?.value).toBeTruthy();
    const rotatedState = readPublicChatSessionState({
      representativeSlug: "demo",
      cookieValue: rotatedCookie?.value,
    });
    expect(rotatedState.audienceId).not.toBe(previousState.audienceId);
    expect(rotatedState.sessionToken).not.toBe(previousState.sessionToken);
    expect(
      response.cookies.get("delegate_audience_auth_session")?.value,
    ).toBe("");
    expect(response.cookies.get("delegate_reps_session_v2")?.value).toBe(
      "",
    );
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.value,
    ).toBe("");
    expect(
      response.cookies.get("delegate_representatives_auth_state_v3")
        ?.path,
    ).toBe("/auth/callback");
    expect(mocks.revokeAppSession).not.toHaveBeenCalled();
    expect(mocks.cookieStore).not.toHaveBeenCalled();
  });

  it("clears a Reps v2 cookie even when database revocation is unavailable", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.cookieStore.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_reps_session_v2"
          ? { value: "old-reps-v2-token" }
          : undefined,
      ),
    });
    mocks.revokeAppSession.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await logout(
      new Request(
        "https://reps.example.com/reps/demo/auth/logout?returnTo=%2Freps%2Fdemo",
        { headers: { host: "reps.example.com" } },
      ),
      { params: Promise.resolve({ slug: "demo" }) },
    );

    expect(mocks.revokeAppSession).toHaveBeenCalledWith({
      token: "old-reps-v2-token",
      application: "PUBLIC_REPRESENTATIVES",
      reason: "USER_LOGOUT",
    });
    expect(response.status).toBe(307);
    expect(response.cookies.get("delegate_reps_session_v2")?.value).toBe(
      "",
    );
    expect(response.cookies.get("delegate_reps_session_v2")?.path).toBe(
      "/",
    );
  });
});

function configureSuccessfulFixedCallback(
  authState: Record<string, unknown>,
  previousAppSessionToken?: string,
) {
  configureSuccessfulPublicCallback(
    authState,
    "delegate_representatives_auth_state_v3",
    previousAppSessionToken,
  );
}

function configureSuccessfulLegacyCallback(
  authState: Record<string, unknown>,
  previousAppSessionToken?: string,
) {
  configureSuccessfulPublicCallback(
    authState,
    "delegate_audience_auth_state",
    previousAppSessionToken,
  );
}

function configureSuccessfulPublicCallback(
  authState: Record<string, unknown>,
  authStateCookieName: string,
  previousAppSessionToken?: string,
) {
  mocks.getPublicRepresentativeRuntime.mockResolvedValue({
    status: "available",
    setup: { id: "rep-1" },
  });
  mocks.cookieStore.mockResolvedValue({
    get: vi.fn((name: string) => {
      if (name === authStateCookieName) {
        return { value: "signed-auth-state" };
      }
      if (
        name === "delegate_reps_session_v2"
        && previousAppSessionToken
      ) {
        return { value: previousAppSessionToken };
      }
      return undefined;
    }),
  });
  mocks.verifyDelegateAuthState.mockReturnValue(authState);
  mocks.exchangeLogtoCodeForTokens.mockResolvedValue({
    idToken: "id-token",
  });
  mocks.buildVerifiedExternalAuthProfileFromLogtoIdToken.mockResolvedValue({
    provider: "logto",
    issuer: "https://auth.example.com/oidc",
    subject: "logto-user-1",
    email: "user@example.com",
  });
  mocks.resolveWebAudienceContact.mockResolvedValue({
    audienceIdentityId: "audience-identity-1",
  });
  mocks.linkAudienceIdentityToAuth.mockResolvedValue({
    id: "audience-identity-1",
  });
  mocks.createDelegateAuthSession.mockReturnValue({
    ...legacyAudienceSession(),
    subject: "logto-user-1",
  });
  mocks.signDelegateAuthSession.mockReturnValue("signed-auth-session");
}

function issuedShadowSession(token: string) {
  return {
    token,
    session: {
      issuedAt: new Date("2026-07-29T08:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-08-28T08:00:00.000Z"),
    },
  };
}

function accountSessionPersonaConflict(reason: string) {
  return Object.assign(
    new Error(`Cannot attach audience persona to Account (${reason}).`),
    {
      code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
      reason,
    },
  );
}

function legacyAudienceSession() {
  return {
    version: 1,
    actor: "audience",
    provider: "logto",
    issuer: "https://auth.example.com/oidc",
    subject: "delegate-dev-audience",
    audienceIdentityId: "audience-identity-1",
    audienceId: "aud_1",
    issuedAt: 1_783_166_400,
    expiresAt: 1_785_758_400,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
