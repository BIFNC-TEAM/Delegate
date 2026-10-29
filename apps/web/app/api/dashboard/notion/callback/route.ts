import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { finishNotionAuthorization } from "@delegate/web-data/notion";
import { requireDashboardApiOwnerSession } from "../../auth";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const jar = await cookies();
  let target = "/dashboard?view=knowledge&notionImport=1&notionResult=error";
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const browser = jar.get("delegate-notion-oauth")?.value ?? "";
    if (!state || !browser || state.length > 128) throw new Error("Invalid state");
    const session = await requireDashboardApiOwnerSession();
    // Null is allowed only by the existing local-development authentication guard.
    // The owner then comes from the single-use, browser-bound server record.
    const result = await finishNotionAuthorization(state, browser, session?.ownerId ?? null, url.searchParams.get("error") ? null : url.searchParams.get("code"));
    target = `${result.returnTo}&notionResult=${result.success ? "connected" : "cancelled"}`;
  } catch { /* Never include codes, tokens or raw provider errors in URLs/logs. */ }
  jar.set("delegate-notion-oauth", "", { path: "/api/dashboard/notion", maxAge: 0, httpOnly: true, sameSite: "lax" });
  const response = NextResponse.redirect(new URL(target, process.env.NOTION_REDIRECT_URI || request.url));
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
