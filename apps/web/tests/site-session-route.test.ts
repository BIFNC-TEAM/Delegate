import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOwnerAuthSession: vi.fn(),
  getOwnerDashboardPreferences: vi.fn(),
}));

vi.mock("../app/auth/owner-session", () => ({
  getOwnerAuthSession: mocks.getOwnerAuthSession,
}));

vi.mock("@delegate/web-data/owner-settings", () => ({
  getOwnerDashboardPreferences: mocks.getOwnerDashboardPreferences,
}));

import {
  GET as getSiteSession,
  OPTIONS as inspectSiteSession,
} from "../app/api/auth/site-session/route";

describe("website account session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.example.com");
    mocks.getOwnerAuthSession.mockResolvedValue(null);
    mocks.getOwnerDashboardPreferences.mockResolvedValue(null);
  });

  it("returns the minimum account summary to the configured website origin", async () => {
    mocks.getOwnerAuthSession.mockResolvedValue({
      actor: "owner",
      ownerId: "owner-1",
      email: "creator@example.com",
    });
    mocks.getOwnerDashboardPreferences.mockResolvedValue({
      displayName: "Lin Creator",
      preferredLocale: "zh",
    });

    const response = await getSiteSession(requestFrom("https://www.example.com"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      account: {
        displayName: "Lin Creator",
        email: "creator@example.com",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://www.example.com",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("fails closed as logged out without exposing an account", async () => {
    const response = await getSiteSession(requestFrom("https://www.example.com"));

    expect(await response.json()).toEqual({ authenticated: false });
    expect(mocks.getOwnerDashboardPreferences).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured cross-origin website before reading session state", async () => {
    const response = await getSiteSession(requestFrom("https://attacker.example"));

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.getOwnerAuthSession).not.toHaveBeenCalled();
  });

  it("supports credentialed CORS preflight for the configured website only", () => {
    const allowed = inspectSiteSession(requestFrom("https://www.example.com", "OPTIONS"));
    const rejected = inspectSiteSession(requestFrom("https://attacker.example", "OPTIONS"));

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(rejected.status).toBe(403);
  });
});

function requestFrom(origin: string, method = "GET") {
  return new Request("https://dashboard.example.com/api/auth/site-session", {
    method,
    headers: { origin },
  });
}
