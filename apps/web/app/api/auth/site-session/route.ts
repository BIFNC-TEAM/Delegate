import { NextResponse } from "next/server";

import { getOwnerDashboardPreferences } from "@delegate/web-data/owner-settings";

import { getOwnerAuthSession } from "../../../auth/owner-session";

export async function GET(request: Request) {
  const corsHeaders = resolveSiteCorsHeaders(request);
  if (!corsHeaders) {
    return new NextResponse(null, {
      status: 403,
      headers: { "cache-control": "no-store", vary: "Origin" },
    });
  }

  try {
    const session = await getOwnerAuthSession();
    if (!session?.ownerId?.trim()) {
      return NextResponse.json(
        { authenticated: false },
        { headers: corsHeaders },
      );
    }

    const preferences = await getOwnerDashboardPreferences({
      ownerId: session.ownerId,
    }).catch(() => null);
    const email = session.email?.trim() || null;
    const displayName =
      preferences?.displayName.trim()
      || email
      || "Delegate Creator";

    return NextResponse.json(
      {
        authenticated: true,
        account: { displayName, email },
      },
      { headers: corsHeaders },
    );
  } catch {
    return NextResponse.json(
      { authenticated: false },
      { headers: corsHeaders },
    );
  }
}

export function OPTIONS(request: Request) {
  const corsHeaders = resolveSiteCorsHeaders(request);
  if (!corsHeaders) {
    return new NextResponse(null, {
      status: 403,
      headers: { "cache-control": "no-store", vary: "Origin" },
    });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function resolveSiteCorsHeaders(request: Request): HeadersInit | null {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    return privateHeaders();
  }

  const configuredSiteOrigin = parseHttpOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  if (!configuredSiteOrigin || !isAllowedSiteOrigin(origin, configuredSiteOrigin)) {
    return null;
  }

  return privateHeaders(origin);
}

function privateHeaders(origin?: string): Record<string, string> {
  return {
    "cache-control": "private, no-store, max-age=0",
    vary: "Origin, Cookie",
    ...(origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, OPTIONS",
        }
      : {}),
  };
}

function parseHttpOrigin(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isAllowedSiteOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) return true;
  if (process.env.NODE_ENV === "production") return false;
  try {
    const actual = new URL(origin);
    const configured = new URL(configuredOrigin);
    return actual.protocol === configured.protocol
      && actual.port === configured.port
      && isLoopback(actual.hostname)
      && isLoopback(configured.hostname);
  } catch {
    return false;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
