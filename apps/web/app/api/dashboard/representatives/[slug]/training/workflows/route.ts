import { NextResponse } from "next/server";

import { enqueueCreatorTrainingReviewWorkflow } from "@delegate/web-data";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to enqueue training workflow." },
      { status: 400 },
    );
  }
}
