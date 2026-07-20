import { NextResponse } from "next/server";
import { z } from "zod";

import { archiveKnowledgeAsset, processKnowledgeAsset, resolveKnowledgeLibraryOwnerId } from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../../auth";
import { knowledgeErrorResponse } from "../../route";

const actionSchema = z.object({ action: z.enum(["reprocess", "archive", "restore"]) });
type RouteContext = { params: Promise<{ assetId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const { assetId } = await context.params;
    const { action } = actionSchema.parse(await request.json());
    const asset = action === "reprocess"
      ? await processKnowledgeAsset(ownerId, assetId)
      : await archiveKnowledgeAsset(ownerId, assetId, action === "archive");
    return NextResponse.json({ asset });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to run knowledge action.");
  }
}
