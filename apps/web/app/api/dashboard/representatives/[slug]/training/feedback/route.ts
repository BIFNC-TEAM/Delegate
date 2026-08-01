import { NextResponse } from "next/server";

import {
  createCreatorFeedbackSignal,
  listCreatorFeedbackSignals,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccessActor,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../errors";
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
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const actor = await requireDashboardRepresentativeAccessActor(slug);
    const body = (await request.json()) as Record<string, unknown>;
    const feedbackSignal = await createCreatorFeedbackSignal(slug, {
      signalType: String(body.signalType ?? ""),
      ...(typeof body.contactId === "string" ? { contactId: body.contactId } : {}),
      ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
      ...(typeof body.publicSafe === "boolean" ? { publicSafe: body.publicSafe } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(typeof body.suggestedText === "string" ? { suggestedText: body.suggestedText } : {}),
      createdBy: actor,
    });

    return withPrivateNoStore(
      NextResponse.json(
        {
          feedbackSignal: toDashboardDevelopmentFeedbackDto(feedbackSignal),
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
      "Failed to create representative feedback.",
    );
  }
}
