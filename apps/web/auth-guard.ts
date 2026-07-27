export const DASHBOARD_AUTH_COOKIE_NAME = "delegate_owner_auth_session";
export const DASHBOARD_LEGACY_AUTH_COOKIE_NAME = "delegate_auth_session";

export function shouldRequireCreatorDashboardAuth(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV === "production") {
    return true;
  }
  if (env.DELEGATE_DASHBOARD_AUTH_MODE === "optional") {
    return false;
  }
  return env.DELEGATE_DASHBOARD_AUTH_MODE === "required";
}

export function isCreatorDashboardPath(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/api/dashboard" ||
    pathname.startsWith("/api/dashboard/")
  );
}

export function buildCreatorLoginPath(pathname: string, search = ""): string {
  return buildCreatorLoginPathForReturnTo(`${pathname}${search}`);
}

export function buildCreatorLoginPathForReturnTo(returnTo: string): string {
  const safeReturnTo = sanitizeCreatorReturnTo(returnTo);
  return `/auth/login?actor=owner&returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function buildCreatorLogoutPath(returnTo = "/dashboard"): string {
  const safeReturnTo = sanitizeCreatorReturnTo(returnTo);
  return `/auth/logout?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function buildCreatorRedirectUrl(
  pathname: string,
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
  fallbackPath = "/dashboard",
): URL {
  const baseUrl = resolveCreatorDashboardBaseUrl(requestUrl, env);
  const fallbackUrl = buildSafeCreatorRedirectTarget(
    fallbackPath,
    baseUrl,
    "/dashboard",
  );
  return buildSafeCreatorRedirectTarget(pathname, baseUrl, fallbackUrl.pathname);
}

export function buildCreatorCanonicalAuthRequestUrl(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const configuredBaseUrl = readConfiguredCreatorDashboardBaseUrl(env);
  if (!configuredBaseUrl) {
    resolveCreatorDashboardBaseUrl(request.url, env);
    return null;
  }

  const requestUrl = new URL(request.url);
  const requestProtocol = resolveExternalRequestProtocol(
    request.headers.get("x-forwarded-proto"),
    requestUrl.protocol,
  );
  const requestHost = resolveExternalRequestHost(
    request.headers.get("host"),
    requestUrl,
    requestProtocol,
  );
  const requestOrigin =
    requestHost && requestProtocol
      ? new URL(`${requestProtocol}//${requestHost}`).origin
      : null;
  if (requestOrigin === configuredBaseUrl.origin) {
    return null;
  }

  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `${configuredBaseUrl.origin}/`);
}

export function resolveCreatorAccountLabel(
  session: { email?: string | null } | null | undefined,
  fallback: string,
): string {
  const email = session?.email?.trim();
  if (email) {
    return email;
  }
  return fallback;
}

export function sanitizeCreatorReturnTo(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) {
    return "/dashboard";
  }

  try {
    const url = new URL(normalized, "http://delegate.local");
    if (
      url.origin !== "http://delegate.local" ||
      (url.pathname !== "/dashboard" && !url.pathname.startsWith("/dashboard/"))
    ) {
      return "/dashboard";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/dashboard";
  }
}

function resolveCreatorDashboardBaseUrl(
  requestUrl: string,
  env: Record<string, string | undefined>,
): URL {
  const configuredBaseUrl = readConfiguredCreatorDashboardBaseUrl(env);
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_DASHBOARD_URL is required in production.");
  }

  const requestBaseUrl = new URL(requestUrl);
  if (
    !isHttpProtocol(requestBaseUrl.protocol) ||
    !isLoopbackHostname(requestBaseUrl.hostname)
  ) {
    throw new Error(
      "NEXT_PUBLIC_DASHBOARD_URL is required unless the development request uses a loopback origin.",
    );
  }
  return new URL(requestBaseUrl.origin);
}

function readConfiguredCreatorDashboardBaseUrl(
  env: Record<string, string | undefined>,
): URL | null {
  const configuredBaseUrl = env.NEXT_PUBLIC_DASHBOARD_URL?.trim();
  if (!configuredBaseUrl) {
    return null;
  }

  const baseUrl = new URL(configuredBaseUrl);
  if (
    !isHttpProtocol(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error("NEXT_PUBLIC_DASHBOARD_URL must be an HTTP(S) origin.");
  }
  return new URL(baseUrl.origin);
}

function buildSafeCreatorRedirectTarget(
  pathname: string,
  baseUrl: URL,
  fallbackPath: string,
): URL {
  const fallbackUrl = new URL(fallbackPath, `${baseUrl.origin}/`);
  const normalized = pathname.trim();
  const rawPathname = normalized.split(/[?#]/, 1)[0] ?? "";
  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    rawPathname.includes("\\") ||
    /%5c/i.test(rawPathname)
  ) {
    return fallbackUrl;
  }

  try {
    const target = new URL(normalized, `${baseUrl.origin}/`);
    return target.origin === baseUrl.origin ? target : fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function normalizeHostForProtocol(
  host: string | null,
  protocol: string,
): string | null {
  const normalized = host?.trim();
  if (!normalized) {
    return null;
  }

  try {
    return new URL(`${protocol}//${normalized}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function resolveExternalRequestProtocol(
  forwardedProtocol: string | null,
  requestProtocol: string,
): string | null {
  const normalizedForwardedProtocol = forwardedProtocol?.trim().toLowerCase();
  if (
    normalizedForwardedProtocol === "http" ||
    normalizedForwardedProtocol === "https"
  ) {
    return `${normalizedForwardedProtocol}:`;
  }
  return isHttpProtocol(requestProtocol) ? requestProtocol : null;
}

function resolveExternalRequestHost(
  host: string | null,
  requestUrl: URL,
  protocol: string | null,
): string | null {
  if (!protocol) {
    return null;
  }

  if (host !== null) {
    return normalizeHostForProtocol(host, protocol);
  }
  return normalizeHostForProtocol(requestUrl.host, protocol);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
