import { NextResponse } from "next/server";

import { enqueueCreatorTrainingReviewWorkflow } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
    if (accessResponse) {
      return accessResponse;
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

    return NextResponse.json({ workflow }, { status: 202 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to enqueue training workflow." },
      { status: 400 },
    );
  }
}
