import { NextResponse } from "next/server";

import {
  createCreatorFeedbackSignal,
  listCreatorFeedbackSignals,
} from "@delegate/web-data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limitValue = Number(url.searchParams.get("limit") ?? 50);
    const feedbackSignals = await listCreatorFeedbackSignals(slug, {
      ...(status ? { status } : {}),
      limit: Number.isFinite(limitValue) ? limitValue : 50,
    });

    return NextResponse.json({ feedbackSignals });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load creator feedback signals.",
      },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const feedbackSignal = await createCreatorFeedbackSignal(slug, {
      signalType: String(body.signalType ?? ""),
      ...(typeof body.contactId === "string" ? { contactId: body.contactId } : {}),
      ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
      ...(typeof body.publicSafe === "boolean" ? { publicSafe: body.publicSafe } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(typeof body.suggestedText === "string" ? { suggestedText: body.suggestedText } : {}),
      ...(typeof body.createdBy === "string" ? { createdBy: body.createdBy } : {}),
    });

    return NextResponse.json({ feedbackSignal }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create creator feedback signal.",
      },
      { status: 400 },
    );
  }
}
