import { NextResponse } from "next/server";

import { listCreatorTrainingVersions } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../errors";
import { toDashboardDevelopmentVersionDto } from "../safe-dto";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const url = new URL(request.url);
    const limitValue = Number(url.searchParams.get("limit") ?? 20);
    const versions = await listCreatorTrainingVersions(slug, {
      limit: Number.isFinite(limitValue) ? limitValue : 20,
    });

    return withPrivateNoStore(
      NextResponse.json({
        versions: versions.map(toDashboardDevelopmentVersionDto),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load development revisions.",
    );
  }
}
