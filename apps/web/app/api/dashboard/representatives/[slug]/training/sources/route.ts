import { NextResponse } from "next/server";

import { listCreatorTrainingSources } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import {
  creatorTrainingApiErrorResponse,
  creatorTrainingWriteRetiredResponse,
} from "../errors";
import { toDashboardDevelopmentSourceDto } from "../safe-dto";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const sources = await listCreatorTrainingSources(slug);
    return withPrivateNoStore(
      NextResponse.json({
        sources: sources.map(toDashboardDevelopmentSourceDto),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load development sources.",
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  return creatorTrainingWriteRetiredResponse();
}
