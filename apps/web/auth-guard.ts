export const DASHBOARD_AUTH_COOKIE_NAME = "delegate_owner_auth_session";
export const DASHBOARD_LEGACY_AUTH_COOKIE_NAME = "delegate_auth_session";

export function shouldRequireCreatorDashboardAuth(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.DELEGATE_DASHBOARD_AUTH_MODE === "optional") {
    return false;
  }
  return env.DELEGATE_DASHBOARD_AUTH_MODE === "required" || env.NODE_ENV === "production";
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
