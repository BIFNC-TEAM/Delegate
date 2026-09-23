import { after, NextResponse } from "next/server";
import { processKnowledgeAsset, replaceFailedKnowledgeUrlWithBrowserCapture, resolveKnowledgeLibraryOwnerId } from "@delegate/web-data";
import { requireDashboardApiOwnerSession } from "../../../auth";
import { knowledgeErrorResponse } from "../../route";

type RouteContext = { params: Promise<{ assetId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const { assetId } = await context.params;
    const asset = await replaceFailedKnowledgeUrlWithBrowserCapture(ownerId, assetId, await request.json());
    after(async () => { await processKnowledgeAsset(ownerId, assetId); });
    return NextResponse.json({ asset }, { status: 202 });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to import browser capture.");
  }
}
