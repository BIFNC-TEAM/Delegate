import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildCreatorCanonicalAuthRequestUrl: vi.fn(),
  cookies: vi.fn(),
  readAccountSessionMode: vi.fn(),
  readLogtoOidcConfig: vi.fn(),
  revokeAppSession: vi.fn(),
  usesAccountSessionV2: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@delegate/web-data", () => ({
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE:
    "delegate_dashboard_session_v2",
  DELEGATE_OWNER_AUTH_SESSION_COOKIE: "delegate_owner_auth_session",
  DELEGATE_OWNER_AUTH_STATE_COOKIE: "delegate_owner_auth_state",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  LEGACY_DELEGATE_AUTH_STATE_COOKIE: "delegate_auth_state",
  readAccountSessionMode: mocks.readAccountSessionMode,
  readLogtoOidcConfig: mocks.readLogtoOidcConfig,
  revokeAppSession: mocks.revokeAppSession,
  usesAccountSessionV2: mocks.usesAccountSessionV2,
}));

vi.mock("../auth-guard", () => ({
  buildCreatorCanonicalAuthRequestUrl:
    mocks.buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl: vi.fn((pathname: string) =>
    new URL(pathname, "https://dashboard.example.com"),
  ),
  sanitizeCreatorReturnTo: vi.fn(
    (pathname: string | null | undefined) => pathname ?? "/dashboard",
  ),
}));

import {
  GET as inspectLogout,
  HEAD as inspectLogoutHead,
  POST as logout,
} from "../app/auth/logout/route";

describe("Dashboard v2 shadow logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.example.com");
    mocks.buildCreatorCanonicalAuthRequestUrl.mockReturnValue(null);
    mocks.readAccountSessionMode.mockReturnValue("legacy");
    mocks.readLogtoOidcConfig.mockReturnValue({
      endpoint: "https://auth.example.com",
      appId: "dashboard-app",
      appSecret: "secret",
      redirectUri: "https://dashboard.example.com/auth/callback",
    });
    mocks.usesAccountSessionV2.mockImplementation(
      (mode: string) =>
        mode === "shadow" || mode === "enforce" || mode === "contract",
    );
    mocks.cookies.mockResolvedValue({
      get: vi.fn(() => undefined),
    });
    mocks.revokeAppSession.mockResolvedValue(true);
  });

  it("keeps GET and HEAD side-effect free", async () => {
    for (const response of [
      await inspectLogout(),
      await inspectLogoutHead(),
    ]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.revokeAppSession).not.toHaveBeenCalled();
  });

  it("revokes the browser-held Dashboard token by application and deletes every local cookie on POST", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "delegate_dashboard_session_v2"
          ? { value: "old-dashboard-v2-token" }
          : undefined,
      ),
    });

    const response = await logout(
      new Request(
        "https://dashboard.example.com/auth/logout?returnTo=%2Fdashboard",
        {
          method: "POST",
          headers: { origin: "https://dashboard.example.com" },
        },
      ),
    );

    expect(mocks.revokeAppSession).toHaveBeenCalledWith({
      token: "old-dashboard-v2-token",
      application: "DASHBOARD",
      reason: "USER_LOGOUT",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auth.example.com/oidc/session/end?client_id=dashboard-app&post_logout_redirect_uri=https%3A%2F%2Fdashboard.example.com%2Fauth%2Flogout%2Fcallback",
    );
    const appCookie = response.cookies.get(
      "delegate_dashboard_session_v2",
    );
    expect(appCookie?.value).toBe("");
    expect(appCookie?.path).toBe("/");
    expect(appCookie?.httpOnly).toBe(true);
    expect(appCookie?.sameSite).toBe("lax");
  });

  it("still clears the browser cookie when revocation storage is unavailable", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.cookies.mockResolvedValue({
      get: vi.fn(() => ({ value: "old-dashboard-v2-token" })),
    });
    mocks.revokeAppSession.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await logout(
      new Request("https://dashboard.example.com/auth/logout", {
        method: "POST",
        headers: { origin: "https://dashboard.example.com" },
      }),
    );

    expect(response.status).toBe(303);
    expect(
      response.cookies.get("delegate_dashboard_session_v2")?.value,
    ).toBe("");
  });

  it("does not query AppSession storage when no v2 cookie exists", async () => {
    const response = await logout(
      new Request("https://dashboard.example.com/auth/logout", {
        method: "POST",
        headers: { origin: "https://dashboard.example.com" },
      }),
    );

    expect(response.status).toBe(303);
    expect(mocks.revokeAppSession).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(
      response.cookies.get("delegate_dashboard_session_v2")?.value,
    ).toBe("");
  });

  it("rejects a cross-origin POST before reading or revoking session state", async () => {
    const response = await logout(
      new Request("https://dashboard.example.com/auth/logout", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.revokeAppSession).not.toHaveBeenCalled();
  });

  it("accepts the configured website POST and returns to a same-origin website path", async () => {
    mocks.readAccountSessionMode.mockReturnValue("shadow");
    mocks.cookies.mockResolvedValue({
      get: vi.fn(() => ({ value: "website-dashboard-token" })),
    });

    const response = await logout(
      new Request(
        "https://dashboard.example.com/auth/logout?siteReturnTo=%2F%3Flang%3Dzh",
        {
          method: "POST",
          headers: { origin: "https://www.example.com" },
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auth.example.com/oidc/session/end?client_id=dashboard-app&post_logout_redirect_uri=https%3A%2F%2Fdashboard.example.com%2Fauth%2Flogout%2Fcallback",
    );
    expect(decodeLogoutReturnCookie(response)).toEqual({
      version: 1,
      kind: "site",
      returnTo: "/?lang=zh",
    });
    expect(mocks.revokeAppSession).toHaveBeenCalledWith({
      token: "website-dashboard-token",
      application: "DASHBOARD",
      reason: "USER_LOGOUT",
    });
  });

  it("does not allow the website return parameter to become an open redirect", async () => {
    const response = await logout(
      new Request(
        "https://dashboard.example.com/auth/logout?siteReturnTo=%2F%2Fattacker.example",
        {
          method: "POST",
          headers: { origin: "https://www.example.com" },
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auth.example.com/oidc/session/end?client_id=dashboard-app&post_logout_redirect_uri=https%3A%2F%2Fdashboard.example.com%2Fauth%2Flogout%2Fcallback",
    );
    expect(decodeLogoutReturnCookie(response)).toEqual({
      version: 1,
      kind: "dashboard",
      returnTo: "/dashboard",
    });
  });

  it("renders both Dashboard logout controls as POST forms and exposes a stable signed-out page", () => {
    const framework = readFileSync(
      new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
      "utf8",
    );
    const settings = readFileSync(
      new URL("../app/dashboard/dashboard-settings.tsx", import.meta.url),
      "utf8",
    );
    const authResultPage = readFileSync(
      new URL("../app/auth/error/page.tsx", import.meta.url),
      "utf8",
    );

    expect(framework).toContain(
      '<form action={props.logoutHref} method="post">',
    );
    expect(framework).not.toContain(
      '<a aria-label={t.signOut} href={props.logoutHref}',
    );
    expect(settings).toContain('<form action={logoutHref} method="post">');
    expect(settings).not.toContain(
      '<a className="dashboard-v2-button-secondary" href={logoutHref}>',
    );
    expect(authResultPage).toContain('"signed_out"');
    expect(authResultPage).toContain("已退出当前 Delegate 会话");
    expect(authResultPage).toContain("Logto 中央会话");
    expect(authResultPage).toContain("<a href={loginHref}>");
    expect(authResultPage).not.toContain('import Link from "next/link"');
  });
});

function decodeLogoutReturnCookie(response: Awaited<ReturnType<typeof logout>>) {
  const value = response.cookies.get("delegate_logout_return_v1")?.value;
  expect(value).toBeTruthy();
  return JSON.parse(Buffer.from(value!, "base64url").toString("utf8"));
}
