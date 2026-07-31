import type { Locale } from "@delegate/web-ui";

export function formatRelativeTime(value: string, locale: Locale, timeZone: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: validTimeZoneOrUtc(timeZone),
  }).format(date);
}

export function formatMessageTime(value: string, locale: Locale, timeZone: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: validTimeZoneOrUtc(timeZone),
  }).format(date);
}

export function formatVersionDateTime(value: string, locale: Locale, timeZone: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: validTimeZoneOrUtc(timeZone),
  }).format(date);
}

function validTimeZoneOrUtc(value: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return value;
  } catch {
    return "UTC";
  }
}
