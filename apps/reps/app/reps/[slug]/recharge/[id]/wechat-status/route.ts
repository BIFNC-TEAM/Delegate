import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  AgentWalletReconciliationError,
  RechargePaymentConflictError,
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  WeChatPayReconciliationConflictError,
  WalletIdempotencyConflictError,
  getPublicRepresentativeRuntime,
  isWeChatPayProcessingEnabled,
  prisma,
  readWeChatPayCheckoutExpiresAt,
  reconcileWeChatPayOrderIfDue,
  resolvePublicAudienceWalletExternalUserId,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../public-principal";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  if (!isWeChatPayProcessingEnabled()) {
    return privateJson(
      {
        error: "微信支付暂未配置，请稍后再试。",
        code: "payment_provider_unavailable",
      },
      503,
    );
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
    const requestPrincipal = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore,
    });
    await requestPrincipal.revalidate();
    const { principal, sessionState } = requestPrincipal;
    const expectedExternalUserId =
      await resolvePublicAudienceWalletExternalUserId({
        audienceIdentityId: principal.audienceIdentityId,
        representativeSlug: slug,
        audienceId: principal.audienceId,
        currency: "CNY",
      });
    const rechargeOrder = await prisma.rechargeOrder.findUnique({
      where: { id },
      select: {
        id: true,
        provider: true,
        status: true,
        providerPayload: true,
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
    const ownedByPrincipal = rechargeOrder?.userWallet.audienceIdentityId
      ? rechargeOrder.userWallet.audienceIdentityId
        === principal.audienceIdentityId
      : principal.mode === "anonymous"
        && rechargeOrder?.userWallet.externalUserId
          === expectedExternalUserId;
    const matchesPurchaseIntent =
      rechargeOrder?.representativeId === runtime.setup.id
      && rechargeOrder.productCode
        === AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE;
    if (
      !rechargeOrder
      || !ownedByPrincipal
      || !matchesPurchaseIntent
      || rechargeOrder.provider !== "WECHAT_PAY"
    ) {
      return privateJson({ error: "Recharge order not found." }, 404);
    }

    const knownStatus = readKnownLocalStatus(rechargeOrder.status);
    if (knownStatus) {
      return principalJson(
        paymentStatusBody(knownStatus, rechargeOrder.providerPayload),
        request,
        slug,
        sessionState,
      );
    }
    if (!readPendingLocalStatus(rechargeOrder.status)) {
      return privateJson(
        {
          error: "充值单暂不可查询，请重新发起支付。",
          code: "payment_order_not_queryable",
        },
        409,
      );
    }

    // The order id comes from the authenticated server-side lookup. Request
    // body values are intentionally ignored so amount, merchant, wallet and
    // out_trade_no cannot be overridden by a browser. Browser requests and
    // the background worker share one durable outbox lease, so repeated
    // clicks or multiple web replicas cannot fan out provider queries.
    const reconciliation =
      await reconcileWeChatPayOrderIfDue(rechargeOrder.id);

    if (reconciliation.status !== "pending") {
      return principalJson(
        paymentStatusBody(
          reconciliation.status,
          rechargeOrder.providerPayload,
          reconciliation.queried,
        ),
        request,
        slug,
        sessionState,
      );
    }

    // Reconciliation can recover a lost Native create response and persist a
    // fresh code_url. Reload local truth so the authenticated browser receives
    // that QR without creating a second out_trade_no.
    const currentOrder = await prisma.rechargeOrder.findUnique({
      where: { id: rechargeOrder.id },
      select: {
        id: true,
        status: true,
        checkoutUrl: true,
        providerPayload: true,
      },
    });
    if (!currentOrder) {
      throw new WeChatPayReconciliationConflictError(
        "WeChat Pay recharge order disappeared after reconciliation.",
      );
    }
    const currentKnownStatus =
      readKnownLocalStatus(currentOrder.status);
    if (currentKnownStatus) {
      return principalJson(
        paymentStatusBody(
          currentKnownStatus,
          currentOrder.providerPayload,
          reconciliation.queried,
        ),
        request,
        slug,
        sessionState,
      );
    }
    const currentPendingStatus =
      readPendingLocalStatus(currentOrder.status);
    if (!currentPendingStatus) {
      throw new WeChatPayReconciliationConflictError(
        "WeChat Pay recharge order changed to an unsupported state.",
      );
    }

    return principalJson(
      paymentStatusBody(
        "pending",
        currentOrder.providerPayload,
        reconciliation.queried,
        {
          orderStatus: currentPendingStatus,
          checkoutUrl: currentOrder.checkoutUrl,
        },
      ),
      request,
      slug,
      sessionState,
    );
  } catch (error) {
    logWeChatStatusError(error);
    if (error instanceof WeChatPayConfigurationError) {
      return privateJson(
        {
          error: "微信支付配置尚未就绪，请稍后再试。",
          code: "payment_provider_unavailable",
        },
        503,
      );
    }
    if (error instanceof WeChatPayProtocolError) {
      return privateJson(
        {
          error: "微信支付状态暂时无法确认，请稍后重试。",
          code: "payment_provider_error",
        },
        502,
      );
    }
    if (
      error instanceof RechargePaymentConflictError
      || error instanceof WalletIdempotencyConflictError
      || error instanceof AgentWalletReconciliationError
      || error instanceof WeChatPayReconciliationConflictError
    ) {
      return privateJson(
        {
          error: "支付结果与钱包账目不一致，当前操作未执行。",
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
        error: "微信支付状态确认失败，请稍后重试。",
        code: "payment_status_failed",
      },
      500,
    );
  }
}

function paymentStatusBody(
  status: "pending" | "paid" | "closed" | "refunded" | "failed",
  providerPayload: unknown,
  providerChecked = false,
  pendingOrder?: {
    orderStatus: "created" | "requires_payment";
    checkoutUrl: string | null;
  },
) {
  return status === "pending"
    ? {
        status,
        orderStatus: pendingOrder?.orderStatus ?? "requires_payment",
        providerChecked,
        checkoutUrl:
          pendingOrder?.orderStatus === "requires_payment"
          && typeof pendingOrder.checkoutUrl === "string"
          && pendingOrder.checkoutUrl.startsWith("weixin://wxpay/")
            ? pendingOrder.checkoutUrl
            : null,
        checkoutExpiresAt:
          pendingOrder?.orderStatus === "created"
            ? null
            : readWeChatPayCheckoutExpiresAt(providerPayload),
      }
    : { status };
}

function readPendingLocalStatus(
  status: string,
): "created" | "requires_payment" | null {
  switch (status) {
    case "CREATED":
      return "created";
    case "REQUIRES_PAYMENT":
      return "requires_payment";
    default:
      return null;
  }
}

function readKnownLocalStatus(
  status: string,
): "paid" | "closed" | "refunded" | "failed" | null {
  switch (status) {
    case "PAID":
      return "paid";
    case "CANCELED":
      return "closed";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

function principalJson(
  body: unknown,
  request: Request,
  slug: string,
  sessionState: Parameters<typeof setPublicAudienceSessionCookie>[3],
) {
  const response = privateJson(body, 200);
  setPublicAudienceSessionCookie(
    response,
    request,
    slug,
    sessionState,
  );
  return response;
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

function logWeChatStatusError(error: unknown) {
  const details =
    error instanceof Error
      ? {
          name: error.name,
          code:
            "code" in error && typeof error.code === "string"
              ? error.code
              : "UNKNOWN",
        }
      : { name: "UnknownError", code: "UNKNOWN" };
  console.error("Failed to reconcile WeChat Pay order.", details);
}
