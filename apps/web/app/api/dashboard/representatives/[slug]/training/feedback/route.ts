import { NextResponse } from "next/server";

import { listCreatorFeedbackSignals } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import {
  creatorTrainingApiErrorResponse,
  creatorTrainingWriteRetiredResponse,
} from "../errors";
import { toDashboardDevelopmentFeedbackDto } from "../safe-dto";

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
    const status = url.searchParams.get("status") ?? undefined;
    const limitValue = Number(url.searchParams.get("limit") ?? 50);
    const feedbackSignals = await listCreatorFeedbackSignals(slug, {
      ...(status ? { status } : {}),
      limit: Number.isFinite(limitValue) ? limitValue : 50,
    });

    return withPrivateNoStore(
      NextResponse.json({
        feedbackSignals: feedbackSignals.map(
          toDashboardDevelopmentFeedbackDto,
        ),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load representative feedback.",
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
