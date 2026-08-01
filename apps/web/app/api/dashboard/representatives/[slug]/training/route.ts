import { NextResponse } from "next/server";

import { getCreatorTrainingDashboardSnapshot } from "@delegate/web-data";

import {
  authorizeDashboardRepresentativeAccess,
  dashboardAuthErrorResponse,
} from "../../../auth";
import { withPrivateNoStore } from "../../../../private-response";
import { creatorTrainingApiErrorResponse } from "./errors";
import { toDashboardRepresentativeDevelopmentDto } from "./safe-dto";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const snapshot = await getCreatorTrainingDashboardSnapshot(slug);
    return withPrivateNoStore(
      NextResponse.json(toDashboardRepresentativeDevelopmentDto(snapshot)),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load representative development.",
    );
  }
}
