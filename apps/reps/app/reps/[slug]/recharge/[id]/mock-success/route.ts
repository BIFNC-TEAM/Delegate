import { NextResponse } from "next/server";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  AGENT_WALLET_TIP_PRODUCT_CODE,
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
        productKindSnapshot: true,
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
      && (
        (
          rechargeOrder.productCode ===
            AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
          && (rechargeOrder.productKindSnapshot === null
            || rechargeOrder.productKindSnapshot === "SERVICE_PACKAGE")
        )
        || (
          rechargeOrder.productCode === AGENT_WALLET_TIP_PRODUCT_CODE
          && rechargeOrder.productKindSnapshot === "TIP"
        )
      );
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
      purchaseIdempotencyKey: `public_commerce_fulfillment:${id}`,
    });

    const response = privateJson(
      serializePublicMockCommerceCompletion(result),
      200,
    );
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

type MockCommerceCompletion = Awaited<
  ReturnType<typeof completeMockRechargeAndPurchaseAgentTokens>
>;

/**
 * Keep the browser response deliberately smaller than the finance-domain
 * fulfillment result. The raw result contains wallet identities, revenue
 * splits and ledger references that are server-only implementation details.
 */
function serializePublicMockCommerceCompletion(
  result: MockCommerceCompletion,
) {
  const rechargeOrder = result.rechargeOrder;
  const publicRechargeOrder = {
    id: rechargeOrder.id,
    billingProductId: rechargeOrder.billingProductId,
    billingPriceVersionId: rechargeOrder.billingPriceVersionId,
    productName: rechargeOrder.productNameSnapshot,
    productKind: result.productKind,
    entitlementUnits: rechargeOrder.entitlementUnitsSnapshot,
    unitName: rechargeOrder.unitNameSnapshot,
    handoffAllowance: rechargeOrder.handoffAllowanceSnapshot,
    handoffUnits: rechargeOrder.handoffUnitsSnapshot,
    handoffServiceLevel: rechargeOrder.handoffServiceLevelSnapshot,
    handoffValidityDays: rechargeOrder.handoffValidityDaysSnapshot,
    amountCents: rechargeOrder.amountCents,
    currency: rechargeOrder.currency,
    provider: rechargeOrder.provider,
    status: rechargeOrder.status,
    checkoutUrl: rechargeOrder.checkoutUrl,
    checkoutExpiresAt: rechargeOrder.checkoutExpiresAt,
  };

  if (result.productKind === "TIP") {
    return {
      rechargeOrder: publicRechargeOrder,
      tokenPurchase: null,
    };
  }

  return {
    rechargeOrder: publicRechargeOrder,
    tokenPurchase: {
      tokenAmount: result.tokenPurchase.tokenAmount,
      remainingTokenAmount: result.tokenPurchase.remainingTokenAmount,
      availableTokenAmount: result.tokenPurchase.availableTokenAmount,
      reservedTokenAmount: result.tokenPurchase.reservedTokenAmount,
      currency: result.tokenPurchase.currency,
    },
  };
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
