import { describe, expect, it } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  DASHBOARD_LEGACY_AUTH_COOKIE_NAME,
  buildCreatorLoginPath,
  buildCreatorLoginPathForReturnTo,
  buildCreatorLogoutPath,
  isCreatorDashboardPath,
  resolveCreatorAccountLabel,
  sanitizeCreatorReturnTo,
  shouldRequireCreatorDashboardAuth,
} from "../auth-guard";

describe("creator dashboard auth guard", () => {
  it("requires dashboard auth in production or explicit required mode", () => {
    expect(shouldRequireCreatorDashboardAuth({ NODE_ENV: "development" })).toBe(false);
    expect(shouldRequireCreatorDashboardAuth({ NODE_ENV: "production" })).toBe(true);
    expect(
      shouldRequireCreatorDashboardAuth({
        NODE_ENV: "production",
        DELEGATE_DASHBOARD_AUTH_MODE: "optional",
      }),
    ).toBe(true);
    expect(
      shouldRequireCreatorDashboardAuth({
        NODE_ENV: "development",
        DELEGATE_DASHBOARD_AUTH_MODE: "required",
      }),
    ).toBe(true);
  });

  it("matches dashboard pages and dashboard APIs only", () => {
    expect(isCreatorDashboardPath("/dashboard")).toBe(true);
    expect(isCreatorDashboardPath("/dashboard/settings")).toBe(true);
    expect(isCreatorDashboardPath("/api/dashboard/representatives")).toBe(true);
    expect(isCreatorDashboardPath("/api/amn/recharges")).toBe(false);
    expect(isCreatorDashboardPath("/auth/login")).toBe(false);
  });

  it("builds a safe creator login path", () => {
    expect(buildCreatorLoginPath("/dashboard", "?view=training")).toBe(
      "/auth/login?actor=owner&returnTo=%2Fdashboard%3Fview%3Dtraining",
    );
    expect(buildCreatorLoginPathForReturnTo("/dashboard?view=overview&lang=zh")).toBe(
      "/auth/login?actor=owner&returnTo=%2Fdashboard%3Fview%3Doverview%26lang%3Dzh",
    );
    expect(sanitizeCreatorReturnTo("https://evil.example.com/phish")).toBe("/dashboard");
    expect(sanitizeCreatorReturnTo("//evil.example.com/phish")).toBe("/dashboard");
    expect(sanitizeCreatorReturnTo("/api/dashboard/representatives")).toBe("/dashboard");
    expect(sanitizeCreatorReturnTo("/auth/logout")).toBe("/dashboard");
    expect(sanitizeCreatorReturnTo("/dashboard/settings#profile")).toBe(
      "/dashboard/settings#profile",
    );
  });

  it("builds a safe creator logout path", () => {
    expect(buildCreatorLogoutPath("/dashboard?view=overview&lang=en")).toBe(
      "/auth/logout?returnTo=%2Fdashboard%3Fview%3Doverview%26lang%3Den",
    );
    expect(buildCreatorLogoutPath("https://evil.example.com/phish")).toBe(
      "/auth/logout?returnTo=%2Fdashboard",
    );
  });

  it("uses the creator email as the account label when available", () => {
    expect(resolveCreatorAccountLabel({ email: " creator@example.com " }, "Signed in")).toBe(
      "creator@example.com",
    );
    expect(resolveCreatorAccountLabel({ email: null }, "Signed in")).toBe("Signed in");
    expect(resolveCreatorAccountLabel(null, "Signed in")).toBe("Signed in");
  });

  it("uses an owner-specific cookie while accepting the legacy name during migration", () => {
    expect(DASHBOARD_AUTH_COOKIE_NAME).toBe("delegate_owner_auth_session");
    expect(DASHBOARD_LEGACY_AUTH_COOKIE_NAME).toBe("delegate_auth_session");
  });
});
