import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ExternalAuthProfile } from "./auth-identities";

export const DELEGATE_AUTH_SESSION_COOKIE = "delegate_auth_session";
export const DELEGATE_AUTH_STATE_COOKIE = "delegate_auth_state";
export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type DelegateAuthActor = "owner" | "audience";

export type DelegateAuthSession = {
  version: 1;
  actor: DelegateAuthActor;
  provider: "logto";
  subject: string;
  ownerId?: string;
  audienceIdentityId?: string;
  audienceId?: string;
  email?: string | null;
  issuedAt: number;
  expiresAt: number;
};

export type LogtoOidcConfig = {
  endpoint: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes?: string[];
};

export type LogtoTokenSet = {
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
};

type JwtClaims = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  phone_number?: unknown;
  phone_number_verified?: unknown;
  name?: unknown;
  iss?: unknown;
  aud?: unknown;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function readLogtoOidcConfig(
  env: Record<string, string | undefined> = process.env,
): LogtoOidcConfig {
  const endpoint = normalizeRequiredEnv(env.LOGTO_ENDPOINT, "LOGTO_ENDPOINT");
  const appId = normalizeRequiredEnv(env.LOGTO_APP_ID, "LOGTO_APP_ID");
  const appSecret = normalizeRequiredEnv(env.LOGTO_APP_SECRET, "LOGTO_APP_SECRET");
  const redirectUri = normalizeRequiredEnv(env.LOGTO_REDIRECT_URI, "LOGTO_REDIRECT_URI");

  return {
    endpoint,
    appId,
    appSecret,
    redirectUri,
    scopes: normalizeScopes(env.LOGTO_SCOPES),
  };
}

export function readDelegateAuthSessionSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.DELEGATE_AUTH_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("DELEGATE_AUTH_SESSION_SECRET is required in production");
  }
  return "delegate-dev-auth-session-secret";
}

export function buildLogtoAuthorizeUrl(
  config: LogtoOidcConfig,
  input: {
    state: string;
    nonce: string;
    prompt?: string | undefined;
  },
): string {
  const url = new URL("/oidc/auth", normalizeLogtoEndpoint(config.endpoint));
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getLogtoScopes(config).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  if (input.prompt) {
    url.searchParams.set("prompt", input.prompt);
  }
  return url.toString();
}

export async function exchangeLogtoCodeForTokens(
  config: LogtoOidcConfig,
  input: {
    code: string;
    codeVerifier?: string | undefined;
  },
  fetchImpl: FetchLike = fetch,
): Promise<LogtoTokenSet> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("client_id", config.appId);
  body.set("client_secret", config.appSecret);
  body.set("redirect_uri", config.redirectUri);
  if (input.codeVerifier) {
    body.set("code_verifier", input.codeVerifier);
  }

  const response = await fetchImpl(new URL("/oidc/token", normalizeLogtoEndpoint(config.endpoint)).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorDescription =
      typeof payload?.error_description === "string"
        ? payload.error_description
        : "Logto token exchange failed";
    throw new Error(errorDescription);
  }

  return {
    accessToken: typeof payload?.access_token === "string" ? payload.access_token : undefined,
    idToken: typeof payload?.id_token === "string" ? payload.id_token : undefined,
    refreshToken: typeof payload?.refresh_token === "string" ? payload.refresh_token : undefined,
    expiresIn: typeof payload?.expires_in === "number" ? payload.expires_in : undefined,
    tokenType: typeof payload?.token_type === "string" ? payload.token_type : undefined,
    scope: typeof payload?.scope === "string" ? payload.scope : undefined,
  };
}

export function buildExternalAuthProfileFromLogtoIdToken(idToken: string): ExternalAuthProfile {
  const claims = decodeJwtPayload<JwtClaims>(idToken);
  if (typeof claims.sub !== "string" || !claims.sub.trim()) {
    throw new Error("Logto id_token is missing sub");
  }

  const profile: ExternalAuthProfile = {
    provider: "logto",
    subject: claims.sub,
    metadata: {
      issuer: typeof claims.iss === "string" ? claims.iss : null,
      audience: claims.aud ?? null,
    },
  };
  if (typeof claims.email === "string") {
    profile.email = claims.email;
  }
  if (typeof claims.email_verified === "boolean") {
    profile.emailVerified = claims.email_verified;
  }
  if (typeof claims.phone_number === "string") {
    profile.phone = claims.phone_number;
  }
  if (typeof claims.phone_number_verified === "boolean") {
    profile.phoneVerified = claims.phone_number_verified;
  }
  if (typeof claims.name === "string") {
    profile.name = claims.name;
  }
  return profile;
}

export function createDelegateAuthSession(input: {
  actor: DelegateAuthActor;
  subject: string;
  ownerId?: string | undefined;
  audienceIdentityId?: string | undefined;
  audienceId?: string | undefined;
  email?: string | null | undefined;
  now?: Date | undefined;
  ttlSeconds?: number | undefined;
}): DelegateAuthSession {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_AUTH_SESSION_TTL_SECONDS;
  const session: DelegateAuthSession = {
    version: 1,
    actor: input.actor,
    provider: "logto",
    subject: normalizeRequiredText(input.subject, "subject"),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  };
  if (input.ownerId) {
    session.ownerId = input.ownerId;
  }
  if (input.audienceIdentityId) {
    session.audienceIdentityId = input.audienceIdentityId;
  }
  if (input.audienceId) {
    session.audienceId = input.audienceId;
  }
  if (input.email !== undefined) {
    session.email = input.email;
  }
  return session;
}

export function signDelegateAuthSession(session: DelegateAuthSession, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
}

export function verifyDelegateAuthSession(
  cookieValue: string | undefined,
  secret: string,
  now = new Date(),
): DelegateAuthSession | null {
  if (!cookieValue) {
    return null;
  }
  const [encodedPayload, encodedSignature] = cookieValue.split(".");
  if (!encodedPayload || !encodedSignature) {
    return null;
  }
  const expectedSignature = signPayload(encodedPayload, secret);
  if (!safeEqual(encodedSignature, expectedSignature)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isDelegateAuthSession(session)) {
      return null;
    }
    if (session.expiresAt <= Math.floor(now.getTime() / 1000)) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function decodeJwtPayload<T>(jwt: string): T {
  const [, payload] = jwt.split(".");
  if (!payload) {
    throw new Error("JWT payload is missing");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

export function generateAuthStateToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeLogtoEndpoint(endpoint: string): string {
  return normalizeRequiredText(endpoint, "endpoint").replace(/\/+$/, "");
}

function getLogtoScopes(config: LogtoOidcConfig): string[] {
  return config.scopes?.length ? config.scopes : ["openid", "profile", "email", "phone"];
}

function normalizeScopes(scopes: string | undefined): string[] {
  const normalized = scopes
    ?.split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return normalized?.length ? normalized : ["openid", "profile", "email", "phone"];
}

function normalizeRequiredEnv(value: string | undefined, name: string): string {
  return normalizeRequiredText(value, name);
}

function normalizeRequiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", normalizeRequiredText(secret, "secret"))
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isDelegateAuthSession(value: unknown): value is DelegateAuthSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as Partial<DelegateAuthSession>;
  return (
    session.version === 1 &&
    (session.actor === "owner" || session.actor === "audience") &&
    session.provider === "logto" &&
    typeof session.subject === "string" &&
    typeof session.issuedAt === "number" &&
    typeof session.expiresAt === "number"
  );
}
