export const DASHBOARD_AUTH_COOKIE_NAME = "delegate_auth_session";

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
  const returnTo = sanitizeCreatorReturnTo(`${pathname}${search}`);
  return `/auth/login?actor=owner&returnTo=${encodeURIComponent(returnTo)}`;
}

export function sanitizeCreatorReturnTo(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) {
    return "/dashboard";
  }
  return normalized;
}
