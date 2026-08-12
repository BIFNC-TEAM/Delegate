import { describe, expect, it } from "vitest";

import {
  buildPublicAudienceLoginHref,
  buildPublicAudienceLogoutHref,
  buildPublicAudienceReturnTo,
  buildRepresentativeCanonicalAuthRequestUrl,
  buildRepresentativeAuthRedirectUrl,
  sanitizePublicAudienceReturnTo,
} from "../app/reps/[slug]/public-auth";

describe("public representative auth links", () => {
  it("builds login and logout links with localized representative return paths", () => {
    expect(buildPublicAudienceReturnTo("lin-founder-rep", "zh")).toBe(
      "/reps/lin-founder-rep?lang=zh#chat",
    );
    expect(buildPublicAudienceLoginHref("lin-founder-rep", "zh")).toBe(
      "/reps/lin-founder-rep/auth/login?returnTo=%2Freps%2Flin-founder-rep%3Flang%3Dzh%23chat",
    );
    expect(
      buildPublicAudienceLoginHref(
        "lin-founder-rep",
        "zh",
        "telegram-recharge",
      ),
    ).toBe(
      "/reps/lin-founder-rep/auth/login?returnTo=%2Freps%2Flin-founder-rep%3Fsource%3Dtelegram%26lang%3Dzh",
    );
    expect(buildPublicAudienceLogoutHref("lin-founder-rep", "en")).toBe(
      "/reps/lin-founder-rep/auth/logout?returnTo=%2Freps%2Flin-founder-rep%3Flang%3Den",
    );
  });

  it("keeps representative auth redirects scoped to the current public page", () => {
    expect(
      sanitizePublicAudienceReturnTo("/reps/lin-founder-rep?lang=zh#chat", "lin-founder-rep"),
    ).toBe("/reps/lin-founder-rep?lang=zh#chat");
    expect(sanitizePublicAudienceReturnTo("/reps/other-rep", "lin-founder-rep")).toBe(
      "/reps/lin-founder-rep#chat",
    );
    expect(sanitizePublicAudienceReturnTo("https://evil.example.com", "lin-founder-rep")).toBe(
      "/reps/lin-founder-rep#chat",
    );
    for (const unsafeReturnTo of [
      "//evil.example.com/reps/lin-founder-rep",
      "/\\evil.example.com/reps/lin-founder-rep",
      "/%5Cevil.example.com/reps/lin-founder-rep",
    ]) {
      expect(
        sanitizePublicAudienceReturnTo(
          unsafeReturnTo,
          "lin-founder-rep",
        ),
      ).toBe("/reps/lin-founder-rep#chat");
    }
  });

  it("uses the configured public representative origin for auth redirects", () => {
    const request = new Request("http://0.0.0.0:3002/reps/lin-founder-rep/auth/login");
    const env = {
      NEXT_PUBLIC_REPRESENTATIVE_URL: "http://localhost:3002",
    };

    expect(
      buildRepresentativeAuthRedirectUrl(
        request,
        "/reps/lin-founder-rep?lang=zh#chat",
        env,
      ).toString(),
    ).toBe("http://localhost:3002/reps/lin-founder-rep?lang=zh#chat");
  });

  it("fails closed without a configured production origin", () => {
    const request = new Request(
      "https://reps.example.com/reps/demo/auth/login",
    );

    expect(() =>
      buildRepresentativeAuthRedirectUrl(
        request,
        "/reps/demo/auth/callback",
        {
          NODE_ENV: "production",
        },
      ),
    ).toThrow("NEXT_PUBLIC_REPRESENTATIVE_URL is required in production.");
    expect(() =>
      buildRepresentativeCanonicalAuthRequestUrl(request, {
        NODE_ENV: "production",
      }),
    ).toThrow("NEXT_PUBLIC_REPRESENTATIVE_URL is required in production.");
  });

  it("allows an unconfigured origin only for matching development loopback requests", () => {
    expect(
      buildRepresentativeAuthRedirectUrl(
        new Request("http://127.0.0.1:3002/reps/demo/auth/login"),
        "/reps/demo/auth/callback",
        { NODE_ENV: "development" },
      ).toString(),
    ).toBe("http://127.0.0.1:3002/reps/demo/auth/callback");
    expect(
      buildRepresentativeAuthRedirectUrl(
        new Request("http://[::1]:3002/reps/demo/auth/login"),
        "/reps/demo/auth/callback",
        { NODE_ENV: "test" },
      ).toString(),
    ).toBe("http://[::1]:3002/reps/demo/auth/callback");

    expect(() =>
      buildRepresentativeAuthRedirectUrl(
        new Request("https://reps.example.com/reps/demo/auth/login"),
        "/reps/demo/auth/callback",
        { NODE_ENV: "development" },
      ),
    ).toThrow(/development request uses a loopback origin/);
    expect(() =>
      buildRepresentativeAuthRedirectUrl(
        new Request("http://127.0.0.1:3002/reps/demo/auth/login", {
          headers: { host: "reps.example.com" },
        }),
        "/reps/demo/auth/callback",
        { NODE_ENV: "development" },
      ),
    ).toThrow(/development request uses a loopback origin/);
  });

  it("keeps every redirect on the canonical origin", () => {
    const request = new Request(
      "https://reps.example.com/reps/demo/auth/callback",
    );
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
    };

    for (const unsafeTarget of [
      "https://evil.example.com/steal",
      "//evil.example.com/steal",
      "/\\evil.example.com/steal",
      "/%5Cevil.example.com/steal",
    ]) {
      expect(
        buildRepresentativeAuthRedirectUrl(
          request,
          unsafeTarget,
          env,
        ).toString(),
      ).toBe("https://reps.example.com/");
    }
  });

  it("canonicalizes alias and direct HTTP auth requests before cookies are written", () => {
    const env = {
      NODE_ENV: "production",
      NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
    };
    const aliasRequest = new Request(
      "http://127.0.0.1:3002/reps/demo/auth/login?returnTo=%2Freps%2Fdemo",
      {
        headers: {
          host: "alias.example",
          "x-forwarded-host": "reps.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    const canonicalProxyRequest = new Request(
      "http://127.0.0.1:3002/reps/demo/auth/login",
      {
        headers: {
          host: "reps.example.com",
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    const directHttpRequest = new Request(
      "http://reps.example.com/reps/demo/auth/login",
      {
        headers: {
          host: "reps.example.com",
          "x-forwarded-host": "reps.example.com",
        },
      },
    );
    const malformedHostRequest = new Request(
      "http://127.0.0.1:3002/reps/demo/auth/login",
      {
        headers: {
          host: "evil.example@reps.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    const doubleSlashPathRequest = new Request(
      "http://127.0.0.1:3002//evil.example/steal",
      {
        headers: {
          host: "alias.example",
          "x-forwarded-proto": "https",
        },
      },
    );

    expect(
      buildRepresentativeCanonicalAuthRequestUrl(
        aliasRequest,
        env,
      )?.toString(),
    ).toBe(
      "https://reps.example.com/reps/demo/auth/login?returnTo=%2Freps%2Fdemo",
    );
    expect(
      buildRepresentativeCanonicalAuthRequestUrl(
        canonicalProxyRequest,
        env,
      ),
    ).toBeNull();
    expect(
      buildRepresentativeCanonicalAuthRequestUrl(
        directHttpRequest,
        env,
      )?.toString(),
    ).toBe("https://reps.example.com/reps/demo/auth/login");
    expect(
      buildRepresentativeCanonicalAuthRequestUrl(
        malformedHostRequest,
        env,
      )?.toString(),
    ).toBe("https://reps.example.com/reps/demo/auth/login");
    expect(
      buildRepresentativeCanonicalAuthRequestUrl(
        doubleSlashPathRequest,
        env,
      )?.toString(),
    ).toBe("https://reps.example.com/");
  });
});
