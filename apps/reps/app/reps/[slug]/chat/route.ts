import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { demoRepresentative } from "@delegate/domain";
import { generateRepresentativeReply } from "@delegate/model-runtime";
import { createConversationPlan, renderReplyPreview, resolveConversationSubagent } from "@delegate/runtime";
import {
  acceptInboundConversationMessage,
  buildRepresentativeRuntimeProfile,
  buildWebAudienceKey,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
} from "@delegate/web-data";

import {
  deriveTierUsage,
  getPublicChatCookieName,
  normalizePublicChatRequest,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  PUBLIC_CHAT_EFFECTIVE_TIER,
  readPublicChatSessionState,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../public-chat";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") return publicRuntimeError(runtime.status);

  const cookieStore = await cookies();
  const session = readPublicChatSessionState({
    representativeSlug: slug,
    cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
  });
  let history = { state: "new", humanActive: false, freeRepliesUsed: 0, messages: [] as Array<unknown> };
  try {
    history = await getPublicConversationHistory({
      representativeSlug: slug,
      audienceKey: buildWebAudienceKey(session.audienceId),
    });
  } catch (error) {
    if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
  }

  const response = NextResponse.json({
    ...history,
    usage: deriveTierUsage({
      freeRepliesUsed: history.freeRepliesUsed,
      freeReplyLimit: runtime.setup.contract.freeReplyLimit,
    }),
  });
  setPublicChatCookie(response, request, slug, session);
  return response;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return publicRuntimeError(runtime.status);
    const body = normalizePublicChatRequest(await request.json());
    if (!body.message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    const cookieStore = await cookies();
    const session = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });

    try {
      const contact = await resolveWebAudienceContact({
        representativeId: runtime.setup.id,
        representativeSlug: slug,
        audienceId: session.audienceId,
      });
      const conversation = await resolveWebAudienceConversation({
        representativeId: runtime.setup.id,
        contactId: contact.id,
        audienceId: session.audienceId,
      });
      const accepted = await acceptInboundConversationMessage({
        representativeSlug: slug,
        conversationId: conversation.id,
        text: body.message,
        senderId: session.audienceId,
        senderDisplayName: "Web visitor",
        clientMessageId: body.clientMessageId || `web:${session.audienceId}:${Date.now()}`,
        channel: "web",
      });
      const response = NextResponse.json(
        {
          status: accepted.heldForOperator ? "waiting_human" : "queued",
          heldForOperator: accepted.heldForOperator,
          ...(accepted.run ? { runId: accepted.run.id } : {}),
          tier: PUBLIC_CHAT_EFFECTIVE_TIER,
          usage: deriveTierUsage({
            freeRepliesUsed: conversation.freeRepliesUsed,
            freeReplyLimit: runtime.setup.contract.freeReplyLimit,
          }),
        },
        { status: 202 },
      );
      setPublicChatCookie(response, request, slug, session);
      return response;
    } catch (error) {
      if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
    }

    const representative = buildRepresentativeRuntimeProfile(runtime.setup);
    const usage = deriveTierUsage({ freeRepliesUsed: 0, freeReplyLimit: representative.contract.freeReplyLimit });
    const plan = createConversationPlan({
      text: body.message,
      channel: "private_chat",
      representative,
      usage,
    });
    const subagent = resolveConversationSubagent(plan);
    let replyText = renderReplyPreview(representative, plan);
    if (plan.nextStep === "answer") {
      const generated = await generateRepresentativeReply({
        representative,
        plan,
        subagent,
        userText: body.message,
        recalled: [],
        recentTurns: [],
        collectorState: null,
      });
      if (generated.ok) replyText = generated.replyText;
    }
    const response = NextResponse.json({
      status: "completed",
      reply: { role: "assistant", text: replyText },
      tier: PUBLIC_CHAT_EFFECTIVE_TIER,
      usage,
    });
    setPublicChatCookie(response, request, slug, session);
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to accept chat message." },
      { status: 500 },
    );
  }
}

function publicRuntimeError(status: Exclude<Awaited<ReturnType<typeof getPublicRepresentativeRuntime>>["status"], "available">) {
  if (status === "not_found") return NextResponse.json({ error: "Representative not found." }, { status: 404 });
  if (status === "paused") return NextResponse.json({ error: "This representative is temporarily paused." }, { status: 423 });
  return NextResponse.json({ error: "This representative is not publicly available." }, { status: 404 });
}

function setPublicChatCookie(
  response: NextResponse,
  request: Request,
  slug: string,
  session: ReturnType<typeof readPublicChatSessionState>,
) {
  response.cookies.set(getPublicChatCookieName(slug), writePublicChatSessionState({ representativeSlug: slug, state: session }), {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecurePublicChatCookie(request),
    maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
    path: `/reps/${slug}`,
  });
}

function shouldUseNonPersistentDemoChat(error: unknown, representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && isPrismaUnavailableError(error);
}

function isPrismaUnavailableError(error: unknown): boolean {
  return error instanceof Error && /Can't reach database server|DATABASE_URL|P1001/i.test(error.message);
}
