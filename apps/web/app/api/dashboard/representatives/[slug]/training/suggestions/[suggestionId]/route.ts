import { NextResponse } from "next/server";

import {
  reviewCreatorTrainingSuggestion,
  type CreatorTrainingReviewAction,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../auth";


const reviewActions = new Set(["approve", "reject", "private"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; suggestionId: string }> },
) {
  const { slug, suggestionId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action =
      typeof body.action === "string" && reviewActions.has(body.action)
        ? (body.action as CreatorTrainingReviewAction)
        : null;
    if (!action) {
      return NextResponse.json({ error: "Unsupported review action." }, { status: 400 });
    }

    const result = await reviewCreatorTrainingSuggestion(slug, suggestionId, {
      action,
      ...(typeof body.reviewedBy === "string" ? { reviewedBy: body.reviewedBy } : {}),
      ...(typeof body.reviewNote === "string" ? { reviewNote: body.reviewNote } : {}),
      ...(body.editedDraftPayload !== undefined
        ? { editedDraftPayload: body.editedDraftPayload }
        : {}),
      ...(body.evaluationReport !== undefined ? { evaluationReport: body.evaluationReport } : {}),
    });

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to review creator training suggestion.",
      },
      { status: 400 },
    );
  }
}
