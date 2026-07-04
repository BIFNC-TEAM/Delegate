import { describe, expect, it } from "vitest";

import {
  buildCreatorLoginPath,
  isCreatorDashboardPath,
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
    ).toBe(false);
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
    expect(sanitizeCreatorReturnTo("https://evil.example.com/phish")).toBe("/dashboard");
    expect(sanitizeCreatorReturnTo("//evil.example.com/phish")).toBe("/dashboard");
  });
});
