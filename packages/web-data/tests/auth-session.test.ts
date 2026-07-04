import { describe, expect, it } from "vitest";

import {
  buildExternalAuthProfileFromLogtoIdToken,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateAuthState,
  decodeJwtPayload,
  exchangeLogtoCodeForTokens,
  readDelegateAuthSessionSecret,
  readLogtoOidcConfig,
  signDelegateAuthSession,
  signDelegateAuthState,
  verifyDelegateAuthState,
  verifyDelegateAuthSession,
} from "../src/auth-session";

describe("Logto OIDC helpers", () => {
  it("builds a Logto authorize URL with standard OIDC parameters", () => {
    const url = new URL(
      buildLogtoAuthorizeUrl(
        {
          endpoint: "https://auth.example.com/",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
          scopes: ["openid", "profile", "email"],
        },
        {
          state: "state-1",
          nonce: "nonce-1",
        },
      ),
    );

    expect(url.origin + url.pathname).toBe("https://auth.example.com/oidc/auth");
    expect(url.searchParams.get("client_id")).toBe("app-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://delegate.example.com/auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
  });

  it("exchanges an authorization code against the Logto token endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tokens = await exchangeLogtoCodeForTokens(
      {
        endpoint: "https://auth.example.com",
        appId: "app-1",
        appSecret: "secret",
        redirectUri: "https://delegate.example.com/auth/callback",
      },
      {
        code: "code-1",
        codeVerifier: "verifier-1",
      },
      async (url, init) => {
        requests.push({ url, init });
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            id_token: "id-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid profile email",
          }),
          { status: 200 },
        );
      },
    );

    expect(tokens).toEqual({
      accessToken: "access-token",
      idToken: "id-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: "openid profile email",
    });
    expect(requests[0]?.url).toBe("https://auth.example.com/oidc/token");
    const body = requests[0]?.init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("client_id")).toBe("app-1");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("redirect_uri")).toBe("https://delegate.example.com/auth/callback");
    expect(body.get("code_verifier")).toBe("verifier-1");
  });

  it("normalizes a Logto id_token into an external auth profile", () => {
    const idToken = buildUnsignedJwt({
      sub: "logto-user-1",
      email: "Ada@Example.com",
      email_verified: true,
      phone_number: "+8613800138000",
      phone_number_verified: false,
      name: "Ada Lovelace",
      iss: "https://auth.example.com",
      aud: "app-1",
    });

    expect(buildExternalAuthProfileFromLogtoIdToken(idToken)).toEqual({
      provider: "logto",
      subject: "logto-user-1",
      email: "Ada@Example.com",
      emailVerified: true,
      phone: "+8613800138000",
      phoneVerified: false,
      name: "Ada Lovelace",
      metadata: {
        issuer: "https://auth.example.com",
        audience: "app-1",
      },
    });
    expect(decodeJwtPayload<{ sub: string }>(idToken).sub).toBe("logto-user-1");
  });

  it("reads Logto config and requires all deployment secrets", () => {
    expect(
      readLogtoOidcConfig({
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_APP_ID: "app-1",
        LOGTO_APP_SECRET: "secret",
        LOGTO_REDIRECT_URI: "https://delegate.example.com/auth/callback",
        LOGTO_SCOPES: "openid profile email",
      }),
    ).toEqual({
      endpoint: "https://auth.example.com",
      appId: "app-1",
      appSecret: "secret",
      redirectUri: "https://delegate.example.com/auth/callback",
      scopes: ["openid", "profile", "email"],
    });
    expect(() => readLogtoOidcConfig({})).toThrow("LOGTO_ENDPOINT is required");
  });
});

describe("delegate auth session cookies", () => {
  it("signs and verifies a compact owner session", () => {
    const session = createDelegateAuthSession({
      actor: "owner",
      subject: "logto-user-1",
      ownerId: "owner-1",
      email: "ada@example.com",
      now: new Date("2026-07-04T12:00:00.000Z"),
      ttlSeconds: 60,
    });
    const cookie = signDelegateAuthSession(session, "secret");

    expect(verifyDelegateAuthSession(cookie, "secret", new Date("2026-07-04T12:00:30.000Z"))).toEqual(
      session,
    );
    expect(verifyDelegateAuthSession(cookie, "wrong-secret", new Date("2026-07-04T12:00:30.000Z"))).toBeNull();
    expect(verifyDelegateAuthSession(cookie, "secret", new Date("2026-07-04T12:01:01.000Z"))).toBeNull();
  });

  it("rejects tampered session payloads", () => {
    const session = createDelegateAuthSession({
      actor: "audience",
      subject: "logto-user-1",
      audienceIdentityId: "audience-identity-1",
      audienceId: "aud_123",
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const cookie = signDelegateAuthSession(session, "secret");
    const [payload, signature] = cookie.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    decoded.audienceIdentityId = "audience-identity-2";
    const tampered = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${signature}`;

    expect(verifyDelegateAuthSession(tampered, "secret")).toBeNull();
  });

  it("uses a dev-only fallback auth secret", () => {
    expect(readDelegateAuthSessionSecret({ NODE_ENV: "development" })).toBe(
      "delegate-dev-auth-session-secret",
    );
    expect(() => readDelegateAuthSessionSecret({ NODE_ENV: "production" })).toThrow(
      "DELEGATE_AUTH_SESSION_SECRET is required in production",
    );
  });

  it("signs callback state and sanitizes unsafe return paths", () => {
    const state = createDelegateAuthState({
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      returnTo: "https://evil.example.com/phish",
      now: new Date("2026-07-04T12:00:00.000Z"),
      ttlSeconds: 60,
    });
    const cookie = signDelegateAuthState(state, "secret");

    expect(state.returnTo).toBe("/dashboard");
    expect(verifyDelegateAuthState(cookie, "secret", new Date("2026-07-04T12:00:30.000Z"))).toEqual(
      state,
    );
    expect(verifyDelegateAuthState(cookie, "secret", new Date("2026-07-04T12:01:01.000Z"))).toBeNull();
  });
});

function buildUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${encodedPayload}.`;
}
