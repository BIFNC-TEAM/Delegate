import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { demoRepresentative } from "@delegate/domain";
import { generateRepresentativeReply } from "@delegate/model-runtime";
import { createConversationPlan, renderReplyPreview, resolveConversationSubagent } from "@delegate/runtime";
import {
  acceptInboundConversationMessage,
  AgentWalletReconciliationError,
  buildRepresentativeRuntimeProfile,
  buildWebAudienceExternalUserId,
  getUserAgentWalletBalance,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
  resolvePublicAudienceWalletExternalUserId,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
  ServiceCreditRequiredError,
  type PublicAudiencePrincipal,
} from "@delegate/web-data";

import {
  deriveTierUsage,
  normalizePublicChatRequest,
  resolvePublicChatTier,
} from "../public-chat";
import {
  assertPublicAudienceResourceOwner,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") return publicRuntimeError(runtime.status);

  try {
    const audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
    const { principal, sessionState } = audienceRequest;
    let history = { state: "new", humanActive: false, freeRepliesUsed: 0, messages: [] as Array<unknown> };
    try {
      history = await getPublicConversationHistory({
        representativeSlug: slug,
        audienceIdentityId: principal.audienceIdentityId,
        audienceId: principal.audienceId,
      });
    } catch (error) {
      if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
    }
    const externalUserId = await resolvePublicWalletExternalUserId({
      principal,
      representativeSlug: slug,
    });

    const response = NextResponse.json({
      ...history,
      usage: await derivePublicWalletUsage({
        representativeId: runtime.setup.id,
        externalUserId,
        freeRepliesUsed: history.freeRepliesUsed,
        freeReplyLimit: runtime.setup.contract.freeReplyLimit,
      }),
    });
    response.headers.set("Cache-Control", "private, no-store");
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    const principalError = publicPrincipalErrorResponse(error);
    if (principalError) return principalError;
    const reconciliationError = walletReconciliationErrorResponse(error);
    if (reconciliationError) return reconciliationError;
    throw error;
  }
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

    const { principal, sessionState } =
      await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });

    try {
      const contact = await resolveWebAudienceContact({
        representativeId: runtime.setup.id,
        representativeSlug: slug,
        audienceId: principal.audienceId,
      });
      assertPublicAudienceResourceOwner(
        principal,
        contact.audienceIdentityId,
      );
      const conversation = await resolveWebAudienceConversation({
        representativeId: runtime.setup.id,
        contactId: contact.id,
        audienceId: principal.audienceId,
      });
      assertPublicAudienceResourceOwner(
        principal,
        conversation.audienceIdentityId,
      );
      const clientMessageId =
        body.clientMessageId || `web:${principal.audienceId}:${Date.now()}`;
      const externalUserId = await resolvePublicWalletExternalUserId({
        principal,
        representativeSlug: slug,
      });
      let accepted: Awaited<ReturnType<typeof acceptInboundConversationMessage>>;
      try {
        accepted = await acceptInboundConversationMessage({
          representativeSlug: slug,
          conversationId: conversation.id,
          text: body.message,
          senderId: principal.audienceId,
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
            externalUserId,
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
          setPublicAudienceSessionCookie(
            response,
            request,
            slug,
            sessionState,
          );
          return response;
        }
        throw acceptError;
      }
      const usage = await derivePublicWalletUsage({
        representativeId: runtime.setup.id,
        externalUserId,
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
      setPublicAudienceSessionCookie(
        response,
        request,
        slug,
        sessionState,
      );
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
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    const principalError = publicPrincipalErrorResponse(error);
    if (principalError) return principalError;
    const reconciliationError = walletReconciliationErrorResponse(error);
    if (reconciliationError) return reconciliationError;
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
  externalUserId: string;
  freeRepliesUsed: number;
  freeReplyLimit: number;
}) {
  const balance = process.env.DATABASE_URL?.trim()
    ? await getUserAgentWalletBalance({
        externalUserId: input.externalUserId,
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

async function resolvePublicWalletExternalUserId(input: {
  principal: PublicAudiencePrincipal;
  representativeSlug: string;
}) {
  if (!process.env.DATABASE_URL?.trim()) {
    return buildWebAudienceExternalUserId(
      input.representativeSlug,
      input.principal.audienceId,
    );
  }
  return resolvePublicAudienceWalletExternalUserId({
    audienceIdentityId: input.principal.audienceIdentityId,
    representativeSlug: input.representativeSlug,
    audienceId: input.principal.audienceId,
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

function publicPrincipalErrorResponse(error: unknown) {
  const status = publicAudiencePrincipalErrorStatus(error);
  if (!status) return null;
  return privateJson(
    {
      error:
        status === 401
          ? "Authentication required."
          : "Audience account requires reconciliation.",
    },
    status,
  );
}

function walletReconciliationErrorResponse(error: unknown) {
  if (!(error instanceof AgentWalletReconciliationError)) return null;
  return privateJson(
    {
      error: "Wallet balance requires reconciliation.",
      code: "wallet_reconciliation_required",
    },
    409,
  );
}

function shouldUseNonPersistentDemoChat(error: unknown, representativeSlug: string): boolean {
  return process.env.NODE_ENV !== "production"
    && representativeSlug === demoRepresentative.slug
    && isPrismaUnavailableError(error);
}

function isPrismaUnavailableError(error: unknown): boolean {
  return error instanceof Error && /Can't reach database server|DATABASE_URL|P1001/i.test(error.message);
}
