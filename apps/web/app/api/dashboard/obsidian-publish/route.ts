import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveKnowledgeLibraryOwnerId } from "@delegate/web-data";
import { createPublishReader, PublishError, readPublishPage } from "@delegate/web-data/obsidian-publish";
import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";

export const runtime = "nodejs";
export const maxDuration = 120;
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), url: z.url().max(2048) }),
  z.object({ action: z.literal("download"), url: z.url().max(2048), selected: z.array(z.url().max(2048)).min(1).max(1000) }),
]);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return json({ error: "Invalid origin." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON required." }, 415);
    const session = await requireDashboardApiOwnerSession();
    const owner = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    if (!owner) return json({ error: "Authentication required." }, 401);
    const body = await request.text();
    if (body.length > 150_000) return json({ error: "Request too large." }, 413);
    const input = schema.parse(JSON.parse(body));
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]);
    const reader = createPublishReader((url, limit) => readPublishPage(url, limit, 0, signal));
    return json(input.action === "list" ? await reader.list(input.url) : await reader.download(input.url, input.selected));
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error);
    if (auth) return auth;
    if (error instanceof PublishError) return json({ error: error.message }, 422);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "站点信息或请求格式无效。 / Invalid site or request." }, 400);
    return json({ error: "无法读取 Publish 站点，请检查地址或稍后重试。 / Unable to read Publish. Check the URL or retry." }, 502);
  }
}
