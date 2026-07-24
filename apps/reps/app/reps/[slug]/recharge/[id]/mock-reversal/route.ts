import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildWebAudienceExternalUserId,
  getPublicRepresentativeRuntime,
  getUserAgentWalletBalance,
  prisma,
  reverseAgentTokenPurchase,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  readPublicChatSessionState,
} from "../../../public-chat";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return privateJson({ error: "Not found." }, 404);
  }

  const { slug, id: rechargeOrderId } = await params;
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
    const externalUserId = buildWebAudienceExternalUserId(
      slug,
      sessionState.audienceId,
    );
    const purchase = await prisma.agentTokenPurchase.findFirst({
      where: {
        rechargeOrderId,
        representativeId: runtime.setup.id,
        userWallet: {
          externalUserId,
        },
      },
      select: { id: true },
    });
    if (!purchase) {
      return privateJson({ error: "Recharge purchase not found." }, 404);
    }

    const reversal = await reverseAgentTokenPurchase(purchase.id, {
      reason: "public_demo_unused_credit_reversal",
      idempotencyKey: `public_demo_reversal:${purchase.id}`,
    });
    const walletBalance = await getUserAgentWalletBalance({
      externalUserId,
      representativeId: runtime.setup.id,
    });

    return privateJson({ reversal, walletBalance }, 200);
  } catch (error) {
    console.error("Failed to reverse public demo service credits.", error);
    return privateJson(
      {
        error:
          "未使用额度退回失败。请确认额度没有被占用或消费，然后刷新重试。",
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
