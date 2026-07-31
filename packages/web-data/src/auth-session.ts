import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";

import type { ExternalAuthProfile } from "./auth-identities";

export const DELEGATE_OWNER_AUTH_SESSION_COOKIE = "delegate_owner_auth_session";
export const DELEGATE_OWNER_AUTH_STATE_COOKIE = "delegate_owner_auth_state";
export const DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE = "delegate_audience_auth_session";
export const DELEGATE_AUDIENCE_AUTH_STATE_COOKIE = "delegate_audience_auth_state";
export const DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE =
  "delegate_representatives_auth_state_v3";
export const DELEGATE_REPRESENTATIVES_AUTH_STATE_COOKIE_PATH = "/auth/callback";
export const LEGACY_DELEGATE_AUTH_SESSION_COOKIE = "delegate_auth_session";
export const LEGACY_DELEGATE_AUTH_STATE_COOKIE = "delegate_auth_state";
export const DELEGATE_AUTH_SESSION_COOKIE = DELEGATE_OWNER_AUTH_SESSION_COOKIE;
export const DELEGATE_AUTH_STATE_COOKIE = DELEGATE_OWNER_AUTH_STATE_COOKIE;
export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DEFAULT_AUTH_STATE_TTL_SECONDS = 10 * 60;
export const DEFAULT_AUTH_STATE_FUTURE_SKEW_SECONDS = 60;
export const DEFAULT_DELEGATE_DEV_AUTH_ISSUER =
  "https://local-auth.delegate.invalid/oidc";

export type DelegateAuthActor = "owner" | "audience";
export type LogtoApplication = "dashboard" | "representatives";

export type DelegateAuthSession = {
  version: 1;
  actor: DelegateAuthActor;
  provider: "logto";
  /**
   * Optional only so legacy signed sessions still parse during the expand
   * deployment. New sessions always contain an issuer, and authenticated
   * identity revalidation must reject a session that does not contain one.
   */
  issuer?: string;
  subject: string;
  ownerId?: string;
  audienceIdentityId?: string;
  audienceId?: string;
  email?: string | null;
  issuedAt: number;
  expiresAt: number;
};

type DelegateAuthStateBase = {
  actor: DelegateAuthActor;
  state: string;
  nonce: string;
  returnTo: string;
  representativeSlug?: string;
  audienceId?: string;
  issuedAt: number;
  expiresAt: number;
};

export type DelegateLegacyAuthState = DelegateAuthStateBase & {
  version: 1;
};

export type DelegatePkceAuthState = DelegateAuthStateBase & {
  version: 2;
  codeVerifier: string;
};

export type DelegateRepresentativePublicChatState = {
  audienceId: string;
  sessionToken: string;
  expiresAt: string;
};

export type DelegateRepresentativePkceAuthState = DelegateAuthStateBase & {
  version: 3;
  actor: "audience";
  codeVerifier: string;
  representativeSlug: string;
  publicChat: DelegateRepresentativePublicChatState;
};

export type DelegateAuthState =
  | DelegateLegacyAuthState
  | DelegatePkceAuthState
  | DelegateRepresentativePkceAuthState;

export type LogtoOidcConfig = {
  endpoint: string;
  backchannelEndpoint?: string;
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
  azp?: unknown;
  nonce?: unknown;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type VerifyLogtoIdTokenOptions = {
  idToken: string;
  nonce: string;
  jwks?: JWTVerifyGetKey | undefined;
  now?: Date | undefined;
};

const logtoJwksCache = new Map<string, JWTVerifyGetKey>();

export function readLogtoOidcConfig(
  application: LogtoApplication,
  env: Record<string, string | undefined> = process.env,
): LogtoOidcConfig {
  const endpoint = normalizeOidcEndpoint(
    normalizeRequiredEnv(env.LOGTO_ENDPOINT, "LOGTO_ENDPOINT"),
    "LOGTO_ENDPOINT",
  );
  const backchannelEndpoint = normalizeOptionalOidcEndpoint(
    env.LOGTO_BACKCHANNEL_ENDPOINT,
    "LOGTO_BACKCHANNEL_ENDPOINT",
  );
  const namespace = getLogtoApplicationNamespace(application);
  const appId = normalizeRequiredEnv(env[namespace.appId], namespace.appId);
  const appSecret = normalizeRequiredEnv(
    env[namespace.appSecret],
    namespace.appSecret,
  );
  const redirectUri = buildCanonicalCallbackUri(
    env[namespace.canonicalOrigin],
    namespace.canonicalOrigin,
    "/auth/callback",
  );

  return {
    endpoint,
    ...(backchannelEndpoint ? { backchannelEndpoint } : {}),
    appId,
    appSecret,
    redirectUri,
    scopes: normalizeScopes(env.LOGTO_SCOPES),
  };
}

export function isLogtoOidcConfigured(
  application: LogtoApplication,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const namespace = getLogtoApplicationNamespace(application);
  const clientTuple = [
    ["LOGTO_ENDPOINT", env.LOGTO_ENDPOINT],
    [namespace.appId, env[namespace.appId]],
    [namespace.appSecret, env[namespace.appSecret]],
  ] as const;
  const configured = clientTuple.filter(([, value]) => Boolean(value?.trim()));
  if (configured.length === 0) {
    return false;
  }
  if (configured.length !== clientTuple.length) {
    const missing = clientTuple
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name);
    throw new Error(
      `Incomplete Logto ${application} configuration; missing ${missing.join(", ")}`,
    );
  }

  readLogtoOidcConfig(application, env);
  return true;
}

export function readLegacyRepresentativeLogtoOidcConfig(
  representativeSlug: string,
  env: Record<string, string | undefined> = process.env,
): LogtoOidcConfig {
  const endpoint = normalizeOidcEndpoint(
    normalizeRequiredEnv(
      env.LOGTO_REPS_LEGACY_ENDPOINT,
      "LOGTO_REPS_LEGACY_ENDPOINT",
    ),
    "LOGTO_REPS_LEGACY_ENDPOINT",
  );
  const backchannelEndpoint = normalizeOptionalOidcEndpoint(
    env.LOGTO_REPS_LEGACY_BACKCHANNEL_ENDPOINT,
    "LOGTO_REPS_LEGACY_BACKCHANNEL_ENDPOINT",
  );
  const appId = normalizeRequiredEnv(
    env.LOGTO_REPS_LEGACY_APP_ID,
    "LOGTO_REPS_LEGACY_APP_ID",
  );
  const appSecret = normalizeRequiredEnv(
    env.LOGTO_REPS_LEGACY_APP_SECRET,
    "LOGTO_REPS_LEGACY_APP_SECRET",
  );
  const slug = normalizeRequiredText(representativeSlug, "representativeSlug");
  const redirectUri = buildCanonicalCallbackUri(
    env.NEXT_PUBLIC_REPRESENTATIVE_URL,
    "NEXT_PUBLIC_REPRESENTATIVE_URL",
    `/reps/${encodeURIComponent(slug)}/auth/callback`,
  );

  return {
    endpoint,
    ...(backchannelEndpoint ? { backchannelEndpoint } : {}),
    appId,
    appSecret,
    redirectUri,
    scopes: normalizeScopes(env.LOGTO_SCOPES),
  };
}

export function isLegacyRepresentativeCallbackEnabled(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): boolean {
  const deadline = env.DELEGATE_REPS_LEGACY_CALLBACK_UNTIL?.trim();
  const match = deadline?.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u,
  );
  if (!deadline || !match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0") || "0");
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const offsetDirection = match[9] === "-" ? -1 : 1;
  const offsetMs =
    match[8] === "Z"
      ? 0
      : offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const normalizedDeadlineMs =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) -
    offsetMs;
  const deadlineMs = Date.parse(deadline);
  return (
    Number.isFinite(deadlineMs) &&
    deadlineMs === normalizedDeadlineMs &&
    deadlineMs > now.getTime()
  );
}

export function shouldUseDelegateAuthDevLogin(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }

  const value = env.DELEGATE_AUTH_DEV_LOGIN?.trim().toLowerCase();
  if (!value) {
    return false;
  }

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isDelegateAuthPersistenceUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Can't reach database server") ||
    error.message.includes("Environment variable not found: DATABASE_URL") ||
    error.message.includes("resolved to an empty string") ||
    error.message.includes("P1001") ||
    error.message.includes("Cannot read properties of undefined (reading 'findUnique')")
  );
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
    codeChallenge: string;
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
  url.searchParams.set(
    "code_challenge",
    normalizePkceCodeChallenge(input.codeChallenge),
  );
  url.searchParams.set("code_challenge_method", "S256");
  if (input.prompt) {
    url.searchParams.set("prompt", input.prompt);
  }
  return url.toString();
}

export async function exchangeLogtoCodeForTokens(
  config: LogtoOidcConfig,
  input: {
    code: string;
    /**
     * Undefined is accepted only while an already-issued v1 auth-state cookie
     * completes its bounded compatibility window.
     */
    codeVerifier: string | undefined;
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
    body.set("code_verifier", normalizePkceCodeVerifier(input.codeVerifier));
  }

  const tokenEndpoint = normalizeLogtoEndpoint(
    config.backchannelEndpoint ?? config.endpoint,
  );
  const response = await fetchImpl(new URL("/oidc/token", tokenEndpoint).toString(), {
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
  // This only decodes trusted/test tokens. Login callbacks must verify with JWKS first.
  const claims = decodeJwtPayload<JwtClaims>(idToken);
  return buildExternalAuthProfileFromLogtoClaims(claims);
}

export async function buildVerifiedExternalAuthProfileFromLogtoIdToken(
  config: LogtoOidcConfig,
  input: VerifyLogtoIdTokenOptions,
): Promise<ExternalAuthProfile> {
  const endpoint = normalizeLogtoEndpoint(config.endpoint);
  const jwksEndpoint = normalizeLogtoEndpoint(
    config.backchannelEndpoint ?? config.endpoint,
  );
  const issuer = getLogtoIssuer(endpoint);
  const verifyOptions: JWTVerifyOptions = {
    audience: normalizeRequiredText(config.appId, "appId"),
    clockTolerance: "60s",
    issuer,
  };
  if (input.now) {
    verifyOptions.currentDate = input.now;
  }
  const { payload } = await jwtVerify(
    input.idToken,
    input.jwks ?? getLogtoRemoteJwks(jwksEndpoint),
    verifyOptions,
  );
  const claims = payload as JwtClaims;
  if (claims.nonce !== normalizeRequiredText(input.nonce, "nonce")) {
    throw new Error("Logto id_token nonce mismatch");
  }
  validateLogtoAuthorizedParty(claims, config.appId);
  return buildExternalAuthProfileFromLogtoClaims(claims);
}

function validateLogtoAuthorizedParty(
  claims: JwtClaims,
  appId: string,
): void {
  const expected = normalizeRequiredText(appId, "appId");
  const multipleAudiences = Array.isArray(claims.aud) && claims.aud.length > 1;
  if (
    (multipleAudiences && claims.azp !== expected) ||
    (claims.azp !== undefined && claims.azp !== expected)
  ) {
    throw new Error("Logto id_token authorized party mismatch");
  }
}

function buildExternalAuthProfileFromLogtoClaims(claims: JwtClaims): ExternalAuthProfile {
  if (typeof claims.sub !== "string" || !claims.sub.trim()) {
    throw new Error("Logto id_token is missing sub");
  }
  if (typeof claims.iss !== "string" || !claims.iss.trim()) {
    throw new Error("Logto id_token is missing iss");
  }

  const profile: ExternalAuthProfile = {
    provider: "logto",
    issuer: claims.iss,
    subject: claims.sub,
    metadata: {
      issuer: claims.iss,
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

export function buildDelegateDevAuthProfile(input: {
  actor: DelegateAuthActor;
  subject?: string | undefined;
  email?: string | null | undefined;
  name?: string | null | undefined;
  issuer?: string | undefined;
  representativeSlug?: string | undefined;
  audienceId?: string | undefined;
}): ExternalAuthProfile {
  const subject = normalizeRequiredText(
    input.subject ??
      (input.actor === "owner" ? "delegate-dev-owner" : "delegate-dev-audience"),
    "subject",
  );
  const defaultEmail =
    input.actor === "owner" ? "creator@delegate.local" : "audience@delegate.local";
  const email = input.email === undefined ? defaultEmail : input.email;

  return {
    provider: "logto",
    issuer: normalizeRequiredText(
      input.issuer ?? DEFAULT_DELEGATE_DEV_AUTH_ISSUER,
      "issuer",
    ),
    subject,
    email,
    emailVerified: Boolean(email),
    name:
      input.name ??
      (input.actor === "owner" ? "Local Delegate Creator" : "Local Delegate User"),
    metadata: {
      mode: "development",
      actor: input.actor,
      representativeSlug: input.representativeSlug ?? null,
      audienceId: input.audienceId ?? null,
    },
  };
}

export function createDelegateAuthSession(input: {
  actor: DelegateAuthActor;
  issuer: string;
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
    issuer: normalizeRequiredText(input.issuer, "issuer"),
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

export function createDelegateAuthState(input: {
  actor: DelegateAuthActor;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  representativeSlug?: string | undefined;
  audienceId?: string | undefined;
  now?: Date | undefined;
  ttlSeconds?: number | undefined;
}): DelegatePkceAuthState {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeAuthStateTtlSeconds(input.ttlSeconds);

  return {
    version: 2,
    actor: input.actor,
    state: normalizeRequiredText(input.state, "state"),
    nonce: normalizeRequiredText(input.nonce, "nonce"),
    codeVerifier: normalizePkceCodeVerifier(input.codeVerifier),
    returnTo: sanitizeRelativeReturnTo(input.returnTo),
    ...(input.representativeSlug
      ? { representativeSlug: normalizeRequiredText(input.representativeSlug, "representativeSlug") }
      : {}),
    ...(input.audienceId ? { audienceId: normalizeRequiredText(input.audienceId, "audienceId") } : {}),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  };
}

export function createDelegateRepresentativeAuthState(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  representativeSlug: string;
  publicChat: DelegateRepresentativePublicChatState;
  now?: Date | undefined;
  ttlSeconds?: number | undefined;
}): DelegateRepresentativePkceAuthState {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeAuthStateTtlSeconds(input.ttlSeconds);
  const publicChat = normalizeRepresentativePublicChatState(input.publicChat);

  return {
    version: 3,
    actor: "audience",
    state: normalizeRequiredText(input.state, "state"),
    nonce: normalizeRequiredText(input.nonce, "nonce"),
    codeVerifier: normalizePkceCodeVerifier(input.codeVerifier),
    returnTo: sanitizeRelativeReturnTo(input.returnTo),
    representativeSlug: normalizeRequiredText(
      input.representativeSlug,
      "representativeSlug",
    ),
    publicChat,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  };
}

export function signDelegateAuthSession(session: DelegateAuthSession, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
}

export function signDelegateAuthState(state: DelegateAuthState, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
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

export function verifyDelegateAuthState(
  cookieValue: string | undefined,
  secret: string,
  now = new Date(),
): DelegateAuthState | null {
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
    const state = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isDelegateAuthState(state)) {
      return null;
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      state.expiresAt <= nowSeconds ||
      state.issuedAt > nowSeconds + DEFAULT_AUTH_STATE_FUTURE_SKEW_SECONDS ||
      (state.version === 3 &&
        Date.parse(state.publicChat.expiresAt) <= now.getTime())
    ) {
      return null;
    }
    return state;
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

export function generatePkceCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function derivePkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256")
    .update(normalizePkceCodeVerifier(codeVerifier), "ascii")
    .digest("base64url");
}

function normalizeLogtoEndpoint(endpoint: string): string {
  return normalizeOidcEndpoint(
    normalizeRequiredText(endpoint, "endpoint"),
    "endpoint",
  );
}

function getLogtoRemoteJwks(endpoint: string): JWTVerifyGetKey {
  const jwksUrl = new URL("/oidc/jwks", endpoint).toString();
  const cached = logtoJwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  logtoJwksCache.set(jwksUrl, jwks);
  return jwks;
}

function getLogtoIssuer(endpoint: string): string {
  return new URL("/oidc", endpoint).toString().replace(/\/+$/, "");
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

function getLogtoApplicationNamespace(application: LogtoApplication): {
  appId: "LOGTO_DASHBOARD_APP_ID" | "LOGTO_REPS_APP_ID";
  appSecret: "LOGTO_DASHBOARD_APP_SECRET" | "LOGTO_REPS_APP_SECRET";
  canonicalOrigin:
    | "NEXT_PUBLIC_DASHBOARD_URL"
    | "NEXT_PUBLIC_REPRESENTATIVE_URL";
} {
  if (application === "dashboard") {
    return {
      appId: "LOGTO_DASHBOARD_APP_ID",
      appSecret: "LOGTO_DASHBOARD_APP_SECRET",
      canonicalOrigin: "NEXT_PUBLIC_DASHBOARD_URL",
    };
  }
  return {
    appId: "LOGTO_REPS_APP_ID",
    appSecret: "LOGTO_REPS_APP_SECRET",
    canonicalOrigin: "NEXT_PUBLIC_REPRESENTATIVE_URL",
  };
}

function buildCanonicalCallbackUri(
  value: string | undefined,
  name: string,
  callbackPath: string,
): string {
  const normalized = normalizeRequiredEnv(value, name);
  if (normalized.includes("\\")) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  let origin: URL;
  try {
    origin = new URL(normalized);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return new URL(callbackPath, `${origin.origin}/`).toString();
}

function normalizeOptionalOidcEndpoint(
  value: string | undefined,
  name: string,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalizeOidcEndpoint(normalized, name) : undefined;
}

function normalizeOidcEndpoint(value: string, name: string): string {
  if (value.includes("\\")) {
    throw new Error(`${name} must be an HTTP(S) endpoint`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) endpoint`);
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(`${name} must be an HTTP(S) endpoint`);
  }
  return endpoint.toString().replace(/\/+$/, "");
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

function normalizePkceCodeVerifier(value: string): string {
  const normalized = normalizeRequiredText(value, "codeVerifier");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(normalized)) {
    throw new Error("codeVerifier must be a valid RFC 7636 PKCE verifier");
  }
  return normalized;
}

function normalizePkceCodeChallenge(value: string): string {
  const normalized = normalizeRequiredText(value, "codeChallenge");
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new Error("codeChallenge must be a valid S256 PKCE challenge");
  }
  return normalized;
}

function normalizeAuthStateTtlSeconds(value: number | undefined): number {
  const ttlSeconds = value ?? DEFAULT_AUTH_STATE_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > DEFAULT_AUTH_STATE_TTL_SECONDS
  ) {
    throw new Error(
      `ttlSeconds must be an integer between 1 and ${DEFAULT_AUTH_STATE_TTL_SECONDS}`,
    );
  }
  return ttlSeconds;
}

function normalizeRepresentativePublicChatState(
  state: DelegateRepresentativePublicChatState,
): DelegateRepresentativePublicChatState {
  const audienceId = normalizeRequiredText(state.audienceId, "publicChat.audienceId");
  const sessionToken = normalizeRequiredText(
    state.sessionToken,
    "publicChat.sessionToken",
  );
  if (sessionToken.length < 24) {
    throw new Error("publicChat.sessionToken must contain at least 24 characters");
  }
  const expiresAt = normalizeRequiredText(
    state.expiresAt,
    "publicChat.expiresAt",
  );
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("publicChat.expiresAt must be an absolute timestamp");
  }
  return { audienceId, sessionToken, expiresAt };
}

function sanitizeRelativeReturnTo(value: string): string {
  const normalized = value.trim();
  if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) {
    return "/dashboard";
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

function isDelegateAuthState(value: unknown): value is DelegateAuthState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<DelegateAuthState>;
  if (
    (state.actor !== "owner" && state.actor !== "audience") ||
    typeof state.state !== "string" ||
    !state.state ||
    typeof state.nonce !== "string" ||
    !state.nonce ||
    typeof state.returnTo !== "string" ||
    !state.returnTo ||
    !isOptionalString(state.representativeSlug) ||
    !isOptionalString(state.audienceId) ||
    typeof state.issuedAt !== "number" ||
    typeof state.expiresAt !== "number" ||
    !Number.isInteger(state.issuedAt) ||
    !Number.isInteger(state.expiresAt) ||
    state.expiresAt <= state.issuedAt ||
    state.expiresAt - state.issuedAt > DEFAULT_AUTH_STATE_TTL_SECONDS
  ) {
    return false;
  }
  if (state.version === 2) {
    return (
      typeof state.codeVerifier === "string" &&
      /^[A-Za-z0-9._~-]{43,128}$/.test(state.codeVerifier)
    );
  }
  if (state.version === 3) {
    return (
      state.actor === "audience" &&
      typeof state.representativeSlug === "string" &&
      Boolean(state.representativeSlug) &&
      typeof state.codeVerifier === "string" &&
      /^[A-Za-z0-9._~-]{43,128}$/.test(state.codeVerifier) &&
      isRepresentativePublicChatState(state.publicChat)
    );
  }
  return state.version === 1;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRepresentativePublicChatState(
  value: unknown,
): value is DelegateRepresentativePublicChatState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<DelegateRepresentativePublicChatState>;
  return (
    typeof state.audienceId === "string" &&
    Boolean(state.audienceId) &&
    typeof state.sessionToken === "string" &&
    state.sessionToken.length >= 24 &&
    typeof state.expiresAt === "string" &&
    Number.isFinite(Date.parse(state.expiresAt))
  );
}
