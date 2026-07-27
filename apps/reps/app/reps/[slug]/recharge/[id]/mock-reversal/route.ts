import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  AgentWalletReconciliationError,
  getPublicRepresentativeRuntime,
  getUserAgentWalletBalance,
  prisma,
  reverseAgentTokenPurchase,
} from "@delegate/web-data";

import {
  assertAuthenticatedPublicAudiencePrincipal,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../public-principal";

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
    const { principal, sessionState } = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore,
    });
    assertAuthenticatedPublicAudiencePrincipal(principal);
    const purchase = await prisma.agentTokenPurchase.findFirst({
      where: {
        rechargeOrderId,
        representativeId: runtime.setup.id,
        userWallet: {
          audienceIdentityId: principal.audienceIdentityId,
        },
      },
      select: {
        id: true,
        userWallet: {
          select: {
            externalUserId: true,
          },
        },
      },
    });
    if (!purchase) {
      return privateJson({ error: "Recharge purchase not found." }, 404);
    }

    const reversal = await reverseAgentTokenPurchase(purchase.id, {
      reason: "public_demo_unused_credit_reversal",
      idempotencyKey: `public_demo_reversal:${purchase.id}`,
    });
    const walletBalance = await getUserAgentWalletBalance({
      externalUserId: purchase.userWallet.externalUserId,
      representativeId: runtime.setup.id,
    });

    const response = privateJson({ reversal, walletBalance }, 200);
    setPublicAudienceSessionCookie(response, _request, slug, sessionState);
    return response;
  } catch (error) {
    console.error("Failed to reverse public demo service credits.", error);
    if (error instanceof AgentWalletReconciliationError) {
      return privateJson(
        {
          error: "钱包与服务额度账目不一致，当前操作未执行。",
          code: "wallet_reconciliation_required",
        },
        409,
      );
    }
    const principalErrorStatus = publicAudiencePrincipalErrorStatus(error);
    if (principalErrorStatus) {
      return privateJson(
        {
          error: principalErrorStatus === 401
            ? "登录状态已失效，请重新登录后再试。"
            : "钱包身份需要人工核对，当前操作未执行。",
        },
        principalErrorStatus,
      );
    }
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
