import { NextResponse } from "next/server";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  AgentWalletReconciliationError,
  completeMockRechargeAndPurchaseAgentTokens,
  getPublicRepresentativeRuntime,
  prisma,
} from "@delegate/web-data";

import { cookies } from "next/headers";
import {
  assertAuthenticatedPublicAudiencePrincipal,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../public-principal";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
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
    const { principal, sessionState } = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore,
    });
    assertAuthenticatedPublicAudiencePrincipal(principal);
    const rechargeOrder = await prisma.rechargeOrder.findUnique({
      where: { id },
      select: {
        representativeId: true,
        productCode: true,
        userWallet: {
          select: {
            audienceIdentityId: true,
            externalUserId: true,
          },
        },
      },
    });
    const ownedByPrincipal =
      rechargeOrder?.userWallet.audienceIdentityId
      === principal.audienceIdentityId;
    const matchesPurchaseIntent =
      rechargeOrder?.representativeId === runtime.setup.id
      && rechargeOrder.productCode ===
        AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE;
    if (!ownedByPrincipal || !matchesPurchaseIntent || !rechargeOrder) {
      return privateJson({ error: "Recharge order not found." }, 404);
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: id,
      externalUserId: rechargeOrder.userWallet.externalUserId,
      representativeId: runtime.setup.id,
      ...(typeof body.amountCents === "number"
        ? { amountCents: body.amountCents }
        : {}),
      ...(typeof body.providerEventId === "string" && body.providerEventId.trim()
        ? { providerEventId: body.providerEventId.trim() }
        : {}),
      purchaseIdempotencyKey: `public_token_purchase:${id}`,
    });

    const response = privateJson(result, 200);
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    console.error("Failed to complete public mock recharge.", error);
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
