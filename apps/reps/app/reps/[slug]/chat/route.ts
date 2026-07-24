import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { demoRepresentative } from "@delegate/domain";
import { generateRepresentativeReply } from "@delegate/model-runtime";
import { createConversationPlan, renderReplyPreview, resolveConversationSubagent } from "@delegate/runtime";
import {
  acceptInboundConversationMessage,
  buildRepresentativeRuntimeProfile,
  buildWebAudienceKey,
  buildWebAudienceExternalUserId,
  getUserAgentWalletBalance,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
  ServiceCreditRequiredError,
} from "@delegate/web-data";

import {
  deriveTierUsage,
  getPublicChatCookieName,
  normalizePublicChatRequest,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  resolvePublicChatTier,
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
    usage: await derivePublicWalletUsage({
      representativeId: runtime.setup.id,
      representativeSlug: slug,
      audienceId: session.audienceId,
      freeRepliesUsed: history.freeRepliesUsed,
      freeReplyLimit: runtime.setup.contract.freeReplyLimit,
    }),
  });
  response.headers.set("Cache-Control", "private, no-store");
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
    if (!body.message) return privateJson({ error: "Message is required." }, 400);

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
      const clientMessageId =
        body.clientMessageId || `web:${session.audienceId}:${Date.now()}`;
      const externalUserId = buildWebAudienceExternalUserId(
        slug,
        session.audienceId,
      );
      let accepted: Awaited<ReturnType<typeof acceptInboundConversationMessage>>;
      try {
        accepted = await acceptInboundConversationMessage({
          representativeSlug: slug,
          conversationId: conversation.id,
          text: body.message,
          senderId: session.audienceId,
          senderDisplayName: "Web visitor",
          clientMessageId,
          channel: "web",
          walletBilling: {
            externalUserId,
            representativeId: runtime.setup.id,
            freeReplyLimit: runtime.setup.contract.freeReplyLimit,
            tokenAmount: 1,
            idempotencyKey: `public_chat:${conversation.id}:${clientMessageId}:reserve`,
          },
        });
      } catch (acceptError) {
        if (acceptError instanceof ServiceCreditRequiredError) {
          const usage = await derivePublicWalletUsage({
            representativeId: runtime.setup.id,
            representativeSlug: slug,
            audienceId: session.audienceId,
            freeRepliesUsed: acceptError.effectiveFreeRepliesUsed,
            freeReplyLimit: runtime.setup.contract.freeReplyLimit,
          });
          const response = privateJson(
            {
              error: acceptError.message,
              code: "service_credit_required",
              tier: resolvePublicChatTier(usage),
              usage,
            },
            402,
          );
          setPublicChatCookie(response, request, slug, session);
          return response;
        }
        throw acceptError;
      }
      const usage = await derivePublicWalletUsage({
        representativeId: runtime.setup.id,
        representativeSlug: slug,
        audienceId: session.audienceId,
        freeRepliesUsed: conversation.freeRepliesUsed,
        freeReplyLimit: runtime.setup.contract.freeReplyLimit,
      });
      const response = NextResponse.json(
        {
          status: accepted.heldForOperator ? "waiting_human" : "queued",
          heldForOperator: accepted.heldForOperator,
          ...(accepted.run ? { runId: accepted.run.id } : {}),
          tier: resolvePublicChatTier(usage),
          usage,
        },
        { status: 202 },
      );
      response.headers.set("Cache-Control", "private, no-store");
      setPublicChatCookie(response, request, slug, session);
      return response;
    } catch (error) {
      if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
    }

    const representative = buildRepresentativeRuntimeProfile(runtime.setup);
    const usage = deriveTierUsage({
      freeRepliesUsed: 0,
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
      tier: resolvePublicChatTier(usage),
      usage,
    });
    response.headers.set("Cache-Control", "private, no-store");
    setPublicChatCookie(response, request, slug, session);
    return response;
  } catch (error) {
    console.error("Failed to accept public chat message.", error);
    return NextResponse.json(
      { error: "Failed to accept chat message." },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}

async function derivePublicWalletUsage(input: {
  representativeId: string;
  representativeSlug: string;
  audienceId: string;
  freeRepliesUsed: number;
  freeReplyLimit: number;
}) {
  const balance = process.env.DATABASE_URL?.trim()
    ? await getUserAgentWalletBalance({
        externalUserId: buildWebAudienceExternalUserId(
          input.representativeSlug,
          input.audienceId,
        ),
        representativeId: input.representativeId,
      })
    : null;
  return deriveTierUsage({
    freeRepliesUsed: input.freeRepliesUsed,
    freeReplyLimit: input.freeReplyLimit,
    serviceCreditsAvailable: balance?.availableTokenAmount ?? 0,
    serviceCreditsReserved: balance?.reservedTokenAmount ?? 0,
  });
}

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
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
