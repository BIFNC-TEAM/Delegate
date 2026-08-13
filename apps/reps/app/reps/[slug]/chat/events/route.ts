import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  AgentWalletReconciliationError,
  buildWebAudienceExternalUserId,
  getUserAgentWalletBalance,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
  resolvePublicAudienceWalletExternalUserId,
} from "@delegate/web-data";

import {
  deriveTierUsage,
} from "../../public-chat";
import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../public-principal";

const encoder = new TextEncoder();
const PRINCIPAL_REVALIDATION_INTERVAL_MS = 2_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") {
    return new Response(JSON.stringify({ error: "Representative is not publicly available." }), {
      status: runtime.status === "paused" ? 423 : 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  let audienceRequest: Awaited<
    ReturnType<typeof resolvePublicAudienceRequestPrincipal>
  >;
  let externalUserId: string;
  let initialServiceBalance: Awaited<
    ReturnType<typeof getUserAgentWalletBalance>
  > = null;
  try {
    audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
    externalUserId = process.env.DATABASE_URL?.trim()
      ? await resolvePublicAudienceWalletExternalUserId({
          audienceIdentityId:
            audienceRequest.principal.audienceIdentityId,
          representativeSlug: slug,
          audienceId: audienceRequest.principal.audienceId,
        })
      : buildWebAudienceExternalUserId(
          slug,
          audienceRequest.principal.audienceId,
        );
    if (process.env.DATABASE_URL?.trim()) {
      initialServiceBalance = await getUserAgentWalletBalance({
        externalUserId,
        representativeId: runtime.setup.id,
      });
    }
  } catch (error) {
    if (error instanceof AgentWalletReconciliationError) {
      return NextResponse.json(
        {
          error: "Wallet balance requires reconciliation.",
          code: "wallet_reconciliation_required",
        },
        {
          status: 409,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    const status = publicAudiencePrincipalErrorStatus(error);
    if (!status) throw error;
    return NextResponse.json(
      {
        error:
          status === 401
            ? "Authentication required."
            : "Audience account requires reconciliation.",
      },
      {
        status,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  const { principal, revalidate, sessionState } = audienceRequest;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let previous = "";
      let serviceBalance = initialServiceBalance;
      let nextBalanceRefreshAt = Date.now() + 2_000;
      let nextPrincipalRevalidationAt = 0;
      try {
        while (!request.signal.aborted) {
          if (Date.now() >= nextPrincipalRevalidationAt) {
            await revalidate();
            nextPrincipalRevalidationAt =
              Date.now() + PRINCIPAL_REVALIDATION_INTERVAL_MS;
          }
          const history = await getPublicConversationHistory({
            representativeSlug: slug,
            audienceIdentityId: principal.audienceIdentityId,
            audienceId: principal.audienceId,
          });
          if (
            process.env.DATABASE_URL?.trim()
            && Date.now() >= nextBalanceRefreshAt
          ) {
            serviceBalance = await getUserAgentWalletBalance({
              externalUserId,
              representativeId: runtime.setup.id,
            });
            nextBalanceRefreshAt = Date.now() + 2_000;
          }
          const snapshot = {
            ...history,
            usage: {
              ...deriveTierUsage({
                freeRepliesUsed: history.freeRepliesUsed,
                freeReplyLimit:
                  runtime.accessMode === "CREDITS_ONLY"
                    ? 0
                    : runtime.setup.contract.freeReplyLimit,
                serviceCreditsAvailable:
                  serviceBalance?.availableTokenAmount ?? 0,
                serviceCreditsReserved:
                  serviceBalance?.reservedTokenAmount ?? 0,
                serviceCreditsPurchased:
                  serviceBalance?.totalPurchasedTokenAmount ?? 0,
              }),
              accessMode: runtime.accessMode,
              unlimitedFreeAccess: runtime.accessMode === "FREE",
            },
          };
          const serialized = JSON.stringify(snapshot);
          if (serialized !== previous) {
            previous = serialized;
            controller.enqueue(encoder.encode(`event: conversation\ndata: ${serialized}\n\n`));
          } else {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
          await wait(500, request.signal);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
            error: "stream_failed",
          })}\n\n`));
          console.error("Public conversation event stream failed.", error);
        }
      } finally {
        controller.close();
      }
    },
  });

  const response = new NextResponse(stream, {
    headers: {
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
  setPublicAudienceSessionCookie(
    response,
    request,
    slug,
    sessionState,
  );
  return response;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
