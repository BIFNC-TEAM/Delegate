import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  WalletIdempotencyConflictError,
  claimPaymentProviderOperation,
  createPaymentProviderOperationScopeKey,
  createRechargeOrder,
  createMockRechargeOrder,
  createWeChatPayApiV3PaymentProviderAdapter,
  getPublicAgentWalletState,
  getPublicRepresentativeRuntime,
  isVerifiedPrivateChannelIdentityBinding,
  isWeChatPayApiV3Enabled,
  listActivePrivateChannelIdentityBindings,
  loadWeChatPayApiV3ConfigFromEnv,
  privateChannelIdentityProviders,
  prisma,
  releasePaymentProviderOperation,
  resolvePublicAudienceWalletExternalUserId,
  resolveRepresentativeTelegramBotConnectionId,
  resolveWebAudienceContact,
} from "@delegate/web-data";

import {
  assertAuthenticatedPublicAudiencePrincipal,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

const PUBLIC_WALLET_CURRENCIES = new Set(["CNY", "USD"]);
const PUBLIC_RECHARGE_AMOUNTS_CENTS = new Set([500, 2_000, 10_000]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return privateJson(
        { error: "Representative is not publicly available." },
        runtime.status === "paused" ? 423 : 404,
      );
    }
    const currency = readPublicWalletCurrency(request);
    if (!currency) {
      return privateJson({ error: "Unsupported wallet currency." }, 400);
    }

    const cookieStore = await cookies();
    const requestPrincipal = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore,
    });
    await requestPrincipal.revalidate();
    const state = await getPublicAgentWalletState({
      audienceIdentityId: requestPrincipal.principal.audienceIdentityId,
      representativeId: runtime.setup.id,
      currency,
    });

    const response = privateJson(state, 200);
    setPublicAudienceSessionCookie(
      response,
      request,
      slug,
      requestPrincipal.sessionState,
    );
    return response;
  } catch (error) {
    logPublicWalletReadError(error);
    const principalErrorStatus = publicAudiencePrincipalErrorStatus(error);
    if (principalErrorStatus) {
      return privateJson(
        {
          error: principalErrorStatus === 401
            ? "登录状态已失效，请重新登录后再试。"
            : "钱包身份需要人工核对，当前状态暂不可读取。",
        },
        principalErrorStatus,
      );
    }
    return privateJson(
      { error: "钱包状态读取失败，请稍后刷新重试。" },
      500,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const useWeChatPay = isWeChatPayApiV3Enabled();
  const mockEnabled =
    process.env.NODE_ENV === "development"
    || process.env.NODE_ENV === "test";
  if (!useWeChatPay && !mockEnabled) {
    return privateJson(
      {
        error: "微信支付暂未配置，请稍后再试。",
        code: "payment_provider_unavailable",
      },
      503,
    );
  }
  const { slug } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return privateJson(
        { error: "Representative is not publicly available." },
        runtime.status === "paused" ? 423 : 404,
      );
    }
    const representative = runtime.setup;

    const body = (await request.json()) as Record<string, unknown>;
    const amountCents = body.amountCents;
    if (
      typeof amountCents !== "number"
      || !Number.isInteger(amountCents)
      || !PUBLIC_RECHARGE_AMOUNTS_CENTS.has(amountCents)
    ) {
      return privateJson(
        { error: "请选择有效的充值金额。" },
        400,
      );
    }
    const continuationChannel =
      typeof body.continuationChannel === "string"
        ? body.continuationChannel.trim().toLowerCase()
        : "";
    if (continuationChannel && continuationChannel !== "telegram") {
      return privateJson({ error: "Unsupported recharge continuation channel." }, 400);
    }
    const cookieStore = await cookies();
    const { principal, sessionState } = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore,
    });
    assertAuthenticatedPublicAudiencePrincipal(principal);
    if (continuationChannel === "telegram") {
      const connectionId =
        await resolveRepresentativeTelegramBotConnectionId(slug);
      if (!connectionId) {
        return privateJson(
          {
            error: "Telegram 渠道尚未连接，暂时不能从 Telegram 继续充值。",
            code: "telegram_channel_unavailable",
          },
          503,
        );
      }
      const bindings = await listActivePrivateChannelIdentityBindings(
        principal.audienceIdentityId,
      );
      const telegramBinding = bindings.some((binding) =>
        isVerifiedPrivateChannelIdentityBinding(binding, {
          provider: privateChannelIdentityProviders.telegram,
          issuer: "delegate-managed-bot",
          connectionId,
        }),
      );
      if (!telegramBinding) {
        return privateJson(
          {
            error: "请先把当前 Telegram 账户绑定到这个 Delegate 账户，再创建充值单。",
            code: "telegram_binding_required",
          },
          409,
        );
      }
    }
    const contact = await resolveWebAudienceContact({
      representativeId: representative.id,
      representativeSlug: slug,
      audienceId: principal.audienceId,
    });
    if (contact.audienceIdentityId !== principal.audienceIdentityId) {
      return privateJson({ error: "Audience identity conflict." }, 409);
    }
    const externalUserId = await resolvePublicAudienceWalletExternalUserId({
      audienceIdentityId: principal.audienceIdentityId,
      representativeSlug: slug,
      audienceId: principal.audienceId,
      currency: "CNY",
    });
    const requestedIdempotencyKey =
      request.headers.get("idempotency-key")?.trim()
      || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
    if (requestedIdempotencyKey.length > 160) {
      return privateJson(
        { error: "幂等键过长，请使用不超过 160 个字符的操作标识。" },
        400,
      );
    }
    const operationId = requestedIdempotencyKey || randomUUID();
    const idempotencyKey =
      `public_recharge:${slug}:${principal.businessKey}:${operationId}`;

    let createGateLease: {
      scopeKey: string;
      leaseToken: string;
    } | null = null;
    if (useWeChatPay) {
      const existingOrder = await prisma.rechargeOrder.findUnique({
        where: { idempotencyKey },
        select: { status: true },
      });
      if (!existingOrder || existingOrder.status === "CREATED") {
        const scopeKey = createPaymentProviderOperationScopeKey([
          "wechat_pay",
          "recharge_create",
          principal.audienceIdentityId,
        ]);
        const claim = await claimPaymentProviderOperation({ scopeKey });
        if (claim.claimed) {
          createGateLease = {
            scopeKey: claim.scopeKey,
            leaseToken: claim.leaseToken,
          };
        } else {
          // The winning request may have completed between our first order
          // lookup and the gate decision. In that case reuse the now-durable
          // idempotent result instead of rate-limiting its replay.
          const racedOrder = await prisma.rechargeOrder.findUnique({
            where: { idempotencyKey },
            select: { status: true },
          });
          if (!racedOrder || racedOrder.status === "CREATED") {
            const response = privateJson(
              {
                error: "充值请求过于频繁，请稍后使用同一操作重试。",
                code: "payment_rate_limited",
              },
              429,
            );
            response.headers.set(
              "Retry-After",
              String(claim.retryAfterSeconds),
            );
            setPublicAudienceSessionCookie(
              response,
              request,
              slug,
              sessionState,
            );
            return response;
          }
        }
      }
    }

    const orderInput = {
      externalUserId,
      audienceIdentityId: principal.audienceIdentityId,
      representativeId: representative.id,
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      displayName: typeof body.displayName === "string" ? body.displayName : contact.displayName ?? externalUserId,
      amountCents,
      currency: "CNY",
      idempotencyKey,
    };
    let rechargeOrder;
    try {
      rechargeOrder = useWeChatPay
        ? await createRechargeOrder(
            orderInput,
            createWeChatPayApiV3PaymentProviderAdapter(
              loadWeChatPayApiV3ConfigFromEnv(),
            ),
          )
        : await createMockRechargeOrder(orderInput);
    } finally {
      if (createGateLease) {
        await releasePaymentProviderOperationSafely(createGateLease);
      }
    }

    const response = privateJson(
      { rechargeOrder: serializePublicCheckoutOrder(rechargeOrder) },
      201,
    );
    setPublicAudienceSessionCookie(response, request, slug, sessionState);

    return response;
  } catch (error) {
    logPublicRechargeError(error);
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
          error: "微信支付暂时无法创建订单，请稍后重试。",
          code: "payment_provider_error",
        },
        502,
      );
    }
    if (error instanceof WalletIdempotencyConflictError) {
      return privateJson(
        {
          error: "本次充值操作与已有订单不一致，请重新发起。",
          code: "idempotency_conflict",
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
        error: "充值单创建失败，请稍后重试；如果问题持续，请联系代表主人检查支付配置。",
      },
      400,
    );
  }
}

function serializePublicCheckoutOrder(
  order: Awaited<ReturnType<typeof createRechargeOrder>>,
) {
  return {
    id: order.id,
    amountCents: order.amountCents,
    currency: order.currency,
    provider: order.provider,
    status: order.status,
    checkoutUrl: order.checkoutUrl,
    paidAt: order.paidAt,
    cashBalanceCents: order.cashBalanceCents,
  };
}

function logPublicRechargeError(error: unknown) {
  logPublicWalletError("Failed to create public recharge order.", error);
}

function logPublicWalletReadError(error: unknown) {
  logPublicWalletError("Failed to read public wallet state.", error);
}

async function releasePaymentProviderOperationSafely(input: {
  scopeKey: string;
  leaseToken: string;
}) {
  try {
    await releasePaymentProviderOperation(input);
  } catch (error) {
    // The bounded lease expires by itself. Do not replace a successful payment
    // response with an operational cleanup failure.
    logPublicWalletError(
      "Failed to release payment provider operation gate.",
      error,
    );
  }
}

function logPublicWalletError(message: string, error: unknown) {
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
  console.error(message, details);
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

function readPublicWalletCurrency(request: Request): string | null {
  const currency =
    new URL(request.url).searchParams.get("currency")?.trim().toUpperCase()
    || "CNY";
  return PUBLIC_WALLET_CURRENCIES.has(currency) ? currency : null;
}
