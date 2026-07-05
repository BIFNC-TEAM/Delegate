import { NextResponse } from "next/server";

import { rollbackCreatorTrainingVersion } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../../auth";

type RouteContext = {
  params: Promise<{ slug: string; versionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { slug, versionId } = await context.params;
    const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
    if (accessResponse) {
      return accessResponse;
    }
    const version = await rollbackCreatorTrainingVersion(slug, versionId);

    return NextResponse.json({ version });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to roll back training version." },
      { status: 400 },
    );
  }
}
