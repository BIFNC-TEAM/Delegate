import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { generateRepresentativeReply } from "@delegate/model-runtime";
import {
  createConversationPlan,
  renderReplyPreview,
  resolveConversationSubagent,
} from "@delegate/runtime";
import {
  getRepresentativeSetupSnapshot,
  loadWebConversationRecentTurns,
  persistWebConversationExchange,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
} from "@delegate/web-data";

import {
  appendPublicChatTurns,
  buildPublicChatRepresentative,
  deriveTierUsage,
  getPublicChatCookieName,
  normalizePublicChatRequest,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  PUBLIC_CHAT_EFFECTIVE_TIER,
  readPublicChatSessionState,
  type PublicChatResponse,
  writePublicChatSessionState,
} from "../public-chat";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const body = normalizePublicChatRequest(await request.json());
    if (!body.message) {
      return NextResponse.json(
        { error: "Message is required." },
        { status: 400 },
      );
    }

    const setup = await getRepresentativeSetupSnapshot(slug);
    if (!setup) {
      return NextResponse.json(
        { error: `Representative "${slug}" not found.` },
        { status: 404 },
      );
    }

    const cookieStore = await cookies();
    const sessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const contact = await resolveWebAudienceContact({
      representativeId: setup.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    const conversation = await resolveWebAudienceConversation({
      representativeId: setup.id,
      contactId: contact.id,
      audienceId: sessionState.audienceId,
    });
    const representative = buildPublicChatRepresentative(setup);
    const recentTurns = await loadWebConversationRecentTurns({
      conversationId: conversation.id,
    });
    const usage = deriveTierUsage({
      freeRepliesUsed: conversation.freeRepliesUsed,
      freeReplyLimit: representative.contract.freeReplyLimit,
    });

    const plan = createConversationPlan({
      text: body.message,
      channel: "private_chat",
      representative,
      usage,
    });
    const subagent = resolveConversationSubagent(plan);

    let replyText = renderReplyPreview(representative, plan);
    const response: PublicChatResponse = {
      reply: {
        role: "assistant",
        text: replyText,
      },
      plan: {
        intent: plan.intent,
        nextStep: plan.nextStep,
        ...(plan.suggestedPlan ? { suggestedPlan: plan.suggestedPlan } : {}),
        reasons: plan.reasons,
      },
      tier: PUBLIC_CHAT_EFFECTIVE_TIER,
      usage,
      runtime: {
        usedModel: false,
      },
    };

    if (plan.nextStep === "answer") {
      const generated = await generateRepresentativeReply({
        representative,
        plan,
        subagent,
        userText: body.message,
        recalled: [],
        recentTurns,
        collectorState: null,
      });

      if (generated.ok) {
        response.reply.text = generated.replyText;
        response.runtime = {
          usedModel: true,
          provider: generated.provider,
          model: generated.model,
        };
      } else {
        response.runtime = {
          usedModel: false,
          fallbackReason: generated.reason,
        };
      }
    }

    const nextSessionState = appendPublicChatTurns({
      state: sessionState,
      userMessage: body.message,
      assistantMessage: response.reply.text,
      nextStep: response.plan.nextStep,
    });
    const updatedConversation = await persistWebConversationExchange({
      conversationId: conversation.id,
      userMessage: body.message,
      assistantMessage: response.reply.text,
      intent: response.plan.intent,
      nextStep: response.plan.nextStep,
    });
    response.usage = deriveTierUsage({
      freeRepliesUsed: updatedConversation.freeRepliesUsed,
      freeReplyLimit: representative.contract.freeReplyLimit,
    });
    const nextResponse = NextResponse.json(response);
    nextResponse.cookies.set(
      getPublicChatCookieName(slug),
      writePublicChatSessionState({
        representativeSlug: slug,
        state: nextSessionState,
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: `/reps/${slug}`,
      },
    );

    return nextResponse;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate representative reply.",
      },
      { status: 500 },
    );
  }
}
