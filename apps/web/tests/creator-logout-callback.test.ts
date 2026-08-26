import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildCreatorCanonicalAuthRequestUrl: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

vi.mock("@delegate/web-data", () => ({
  DELEGATE_DASHBOARD_APP_SESSION_COOKIE: "delegate_dashboard_session_v2",
  DELEGATE_OWNER_AUTH_SESSION_COOKIE: "delegate_owner_auth_session",
  DELEGATE_OWNER_AUTH_STATE_COOKIE: "delegate_owner_auth_state",
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE: "delegate_auth_session",
  LEGACY_DELEGATE_AUTH_STATE_COOKIE: "delegate_auth_state",
}));

vi.mock("../auth-guard", () => ({
  buildCreatorCanonicalAuthRequestUrl: mocks.buildCreatorCanonicalAuthRequestUrl,
  buildCreatorRedirectUrl: vi.fn((pathname: string) =>
    new URL(pathname, "https://dashboard.example.com"),
  ),
  sanitizeCreatorReturnTo: vi.fn((value: string | null) =>
    value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard",
  ),
}));

import { GET as completeLogout } from "../app/auth/logout/callback/route";

describe("creator global logout callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.example.com");
    mocks.buildCreatorCanonicalAuthRequestUrl.mockReturnValue(null);
  });

  it("returns a website logout to the allowlisted relative website path", async () => {
    mockLogoutState({ version: 1, kind: "site", returnTo: "/?lang=zh" });

    const response = await completeLogout(
      new Request("https://dashboard.example.com/auth/logout/callback"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://www.example.com/?lang=zh");
    expect(response.cookies.get("delegate_dashboard_session_v2")?.value).toBe("");
    const returnCookie = response.cookies.get("delegate_logout_return_v1");
    expect(returnCookie?.value).toBe("");
    expect(returnCookie?.path).toBe("/auth/logout/callback");
  });

  it("returns Dashboard logout to the signed-out result page", async () => {
    mockLogoutState({
      version: 1,
      kind: "dashboard",
      returnTo: "/dashboard?view=overview",
    });

    const response = await completeLogout(
      new Request("https://dashboard.example.com/auth/logout/callback"),
    );

    expect(response.headers.get("location")).toBe(
      "https://dashboard.example.com/auth/error?reason=signed_out&returnTo=%2Fdashboard%3Fview%3Doverview",
    );
  });

  it("fails closed when the return cookie is missing or points off-site", async () => {
    for (const state of [
      undefined,
      { version: 1, kind: "site", returnTo: "//attacker.example" },
    ]) {
      mockLogoutState(state);
      const response = await completeLogout(
        new Request("https://dashboard.example.com/auth/logout/callback"),
      );
      expect(response.headers.get("location")).not.toContain("attacker.example");
    }
  });
});

function mockLogoutState(state: object | undefined) {
  const value = state
    ? Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
    : undefined;
  mocks.cookies.mockResolvedValue({
    get: vi.fn((name: string) =>
      name === "delegate_logout_return_v1" && value ? { value } : undefined,
    ),
  });
}
