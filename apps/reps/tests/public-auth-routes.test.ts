import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieStore: vi.fn(),
  getPublicRepresentativeRuntime: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookieStore,
}));

vi.mock("@delegate/web-data", () => ({
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE:
    "delegate_audience_auth_session",
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE:
    "delegate_audience_auth_state",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  LEGACY_DELEGATE_AUTH_STATE_COOKIE: "delegate_auth_state",
  buildDelegateDevAuthProfile: vi.fn(),
  buildLogtoAuthorizeUrl: vi.fn(),
  buildVerifiedExternalAuthProfileFromLogtoIdToken: vi.fn(),
  createDelegateAuthSession: vi.fn(),
  createDelegateAuthState: vi.fn(),
  exchangeLogtoCodeForTokens: vi.fn(),
  generateAuthStateToken: vi.fn(),
  getPublicRepresentativeRuntime:
    mocks.getPublicRepresentativeRuntime,
  isDelegateAuthPersistenceUnavailableError: vi.fn(),
  isLogtoOidcConfigured: vi.fn(),
  linkAudienceIdentityToAuth: vi.fn(),
  readDelegateAuthSessionSecret: vi.fn(),
  readLogtoOidcConfig: vi.fn(),
  resolveWebAudienceContact: vi.fn(),
  shouldUseDelegateAuthDevLogin: vi.fn(),
  signDelegateAuthSession: vi.fn(),
  signDelegateAuthState: vi.fn(),
  verifyDelegateAuthState: vi.fn(),
}));

import { GET as callback } from "../app/reps/[slug]/auth/callback/route";
import { GET as login } from "../app/reps/[slug]/auth/login/route";
import { GET as logout } from "../app/reps/[slug]/auth/logout/route";

const originalNodeEnv = process.env.NODE_ENV;
const originalRepresentativeUrl =
  process.env.NEXT_PUBLIC_REPRESENTATIVE_URL;
const authRouteCases = [
  {
    name: "login",
    handler: login,
    path:
      "/reps/demo/auth/login?returnTo=%2Freps%2Fdemo%3Flang%3Dzh",
  },
  {
    name: "callback",
    handler: callback,
    path: "/reps/demo/auth/callback?code=code-1&state=state-1",
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
  });

  afterAll(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv(
      "NEXT_PUBLIC_REPRESENTATIVE_URL",
      originalRepresentativeUrl,
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
});

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
