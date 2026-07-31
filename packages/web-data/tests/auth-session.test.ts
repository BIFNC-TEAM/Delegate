import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_AUDIENCE_AUTH_STATE_COOKIE,
  buildDelegateDevAuthProfile,
  buildExternalAuthProfileFromLogtoIdToken,
  buildLogtoAuthorizeUrl,
  createDelegateAuthSession,
  createDelegateAuthState,
  createDelegateRepresentativeAuthState,
  decodeJwtPayload,
  DELEGATE_OWNER_AUTH_SESSION_COOKIE,
  DELEGATE_OWNER_AUTH_STATE_COOKIE,
  buildVerifiedExternalAuthProfileFromLogtoIdToken,
  derivePkceCodeChallenge,
  exchangeLogtoCodeForTokens,
  generatePkceCodeVerifier,
  isDelegateAuthPersistenceUnavailableError,
  isLegacyRepresentativeCallbackEnabled,
  isLogtoOidcConfigured,
  readDelegateAuthSessionSecret,
  readLegacyRepresentativeLogtoOidcConfig,
  readLogtoOidcConfig,
  shouldUseDelegateAuthDevLogin,
  signDelegateAuthSession,
  signDelegateAuthState,
  verifyDelegateAuthState,
  verifyDelegateAuthSession,
} from "../src/auth-session";

const rfc7636CodeVerifier =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const rfc7636CodeChallenge =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("Logto OIDC helpers", () => {
  it("builds a Logto authorize URL with standard OIDC parameters", () => {
    const url = new URL(
      buildLogtoAuthorizeUrl(
        {
          endpoint: "https://auth.example.com/",
          backchannelEndpoint: "http://logto.internal:3001",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
          scopes: ["openid", "profile", "email"],
        },
        {
          state: "state-1",
          nonce: "nonce-1",
          codeChallenge: rfc7636CodeChallenge,
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
    expect(url.searchParams.get("code_challenge")).toBe(
      rfc7636CodeChallenge,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("generates high-entropy PKCE verifiers and derives the RFC 7636 S256 challenge", () => {
    const firstVerifier = generatePkceCodeVerifier();
    const secondVerifier = generatePkceCodeVerifier();

    expect(firstVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstVerifier).not.toBe(secondVerifier);
    expect(derivePkceCodeChallenge(rfc7636CodeVerifier)).toBe(
      rfc7636CodeChallenge,
    );
  });

  it("exchanges an authorization code against the Logto token endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tokens = await exchangeLogtoCodeForTokens(
      {
        endpoint: "https://auth.example.com",
        backchannelEndpoint: "http://logto.internal:3001",
        appId: "app-1",
        appSecret: "secret",
        redirectUri: "https://delegate.example.com/auth/callback",
      },
      {
        code: "code-1",
        codeVerifier: rfc7636CodeVerifier,
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
    expect(requests[0]?.url).toBe("http://logto.internal:3001/oidc/token");
    const body = requests[0]?.init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("client_id")).toBe("app-1");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("redirect_uri")).toBe("https://delegate.example.com/auth/callback");
    expect(body.get("code_verifier")).toBe(rfc7636CodeVerifier);
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
      issuer: "https://auth.example.com",
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

  it("verifies a signed Logto id_token before building an external auth profile", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: "test-key", alg: "RS256" }],
    });
    const idToken = await new SignJWT({
      email: "Ada@Example.com",
      email_verified: true,
      name: "Ada Lovelace",
      nonce: "nonce-1",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://auth.example.com/oidc")
      .setAudience("app-1")
      .setSubject("logto-user-1")
      .setIssuedAt(Math.floor(new Date("2026-07-04T12:00:00.000Z").getTime() / 1000))
      .setExpirationTime(Math.floor(new Date("2026-07-04T12:05:00.000Z").getTime() / 1000))
      .sign(privateKey);

    await expect(
      buildVerifiedExternalAuthProfileFromLogtoIdToken(
        {
          endpoint: "https://auth.example.com",
          backchannelEndpoint: "http://logto.internal:3001",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
        },
        {
          idToken,
          nonce: "wrong-nonce",
          jwks,
          now: new Date("2026-07-04T12:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("Logto id_token nonce mismatch");

    await expect(
      buildVerifiedExternalAuthProfileFromLogtoIdToken(
        {
          endpoint: "https://auth.example.com",
          backchannelEndpoint: "http://logto.internal:3001",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
        },
        {
          idToken,
          nonce: "nonce-1",
          jwks,
          now: new Date("2026-07-04T12:01:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      provider: "logto",
      issuer: "https://auth.example.com/oidc",
      subject: "logto-user-1",
      email: "Ada@Example.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });

    const bareEndpointIssuerToken = await new SignJWT({
      nonce: "nonce-1",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://auth.example.com")
      .setAudience("app-1")
      .setSubject("logto-user-1")
      .setIssuedAt(Math.floor(new Date("2026-07-04T12:00:00.000Z").getTime() / 1000))
      .setExpirationTime(Math.floor(new Date("2026-07-04T12:05:00.000Z").getTime() / 1000))
      .sign(privateKey);
    await expect(
      buildVerifiedExternalAuthProfileFromLogtoIdToken(
        {
          endpoint: "https://auth.example.com",
          backchannelEndpoint: "http://logto.internal:3001",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
        },
        {
          idToken: bareEndpointIssuerToken,
          nonce: "nonce-1",
          jwks,
          now: new Date("2026-07-04T12:01:00.000Z"),
        },
      ),
    ).rejects.toThrow();

    const wrongAuthorizedPartyToken = await new SignJWT({
      nonce: "nonce-1",
      azp: "other-app",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://auth.example.com/oidc")
      .setAudience(["app-1", "resource-api"])
      .setSubject("logto-user-1")
      .setIssuedAt(
        Math.floor(
          new Date("2026-07-04T12:00:00.000Z").getTime() / 1000,
        ),
      )
      .setExpirationTime(
        Math.floor(
          new Date("2026-07-04T12:05:00.000Z").getTime() / 1000,
        ),
      )
      .sign(privateKey);
    await expect(
      buildVerifiedExternalAuthProfileFromLogtoIdToken(
        {
          endpoint: "https://auth.example.com",
          backchannelEndpoint: "http://logto.internal:3001",
          appId: "app-1",
          appSecret: "secret",
          redirectUri: "https://delegate.example.com/auth/callback",
        },
        {
          idToken: wrongAuthorizedPartyToken,
          nonce: "nonce-1",
          jwks,
          now: new Date("2026-07-04T12:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("Logto id_token authorized party mismatch");
  });

  it("reads isolated Dashboard and Reps Logto configs from canonical origins", () => {
    expect(
      readLogtoOidcConfig("dashboard", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_BACKCHANNEL_ENDPOINT: "http://logto.internal:3001",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        LOGTO_REPS_APP_ID: "reps-app",
        LOGTO_REPS_APP_SECRET: "reps-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com/",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
        LOGTO_SCOPES: "openid profile email",
      }),
    ).toEqual({
      endpoint: "https://auth.example.com",
      backchannelEndpoint: "http://logto.internal:3001",
      appId: "dashboard-app",
      appSecret: "dashboard-secret",
      redirectUri: "https://dashboard.example.com/auth/callback",
      scopes: ["openid", "profile", "email"],
    });
    expect(
      readLogtoOidcConfig("representatives", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        LOGTO_REPS_APP_ID: "reps-app",
        LOGTO_REPS_APP_SECRET: "reps-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com/",
      }),
    ).toMatchObject({
      appId: "reps-app",
      appSecret: "reps-secret",
      redirectUri: "https://reps.example.com/auth/callback",
    });
    expect(() => readLogtoOidcConfig("dashboard", {})).toThrow(
      "LOGTO_ENDPOINT is required",
    );
  });

  it("fails closed on partial namespaced config and never falls back across apps", () => {
    expect(
      isLogtoOidcConfigured("dashboard", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
      }),
    ).toBe(true);
    expect(
      isLogtoOidcConfigured("dashboard", {
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
      }),
    ).toBe(false);
    expect(() =>
      isLogtoOidcConfigured("representatives", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
      }),
    ).toThrow(
      /Incomplete Logto representatives configuration; missing LOGTO_REPS_APP_ID, LOGTO_REPS_APP_SECRET/,
    );
    expect(() =>
      isLogtoOidcConfigured("representatives", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_REPS_APP_ID: "reps-app",
        LOGTO_REPS_APP_SECRET: "reps-secret",
      }),
    ).toThrow("NEXT_PUBLIC_REPRESENTATIVE_URL is required");
    expect(() =>
      readLogtoOidcConfig("representatives", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_APP_ID: "old-shared-app",
        LOGTO_APP_SECRET: "old-shared-secret",
        LOGTO_REDIRECT_URI: "https://reps.example.com/auth/callback",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
      }),
    ).toThrow("LOGTO_REPS_APP_ID is required");
    expect(() =>
      readLogtoOidcConfig("dashboard", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com/base",
      }),
    ).toThrow("NEXT_PUBLIC_DASHBOARD_URL must be an HTTP(S) origin");
    expect(() =>
      readLogtoOidcConfig("dashboard", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_BACKCHANNEL_ENDPOINT: "file:///var/run/logto",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
      }),
    ).toThrow("LOGTO_BACKCHANNEL_ENDPOINT must be an HTTP(S) endpoint");
    expect(() =>
      readLogtoOidcConfig("dashboard", {
        LOGTO_ENDPOINT: "ftp://auth.example.com",
        LOGTO_DASHBOARD_APP_ID: "dashboard-app",
        LOGTO_DASHBOARD_APP_SECRET: "dashboard-secret",
        NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.example.com",
      }),
    ).toThrow("LOGTO_ENDPOINT must be an HTTP(S) endpoint");
  });

  it("builds the bounded legacy Reps tuple only from its isolated namespace", () => {
    expect(
      readLegacyRepresentativeLogtoOidcConfig("demo rep", {
        LOGTO_REPS_LEGACY_ENDPOINT: "https://legacy-auth.example.com",
        LOGTO_REPS_LEGACY_BACKCHANNEL_ENDPOINT:
          "http://legacy-logto.internal:3001",
        LOGTO_REPS_LEGACY_APP_ID: "legacy-app",
        LOGTO_REPS_LEGACY_APP_SECRET: "legacy-secret",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
        LOGTO_SCOPES: "openid email",
      }),
    ).toEqual({
      endpoint: "https://legacy-auth.example.com",
      backchannelEndpoint: "http://legacy-logto.internal:3001",
      appId: "legacy-app",
      appSecret: "legacy-secret",
      redirectUri:
        "https://reps.example.com/reps/demo%20rep/auth/callback",
      scopes: ["openid", "email"],
    });
    expect(() =>
      readLegacyRepresentativeLogtoOidcConfig("demo", {
        LOGTO_ENDPOINT: "https://auth.example.com",
        LOGTO_REPS_APP_ID: "new-app",
        LOGTO_REPS_APP_SECRET: "new-secret",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://reps.example.com",
      }),
    ).toThrow("LOGTO_REPS_LEGACY_ENDPOINT is required");

    const now = new Date("2026-07-04T12:00:00.000Z");
    expect(
      isLegacyRepresentativeCallbackEnabled(
        { DELEGATE_REPS_LEGACY_CALLBACK_UNTIL: "2026-07-04T12:10:00Z" },
        now,
      ),
    ).toBe(true);
    for (const deadline of [
      "",
      "tomorrow",
      "2026-07-04T11:59:59Z",
      "2026-07-04T12:00:00Z",
      "2026-07-04T12:10:00",
      "2026-02-30T12:10:00Z",
      "2026-07-04T12:10:00+24:00",
    ]) {
      expect(
        isLegacyRepresentativeCallbackEnabled(
          { DELEGATE_REPS_LEGACY_CALLBACK_UNTIL: deadline },
          now,
        ),
      ).toBe(false);
    }
  });

  it("uses development login only outside production", () => {
    expect(shouldUseDelegateAuthDevLogin({ NODE_ENV: "development" })).toBe(false);
    expect(
      shouldUseDelegateAuthDevLogin({
        NODE_ENV: "development",
        DELEGATE_AUTH_DEV_LOGIN: "true",
      }),
    ).toBe(true);
    expect(
      shouldUseDelegateAuthDevLogin({
        NODE_ENV: "development",
        DELEGATE_AUTH_DEV_LOGIN: "false",
      }),
    ).toBe(false);
    expect(
      shouldUseDelegateAuthDevLogin({
        NODE_ENV: "production",
        DELEGATE_AUTH_DEV_LOGIN: "true",
      }),
    ).toBe(false);
  });

  it("recognizes local auth persistence outages", () => {
    expect(
      isDelegateAuthPersistenceUnavailableError(
        new Error('The environment variable `DATABASE_URL` resolved to an empty string.'),
      ),
    ).toBe(true);
    expect(isDelegateAuthPersistenceUnavailableError(new Error("invalid state"))).toBe(false);
  });

  it("builds a Logto-compatible local development profile", () => {
    expect(
      buildDelegateDevAuthProfile({
        actor: "audience",
        representativeSlug: "lin-founder-rep",
        audienceId: "aud_123",
      }),
    ).toEqual({
      provider: "logto",
      issuer: "https://local-auth.delegate.invalid/oidc",
      subject: "delegate-dev-audience",
      email: "audience@delegate.local",
      emailVerified: true,
      name: "Local Delegate User",
      metadata: {
        mode: "development",
        actor: "audience",
        representativeSlug: "lin-founder-rep",
        audienceId: "aud_123",
      },
    });
  });
});

describe("delegate auth session cookies", () => {
  it("separates owner and audience cookie names", () => {
    expect(DELEGATE_OWNER_AUTH_SESSION_COOKIE).toBe("delegate_owner_auth_session");
    expect(DELEGATE_OWNER_AUTH_STATE_COOKIE).toBe("delegate_owner_auth_state");
    expect(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE).toBe("delegate_audience_auth_session");
    expect(DELEGATE_AUDIENCE_AUTH_STATE_COOKIE).toBe("delegate_audience_auth_state");
  });

  it("signs and verifies a compact owner session", () => {
    const session = createDelegateAuthSession({
      actor: "owner",
      issuer: "https://auth.example.com/oidc",
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
      issuer: "https://auth.example.com/oidc",
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
      codeVerifier: rfc7636CodeVerifier,
      returnTo: "https://evil.example.com/phish",
      now: new Date("2026-07-04T12:00:00.000Z"),
      ttlSeconds: 60,
    });
    const cookie = signDelegateAuthState(state, "secret");

    expect(state.version).toBe(2);
    expect(state.codeVerifier).toBe(rfc7636CodeVerifier);
    expect(state.returnTo).toBe("/dashboard");
    expect(verifyDelegateAuthState(cookie, "secret", new Date("2026-07-04T12:00:30.000Z"))).toEqual(
      state,
    );
    expect(verifyDelegateAuthState(cookie, "secret", new Date("2026-07-04T12:01:01.000Z"))).toBeNull();
  });

  it("keeps representative audience metadata in signed callback state", () => {
    const state = createDelegateAuthState({
      actor: "audience",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: rfc7636CodeVerifier,
      returnTo: "/reps/lin-founder-rep?lang=zh#chat",
      representativeSlug: "lin-founder-rep",
      audienceId: "aud_123",
      now: new Date("2026-07-04T12:00:00.000Z"),
      ttlSeconds: 60,
    });
    const cookie = signDelegateAuthState(state, "secret");

    expect(verifyDelegateAuthState(cookie, "secret", new Date("2026-07-04T12:00:30.000Z"))).toEqual(
      state,
    );
  });

  it("carries the complete Reps public-chat binding only in v3 signed state", () => {
    const state = createDelegateRepresentativeAuthState({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: rfc7636CodeVerifier,
      returnTo: "/reps/lin-founder-rep?lang=zh#chat",
      representativeSlug: "lin-founder-rep",
      publicChat: {
        audienceId: "aud_123",
        sessionToken: "session-token-with-at-least-24-characters",
        expiresAt: "2026-07-11T12:00:00.000Z",
      },
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const cookie = signDelegateAuthState(state, "secret");

    expect(state.version).toBe(3);
    expect(
      verifyDelegateAuthState(
        cookie,
        "secret",
        new Date("2026-07-04T12:05:00.000Z"),
      ),
    ).toEqual(state);
  });

  it("rejects every overlong state version and obviously future issuedAt", () => {
    expect(() =>
      createDelegateAuthState({
        actor: "owner",
        state: "state-1",
        nonce: "nonce-1",
        codeVerifier: rfc7636CodeVerifier,
        returnTo: "/dashboard",
        ttlSeconds: 601,
      }),
    ).toThrow(/ttlSeconds/);

    const futureState = createDelegateAuthState({
      actor: "owner",
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: rfc7636CodeVerifier,
      returnTo: "/dashboard",
      now: new Date("2026-07-04T12:02:00.000Z"),
    });
    expect(
      verifyDelegateAuthState(
        signDelegateAuthState(futureState, "secret"),
        "secret",
        new Date("2026-07-04T12:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("accepts only short-lived signed v1 state during the PKCE rollout", () => {
    const legacyState = {
      version: 1 as const,
      actor: "owner" as const,
      state: "legacy-state",
      nonce: "legacy-nonce",
      returnTo: "/dashboard",
      issuedAt: 1_783_166_400,
      expiresAt: 1_783_167_000,
    };
    const cookie = signDelegateAuthState(legacyState, "secret");

    expect(
      verifyDelegateAuthState(
        cookie,
        "secret",
        new Date("2026-07-04T12:05:00.000Z"),
      ),
    ).toEqual(legacyState);

    const overlongLegacyCookie = signDelegateAuthState(
      {
        ...legacyState,
        expiresAt: legacyState.issuedAt + 601,
      },
      "secret",
    );
    expect(
      verifyDelegateAuthState(
        overlongLegacyCookie,
        "secret",
        new Date("2026-07-04T12:05:00.000Z"),
      ),
    ).toBeNull();
  });
});

function buildUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${encodedPayload}.`;
}
