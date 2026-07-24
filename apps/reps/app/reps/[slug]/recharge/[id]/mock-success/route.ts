import { NextResponse } from "next/server";

import {
  buildWebAudienceExternalUserId,
  completeMockRechargeAndPurchaseAgentTokens,
  getPublicRepresentativeRuntime,
  prisma,
} from "@delegate/web-data";

import { cookies } from "next/headers";
import {
  getPublicChatCookieName,
  readPublicChatSessionState,
} from "../../../public-chat";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return privateJson({ error: "Not found." }, 404);
  }

  const { slug, id } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return privateJson(
        { error: "Representative is not publicly available." },
        runtime.status === "paused" ? 423 : 404,
      );
    }

    const cookieStore = await cookies();
    const sessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const expectedExternalUserId = buildWebAudienceExternalUserId(
      slug,
      sessionState.audienceId,
    );
    const rechargeOrder = await prisma.rechargeOrder.findUnique({
      where: { id },
      select: {
        userWallet: {
          select: {
            externalUserId: true,
          },
        },
      },
    });
    if (rechargeOrder?.userWallet.externalUserId !== expectedExternalUserId) {
      return privateJson({ error: "Recharge order not found." }, 404);
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: id,
      externalUserId: expectedExternalUserId,
      representativeId: runtime.setup.id,
      ...(typeof body.amountCents === "number"
        ? { amountCents: body.amountCents }
        : {}),
      ...(typeof body.providerEventId === "string" && body.providerEventId.trim()
        ? { providerEventId: body.providerEventId.trim() }
        : {}),
      purchaseIdempotencyKey: `public_token_purchase:${id}`,
    });

    return privateJson(result, 200);
  } catch (error) {
    console.error("Failed to complete public mock recharge.", error);
    return privateJson(
      {
        error: "模拟支付确认失败，请刷新后重试；如果问题持续，请联系代表主人检查支付配置。",
      },
      400,
    );
  }
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
