import { describe, expect, it } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  DASHBOARD_LEGACY_AUTH_COOKIE_NAME,
  buildCreatorCanonicalAuthRequestUrl,
  buildCreatorLoginPath,
  buildCreatorLoginPathForReturnTo,
  buildCreatorLogoutPath,
  buildCreatorRedirectUrl,
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
    expect(isCreatorDashboardPath("/health")).toBe(false);
    expect(isCreatorDashboardPath("/api/amn/recharges")).toBe(false);
    expect(isCreatorDashboardPath("/auth/login")).toBe(false);
  });

  it("builds a safe creator login path", () => {
    expect(buildCreatorLoginPath("/dashboard", "?view=representatives")).toBe(
      "/auth/login?actor=owner&returnTo=%2Fdashboard%3Fview%3Drepresentatives",
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

  it("uses the configured public dashboard origin for auth redirects", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_DASHBOARD_URL: "http://localhost:3001",
    };
    expect(
      buildCreatorRedirectUrl(
        "/dashboard?view=overview",
        "http://0.0.0.0:3001/auth/login",
        env,
      ).toString(),
    ).toBe("http://localhost:3001/dashboard?view=overview");
  });

  it("only falls back to a loopback request origin outside production", () => {
    expect(
      buildCreatorRedirectUrl(
        "/dashboard",
        "http://127.0.0.1:3001/auth/login",
        { NODE_ENV: "development" },
      ).toString(),
    ).toBe("http://127.0.0.1:3001/dashboard");
    expect(
      buildCreatorRedirectUrl(
        "/dashboard",
        "http://[::1]:3001/auth/login",
        { NODE_ENV: "test" },
      ).toString(),
    ).toBe("http://[::1]:3001/dashboard");
    expect(() =>
      buildCreatorRedirectUrl(
        "/dashboard",
        "https://dashboard.example.com/auth/login",
        { NODE_ENV: "development" },
      ),
    ).toThrow(/NEXT_PUBLIC_DASHBOARD_URL is required/);
    expect(() =>
      buildCreatorRedirectUrl(
        "/dashboard",
        "http://localhost:3001/auth/login",
        { NODE_ENV: "production" },
      ),
    ).toThrow("NEXT_PUBLIC_DASHBOARD_URL is required in production.");
  });

  it("keeps every creator redirect on the configured origin", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
    };
    const unsafeTargets = [
      "https://evil.example/phish",
      "//evil.example/phish",
      "/\\evil.example/phish",
      "/%5Cevil.example/phish",
    ];

    for (const target of unsafeTargets) {
      expect(
        buildCreatorRedirectUrl(
          target,
          "https://dashboard.example.com/auth/logout",
          env,
        ).toString(),
      ).toBe("https://dashboard.example.com/dashboard");
      expect(
        buildCreatorRedirectUrl(
          target,
          "https://dashboard.example.com/auth/logout",
          env,
          "/",
        ).toString(),
      ).toBe("https://dashboard.example.com/");
    }
  });

  it("canonicalizes auth requests before a route can write host-bound cookies", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
    };
    const aliasRequest = new Request(
      "http://0.0.0.0:3001/auth/login?returnTo=%2Fdashboard",
      { headers: { host: "preview.example.com" } },
    );
    expect(buildCreatorCanonicalAuthRequestUrl(aliasRequest, env)?.toString()).toBe(
      "https://dashboard.example.com/auth/login?returnTo=%2Fdashboard",
    );

    const proxiedCanonicalRequest = new Request(
      "http://0.0.0.0:3001/auth/callback?code=code&state=state",
      {
        headers: {
          host: "dashboard.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    expect(buildCreatorCanonicalAuthRequestUrl(proxiedCanonicalRequest, env)).toBeNull();
    const canonicalRequestWithDefaultPort = new Request(
      "http://0.0.0.0:3001/auth/logout",
      {
        headers: {
          host: "dashboard.example.com:443",
          "x-forwarded-proto": "https",
        },
      },
    );
    expect(
      buildCreatorCanonicalAuthRequestUrl(canonicalRequestWithDefaultPort, env),
    ).toBeNull();

    expect(() =>
      buildCreatorCanonicalAuthRequestUrl(
        new Request("https://dashboard.example.com/auth/login"),
        { NODE_ENV: "production" },
      ),
    ).toThrow("NEXT_PUBLIC_DASHBOARD_URL is required in production.");
  });

  it("canonicalizes the request scheme before writing auth cookies", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
    };
    const directHttpRequest = new Request(
      "http://dashboard.example.com/auth/login?returnTo=%2Fdashboard",
      { headers: { host: "dashboard.example.com" } },
    );
    expect(
      buildCreatorCanonicalAuthRequestUrl(directHttpRequest, env)?.toString(),
    ).toBe(
      "https://dashboard.example.com/auth/login?returnTo=%2Fdashboard",
    );

    const tlsProxyRequest = new Request(
      "http://dashboard-internal:3001/auth/login?returnTo=%2Fdashboard",
      {
        headers: {
          host: "dashboard.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    expect(buildCreatorCanonicalAuthRequestUrl(tlsProxyRequest, env)).toBeNull();
  });

  it("fails closed for malformed or multi-value forwarded protocols", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
    };

    for (const forwardedProtocol of ["ftp", "https,http", "https, http", ""]) {
      const request = new Request(
        "http://dashboard-internal:3001/auth/callback?code=code&state=state",
        {
          headers: {
            host: "dashboard.example.com",
            "x-forwarded-proto": forwardedProtocol,
          },
        },
      );
      expect(
        buildCreatorCanonicalAuthRequestUrl(request, env)?.toString(),
      ).toBe(
        "https://dashboard.example.com/auth/callback?code=code&state=state",
      );
    }
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
