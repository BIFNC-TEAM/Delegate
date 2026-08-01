import { NextResponse } from "next/server";

import { enqueueCreatorTrainingReviewWorkflow } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../errors";
import { toDashboardDevelopmentWorkflowDto } from "../safe-dto";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
    if (accessResponse) {
      return withPrivateNoStore(accessResponse);
    }
    const body = (await request.json().catch(() => ({}))) as {
      feedbackLimit?: number;
      unknownQuestionLimit?: number;
    };
    const workflow = await enqueueCreatorTrainingReviewWorkflow(slug, {
      ...(typeof body.feedbackLimit === "number" ? { feedbackLimit: body.feedbackLimit } : {}),
      ...(typeof body.unknownQuestionLimit === "number"
        ? { unknownQuestionLimit: body.unknownQuestionLimit }
        : {}),
    });

    return withPrivateNoStore(
      NextResponse.json(
        { workflow: toDashboardDevelopmentWorkflowDto(workflow) },
        { status: 202 },
      ),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to queue the development organization run.",
    );
  }
}
