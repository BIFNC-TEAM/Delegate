import { NextResponse } from "next/server";

import {
  reviewCreatorTrainingSuggestion,
  type CreatorTrainingReviewAction,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccessActor,
} from "../../../../../auth";
import { withPrivateNoStore } from "../../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../../errors";
import {
  toDashboardDevelopmentSuggestionDto,
  toDashboardDevelopmentVersionDto,
} from "../../safe-dto";


const reviewActions = new Set(["approve", "reject", "private"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; suggestionId: string }> },
) {
  const { slug, suggestionId } = await params;

  try {
    const actor = await requireDashboardRepresentativeAccessActor(slug);
    const body = (await request.json()) as Record<string, unknown>;
    const action =
      typeof body.action === "string" && reviewActions.has(body.action)
        ? (body.action as CreatorTrainingReviewAction)
        : null;
    if (!action) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Unsupported review action." }, { status: 400 }),
      );
    }

    const result = await reviewCreatorTrainingSuggestion(slug, suggestionId, {
      action,
      reviewedBy: actor,
      ...(typeof body.reviewNote === "string" ? { reviewNote: body.reviewNote } : {}),
      ...(body.editedDraftPayload !== undefined
        ? { editedDraftPayload: body.editedDraftPayload }
        : {}),
    });

    return withPrivateNoStore(
      NextResponse.json({
        suggestion: toDashboardDevelopmentSuggestionDto(result.suggestion),
        version: result.version
          ? toDashboardDevelopmentVersionDto(result.version)
          : null,
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to review the development suggestion.",
    );
  }
}
