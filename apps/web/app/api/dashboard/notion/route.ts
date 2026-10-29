import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveKnowledgeLibraryOwnerId } from "@delegate/web-data";
import { beginNotionAuthorization, listNotionConnections, disconnectNotion, withNotion, NotionError } from "@delegate/web-data/notion";
import { listNotionPages, listNotionRecords, lookupNotionPage, expandNotionPages, readNotionPage } from "@delegate/web-data/notion-content";
import { requireDashboardApiOwnerSession, dashboardAuthErrorResponse } from "../auth";

export const runtime = "nodejs";
export const maxDuration = 120;
const id = z.uuid();
const connection = { connectionId: z.string().min(1).max(128) };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("connect"), lang: z.enum(["zh", "en"]).default("zh"), representative: z.string().max(200) }),
  z.object({ action: z.literal("disconnect"), ...connection }),
  z.object({ action: z.literal("list"), ...connection, query: z.string().max(200).default("") }),
  z.object({ action: z.literal("records"), ...connection, sourceId: id }),
  z.object({ action: z.literal("lookup"), ...connection, url: z.string().max(2048) }),
  z.object({ action: z.literal("expand"), ...connection, selected: z.array(id).min(1).max(100) }),
  z.object({ action: z.literal("read"), ...connection, pageId: id }),
]);
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function POST(request: Request) {
  try {
    // The registered public origin remains stable behind a TLS-terminating reverse proxy.
    const requestOrigin = request.headers.get("origin") ?? new URL(request.url).origin;
    const expectedOrigin = new URL(process.env.NOTION_REDIRECT_URI || request.url).origin;
    if (request.headers.get("origin") && requestOrigin !== expectedOrigin) return json({ error: "Invalid origin." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON required." }, 415);
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    if (!ownerId) return json({ error: "Authentication required." }, 401);
    const text = await request.text(); if (text.length > 20_000) return json({ error: "Request too large." }, 413);
    const input = schema.parse(JSON.parse(text));
    if (input.action === "status") return json({ connections: await listNotionConnections(ownerId) });
    if (input.action === "connect") {
      const browser = randomBytes(32).toString("base64url");
      const returnTo = `/dashboard?${new URLSearchParams({ view: "knowledge", lang: input.lang, rep: input.representative, notionImport: "1" })}`;
      const result = await beginNotionAuthorization(ownerId, browser, returnTo);
      if (result.origin !== requestOrigin) return json({ error: `请从已配置的回调站点 ${result.origin} 打开仪表盘。 / Open the configured callback origin.` }, 422);
      const jar = await cookies();
      jar.set("delegate-notion-oauth", browser, { httpOnly: true, sameSite: "lax", secure: result.origin.startsWith("https:"), path: "/api/dashboard/notion", maxAge: 600 });
      return json({ url: result.url });
    }
    if (input.action === "disconnect") { await disconnectNotion(ownerId, input.connectionId); return json({ ok: true }); }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]);
    return json(await withNotion(ownerId, input.connectionId, async (client, row) => {
      switch (input.action) {
        case "list": return { entries: await listNotionPages(client, input.query) };
        case "records": return { entries: await listNotionRecords(client, input.sourceId) };
        case "lookup": return { entry: await lookupNotionPage(client, input.url) };
        case "expand": return { entries: await expandNotionPages(client, input.selected) };
        case "read": return { document: await readNotionPage(client, input.pageId, { workspaceId: row.workspaceId, workspaceName: row.workspaceName }) };
      }
    }, signal));
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error); if (auth) return auth;
    if (error instanceof NotionError) return json({ error: error.message, code: error.code }, error.code === "CONFIG" ? 503 : 422);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    return json({ error: "Notion 请求未完成，请重试。 / Notion request did not complete. Retry." }, 500);
  }
}
