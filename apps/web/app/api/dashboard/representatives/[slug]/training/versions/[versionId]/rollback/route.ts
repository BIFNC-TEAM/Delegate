import { NextResponse } from "next/server";

import { rollbackCreatorTrainingVersion } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccessActor,
} from "../../../../../../auth";
import { withPrivateNoStore } from "../../../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../../../errors";
import { toDashboardDevelopmentVersionDto } from "../../../safe-dto";

type RouteContext = {
  params: Promise<{ slug: string; versionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { slug, versionId } = await context.params;
    const actor = await requireDashboardRepresentativeAccessActor(slug);
    const version = await rollbackCreatorTrainingVersion(slug, versionId, {
      rolledBackBy: actor,
    });

    return withPrivateNoStore(
      NextResponse.json({
        version: toDashboardDevelopmentVersionDto(version),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to revert the development revision.",
    );
  }
}
