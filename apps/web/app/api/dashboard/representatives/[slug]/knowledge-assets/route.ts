import { after, NextResponse } from "next/server";

import {
  listKnowledgeAssets,
  processKnowledgeAsset,
  resolveKnowledgeLibraryOwnerId,
  setRepresentativeKnowledgeAssetBindings,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../auth";
import { knowledgeErrorResponse } from "../../../knowledge-assets/route";

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const session = await requireDashboardRepresentativeAccess(slug);
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, slug);
    const assets = await listKnowledgeAssets(ownerId);
    return NextResponse.json({ assets });
  } catch (error) {
    return representativeKnowledgeErrorResponse(error, "Failed to load representative knowledge assets.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const session = await requireDashboardRepresentativeAccess(slug);
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, slug);
    const body = (await request.json()) as { assetIds?: unknown };
    const result = await setRepresentativeKnowledgeAssetBindings(ownerId, slug, body.assetIds);

    if (result.changedAssetIds.length) {
      after(async () => {
        for (const assetId of result.changedAssetIds) {
          try {
            await processKnowledgeAsset(ownerId, assetId, {
              staleRepresentativeSlugs: [slug],
            });
          } catch (error) {
            console.error(`Failed to synchronize representative knowledge asset ${assetId}.`, error);
          }
        }
      });
    }

    return NextResponse.json({
      ...result,
      assets: await listKnowledgeAssets(ownerId),
      indexingQueued: result.changedAssetIds.length,
    });
  } catch (error) {
    return representativeKnowledgeErrorResponse(error, "Failed to update representative knowledge assets.");
  }
}

function representativeKnowledgeErrorResponse(error: unknown, fallback: string) {
  const authResponse = dashboardAuthErrorResponse(error);
  return authResponse ?? knowledgeErrorResponse(error, fallback);
}
