export function getUsablePublicUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("/") && !normalized.startsWith("//")) {
    return normalized;
  }

  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.hostname === "example.com" || url.hostname.endsWith(".example.com")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
