import { buildLocalizedHref, type Locale } from "@delegate/web-ui";

export function buildPublicAudienceReturnTo(representativeSlug: string, locale: Locale): string {
  return buildLocalizedHref(`/reps/${representativeSlug}#chat`, locale);
}

export function buildPublicAudienceLoginHref(representativeSlug: string, locale: Locale): string {
  return `/reps/${representativeSlug}/auth/login?returnTo=${encodeURIComponent(
    buildPublicAudienceReturnTo(representativeSlug, locale),
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
  if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) {
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

export function buildRepresentativeAuthCallbackUrl(
  request: Request,
  representativeSlug: string,
): string {
  return new URL(`/reps/${representativeSlug}/auth/callback`, request.url).toString();
}
