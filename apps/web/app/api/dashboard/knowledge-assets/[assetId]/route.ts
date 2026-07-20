import { NextResponse } from "next/server";

import {
  deleteKnowledgeAsset,
  getKnowledgeAsset,
  resolveKnowledgeLibraryOwnerId,
  updateKnowledgeAsset,
} from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../auth";
import { knowledgeErrorResponse } from "../route";

type RouteContext = { params: Promise<{ assetId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const { assetId } = await context.params;
    return NextResponse.json({ asset: await getKnowledgeAsset(ownerId, assetId) });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to load knowledge details.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const { assetId } = await context.params;
    const body = await request.json();
    return NextResponse.json({ asset: await updateKnowledgeAsset(ownerId, assetId, body) });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to update knowledge.");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const { assetId } = await context.params;
    await deleteKnowledgeAsset(ownerId, assetId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to delete knowledge.");
  }
}
