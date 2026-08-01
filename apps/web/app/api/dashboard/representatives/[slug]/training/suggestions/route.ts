import { NextResponse } from "next/server";

import {
  buildCreatorTrainingSuggestions,
  listCreatorTrainingSuggestions,
  type CreatorTrainingSuggestionStatus,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../errors";
import { toDashboardDevelopmentSuggestionDto } from "../safe-dto";


const suggestionStatuses = new Set([
  "pending",
  "approved",
  "rejected",
  "private",
  "published",
  "superseded",
]);

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
    const status = url.searchParams.get("status");
    const limitValue = Number(url.searchParams.get("limit") ?? 50);
    const suggestions = await listCreatorTrainingSuggestions(slug, {
      ...(status && suggestionStatuses.has(status)
        ? { status: status as CreatorTrainingSuggestionStatus }
        : {}),
      limit: Number.isFinite(limitValue) ? limitValue : 50,
    });

    return withPrivateNoStore(
      NextResponse.json({
        suggestions: suggestions.map(toDashboardDevelopmentSuggestionDto),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load development suggestions.",
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

  try {
    const suggestions = await buildCreatorTrainingSuggestions(slug);
    return withPrivateNoStore(
      NextResponse.json(
        {
          suggestions: suggestions.map(toDashboardDevelopmentSuggestionDto),
        },
        { status: 201 },
      ),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to build development suggestions.",
    );
  }
}
