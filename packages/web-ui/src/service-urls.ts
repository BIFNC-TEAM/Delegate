export type ResolveServiceUrlOptions = {
  currentAppDefaultPort?: number;
  currentHost?: string | null;
};

export function resolveServiceUrl(
  envValue: string | undefined,
  fallback: string,
  options: ResolveServiceUrlOptions = {},
): string {
  const candidate = envValue?.trim() || inferLocalSiblingUrl(fallback, options) || fallback;
  return candidate.replace(/\/$/, "");
}

function inferLocalSiblingUrl(fallback: string, options: ResolveServiceUrlOptions): string | null {
  if (!options.currentAppDefaultPort || !options.currentHost?.trim()) {
    return null;
  }

  try {
    const fallbackUrl = new URL(fallback);
    const currentUrl = new URL(`http://${normalizeHostHeader(options.currentHost)}`);
    if (!isLocalHostname(fallbackUrl.hostname) || !isLocalHostname(currentUrl.hostname)) {
      return null;
    }

    const fallbackPort = readPort(fallbackUrl);
    const currentPort = readPort(currentUrl);
    if (!fallbackPort || !currentPort) {
      return null;
    }

    const inferredPort = currentPort + fallbackPort - options.currentAppDefaultPort;
    if (inferredPort <= 0 || inferredPort > 65535) {
      return null;
    }

    const inferredUrl = new URL(fallbackUrl.toString());
    inferredUrl.hostname = currentUrl.hostname;
    inferredUrl.port = String(inferredPort);
    return inferredUrl.toString();
  } catch {
    return null;
  }
}

function normalizeHostHeader(value: string): string {
  return value.split(",")[0]?.trim() ?? value.trim();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function readPort(url: URL): number | null {
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 ? port : null;
}
