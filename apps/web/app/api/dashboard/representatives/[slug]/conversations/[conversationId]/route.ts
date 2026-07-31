import { NextResponse } from "next/server";

import {
  addConversationInternalNote,
  assignConversationOperator,
  getConversationDetailSnapshot,
  markConversationRead,
  returnConversationToAi,
  sendOperatorConversationMessage,
  setConversationResolution,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string }> },
) {
  const { slug, conversationId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const detail = await getConversationDetailSnapshot(
      slug,
      conversationId,
      session?.ownerId,
    );
    if (!detail) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load conversation." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string }> },
) {
  const { slug, conversationId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = (await request.json()) as {
      action?: "assign" | "return_to_ai" | "mark_read" | "resolve" | "reopen";
      operatorName?: string;
      handoffSummary?: string;
    };
    const operatorId = session?.ownerId || "local-owner";
    const operatorName = body.operatorName?.trim() || "Owner";

    if (body.action === "assign") {
      const assignment = await assignConversationOperator({
        representativeSlug: slug,
        conversationId,
        operatorId,
        operatorName,
      });
      return NextResponse.json({ assignment });
    }

    if (body.action === "return_to_ai") {
      const result = await returnConversationToAi({
        representativeSlug: slug,
        conversationId,
        operatorId,
        ...(body.handoffSummary ? { handoffSummary: body.handoffSummary } : {}),
      });
      return NextResponse.json(result);
    }

    if (body.action === "mark_read") {
      const result = await markConversationRead({
        representativeSlug: slug,
        conversationId,
        operatorId,
      });
      return NextResponse.json(result);
    }

    if (body.action === "resolve" || body.action === "reopen") {
      const result = await setConversationResolution({
        representativeSlug: slug,
        conversationId,
        operatorId,
        resolved: body.action === "resolve",
        ...(body.handoffSummary ? { reason: body.handoffSummary } : {}),
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Unsupported conversation action." }, { status: 400 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (
        error.code === "ACTIVE_DELEGATION_TASK"
        || error.code === "CONVERSATION_WORK_IN_FLIGHT"
      )
    ) {
      const code = error.code;
      return NextResponse.json(
        {
          error: error instanceof Error
            ? error.message
            : "An active delegation task must finish before operator takeover.",
          code,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string }> },
) {
  const { slug, conversationId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = (await request.json()) as {
      kind?: "reply" | "note";
      text?: string;
      operatorName?: string;
      clientMessageId?: string;
    };
    const operatorId = session?.ownerId || "local-owner";
    const operatorName = body.operatorName?.trim() || "Owner";
    if (body.kind === "reply") {
      const message = await sendOperatorConversationMessage({
        representativeSlug: slug,
        conversationId,
        operatorId,
        operatorName,
        text: body.text || "",
        ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
      });
      return NextResponse.json({ message }, { status: 201 });
    }
    if (body.kind === "note") {
      const note = await addConversationInternalNote({
        representativeSlug: slug,
        conversationId,
        authorId: operatorId,
        authorName: operatorName,
        text: body.text || "",
      });
      return NextResponse.json({ note }, { status: 201 });
    }
    return NextResponse.json({ error: "Unsupported conversation message kind." }, { status: 400 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation." },
      { status: 500 },
    );
  }
}
