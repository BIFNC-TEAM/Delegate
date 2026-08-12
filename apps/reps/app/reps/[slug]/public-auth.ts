import { buildLocalizedHref, type Locale } from "@delegate/web-ui";

export type PublicAudienceLoginTarget = "chat" | "telegram-recharge";

export function buildPublicAudienceReturnTo(
  representativeSlug: string,
  locale: Locale,
  target: PublicAudienceLoginTarget = "chat",
): string {
  return buildLocalizedHref(
    target === "telegram-recharge"
      ? `/reps/${representativeSlug}?source=telegram`
      : `/reps/${representativeSlug}#chat`,
    locale,
  );
}

export function buildPublicAudienceLoginHref(
  representativeSlug: string,
  locale: Locale,
  target: PublicAudienceLoginTarget = "chat",
): string {
  return `/reps/${representativeSlug}/auth/login?returnTo=${encodeURIComponent(
    buildPublicAudienceReturnTo(representativeSlug, locale, target),
  )}`;
}

export function buildPublicAudienceLogoutHref(representativeSlug: string, locale: Locale): string {
  return `/reps/${representativeSlug}/auth/logout?returnTo=${encodeURIComponent(
    buildLocalizedHref(`/reps/${representativeSlug}`, locale),
  )}`;
}

export function sanitizePublicAudienceReturnTo(
  value: string | null | undefined,
  representativeSlug: string,
): string {
  const fallback = `/reps/${representativeSlug}#chat`;
  const normalized = value?.trim();
  const rawPathname = normalized?.split(/[?#]/, 1)[0] ?? "";
  if (
    !normalized
    || !normalized.startsWith("/")
    || normalized.startsWith("//")
    || rawPathname.includes("\\")
    || /%5c/i.test(rawPathname)
  ) {
    return fallback;
  }

  try {
    const url = new URL(normalized, "http://delegate.local");
    if (url.origin !== "http://delegate.local" || url.pathname !== `/reps/${representativeSlug}`) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function getRepresentativeAuthCookiePath(representativeSlug: string): string {
  return `/reps/${representativeSlug}`;
}

export function buildRepresentativeAuthRedirectUrl(
  request: Request,
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): URL {
  const baseUrl = resolveRepresentativePublicBaseUrl(request, env);
  return buildSafeRepresentativeRedirectTarget(pathname, baseUrl);
}

/**
 * Redirect an alias-host auth request to the configured public host before any
 * host-bound session/state cookie is written. `Host` is the browser-facing
 * authority in a normal reverse-proxy deployment; X-Forwarded-Host is
 * deliberately ignored because it is commonly caller-controlled.
 */
export function buildRepresentativeCanonicalAuthRequestUrl(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const configuredBaseUrl = readConfiguredRepresentativeBaseUrl(env);
  if (!configuredBaseUrl) {
    resolveRepresentativePublicBaseUrl(request, env);
    return null;
  }

  const requestUrl = new URL(request.url);
  const requestProtocol = resolveExternalRequestProtocol(
    request.headers.get("x-forwarded-proto"),
    requestUrl.protocol,
  );
  const rawRequestHost = request.headers.get("host");
  const requestHost = normalizeRequestHost(
    rawRequestHost ?? requestUrl.host,
    requestProtocol ?? configuredBaseUrl.protocol,
  );
  const requestOrigin =
    requestProtocol && requestHost
      ? new URL(`${requestProtocol}//${requestHost}`).origin
      : null;
  if (requestOrigin === configuredBaseUrl.origin) {
    return null;
  }

  return buildSafeRepresentativeRedirectTarget(
    `${requestUrl.pathname}${requestUrl.search}`,
    configuredBaseUrl,
  );
}

export function resolveRepresentativePublicBaseUrl(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): URL {
  const configuredBaseUrl = readConfiguredRepresentativeBaseUrl(env);
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL is required in production.",
    );
  }

  const requestBaseUrl = new URL(request.url);
  const rawRequestHost = request.headers.get("host");
  const requestHost = normalizeRequestHost(
    rawRequestHost ?? requestBaseUrl.host,
    requestBaseUrl.protocol,
  );
  if (
    !isHttpProtocol(requestBaseUrl.protocol)
    || requestBaseUrl.username
    || requestBaseUrl.password
    || !isLoopbackHostname(requestBaseUrl.hostname)
    || requestHost === null
    || requestHost !== requestBaseUrl.host.toLowerCase()
    || !isLoopbackHostname(
      new URL(`${requestBaseUrl.protocol}//${requestHost}`).hostname,
    )
  ) {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL is required unless the development request uses a loopback origin.",
    );
  }
  return new URL(requestBaseUrl.origin);
}

function readConfiguredRepresentativeBaseUrl(
  env: Record<string, string | undefined>,
): URL | null {
  const configuredBaseUrl = env.NEXT_PUBLIC_REPRESENTATIVE_URL?.trim();
  if (!configuredBaseUrl) {
    return null;
  }

  if (configuredBaseUrl.includes("\\")) {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be an HTTP(S) origin.",
    );
  }
  const baseUrl = new URL(configuredBaseUrl);
  if (
    !isHttpProtocol(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
  ) {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be an HTTP(S) origin.",
    );
  }
  return new URL(baseUrl.origin);
}

function buildSafeRepresentativeRedirectTarget(
  pathname: string,
  baseUrl: URL,
): URL {
  const fallbackUrl = new URL("/", `${baseUrl.origin}/`);
  const normalized = pathname.trim();
  const rawPathname = normalized.split(/[?#]/, 1)[0] ?? "";
  if (
    !normalized.startsWith("/")
    || normalized.startsWith("//")
    || rawPathname.includes("\\")
    || /%5c/i.test(rawPathname)
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

function normalizeRequestHost(
  value: string | null,
  protocol: string,
): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.includes(",") || normalized.includes("\\")) {
    return null;
  }
  try {
    const parsedHost = new URL(`${protocol}//${normalized}`);
    if (
      parsedHost.username
      || parsedHost.password
      || parsedHost.pathname !== "/"
      || parsedHost.search
      || parsedHost.hash
    ) {
      return null;
    }
    return parsedHost.host.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function resolveExternalRequestProtocol(
  forwardedProtocol: string | null,
  requestProtocol: string,
): string | null {
  const normalizedForwardedProtocol = forwardedProtocol?.trim().toLowerCase();
  if (
    normalizedForwardedProtocol === "http"
    || normalizedForwardedProtocol === "https"
  ) {
    return `${normalizedForwardedProtocol}:`;
  }
  return isHttpProtocol(requestProtocol) ? requestProtocol : null;
}

export function isLoopbackRepresentativeHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackRepresentativeHostname(hostname);
}
