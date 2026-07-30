import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  PaymentProviderOperationLeaseLostError,
  PublicServicePackageError,
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
  listActivePrivateChannelIdentityBindings,
  listPublicServicePackages,
  loadWeChatPayProcessingConfigFromEnv,
  lockPaymentProviderOperationLease,
  privateChannelIdentityProviders,
  prisma,
  readWeChatPayCheckoutExpiresAt,
  releasePaymentProviderOperation,
  renewPaymentProviderOperationLease,
  resolvePublicAudienceWalletExternalUserId,
  resolvePublicServicePackage,
  resolveRepresentativeTelegramBotConnectionId,
  resolveWeChatPayReleaseFlags,
  resolveWebAudienceContact,
  type PaymentProviderOperationGateClient,
} from "@delegate/web-data";

import {
  assertAuthenticatedPublicAudiencePrincipal,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

const PUBLIC_WALLET_CURRENCIES = new Set(["CNY", "USD"]);
const WECHAT_RECHARGE_CREATE_LEASE_MS = 75_000;

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
    const [state, servicePackages] = await Promise.all([
      getPublicAgentWalletState({
        audienceIdentityId: requestPrincipal.principal.audienceIdentityId,
        representativeId: runtime.setup.id,
        currency,
      }),
      currency === "CNY"
        ? listPublicServicePackages({
            representativeId: runtime.setup.id,
            currency: "CNY",
          })
        : Promise.resolve([]),
    ]);

    const response = privateJson(
      {
        ...state,
        summary: {
          currency: state.summary.currency,
          serviceCreditsAvailable:
            state.summary.serviceCreditsAvailable,
          serviceCreditsReserved:
            state.summary.serviceCreditsReserved,
          serviceCreditsPurchased:
            state.summary.serviceCreditsPurchased,
          serviceCreditsConsumed:
            state.summary.serviceCreditsConsumed,
        },
        servicePackages,
      },
      200,
    );
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
  let releaseFlags: ReturnType<typeof resolveWeChatPayReleaseFlags>;
  try {
    releaseFlags = resolveWeChatPayReleaseFlags();
  } catch {
    return privateJson(
      {
        error: "微信支付发布配置无效，请稍后再试。",
        code: "payment_provider_unavailable",
      },
      503,
    );
  }
  const useWeChatPay = releaseFlags.processingEnabled;
  const collectionEnabled = releaseFlags.collectionEnabled;
  const mockEnabled =
    !useWeChatPay
    && (
      process.env.NODE_ENV === "development"
      || process.env.NODE_ENV === "test"
    );
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
    const billingPriceVersionId =
      typeof body.billingPriceVersionId === "string"
        ? body.billingPriceVersionId.trim()
        : "";
    if (!billingPriceVersionId || billingPriceVersionId.length > 191) {
      return privateJson(
        { error: "请选择有效的服务包。" },
        400,
      );
    }
    const continuationChannel =
      typeof body.continuationChannel === "string"
        ? body.continuationChannel.trim().toLowerCase()
        : "";
    if (continuationChannel && continuationChannel !== "telegram") {
      return privateJson(
        { error: "Unsupported service-package continuation channel." },
        400,
      );
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
            error: "Telegram 渠道尚未连接，暂时不能从 Telegram 继续购买服务包。",
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
            error: "请先把当前 Telegram 账户绑定到这个 Delegate 账户，再创建服务包订单。",
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
    if (useWeChatPay) {
      const activeCheckout =
        await findActiveWeChatRechargeOrder({
          audienceIdentityId: principal.audienceIdentityId,
          representativeId: representative.id,
        });
      if (activeCheckout) {
        const response = activeWeChatCheckoutResponse(
          activeCheckout,
          billingPriceVersionId,
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
    if (useWeChatPay && !collectionEnabled) {
      const response = privateJson(
        {
          error: "微信支付已暂停新收款；已有订单仍会继续查询和入账。",
          code: "payment_collection_paused",
        },
        503,
      );
      setPublicAudienceSessionCookie(
        response,
        request,
        slug,
        sessionState,
      );
      return response;
    }
    const servicePackage = await resolvePublicServicePackage({
      representativeId: representative.id,
      billingPriceVersionId,
      currency: "CNY",
    });
    const amountCents = servicePackage.amountCents;
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
        const claim = await claimPaymentProviderOperation({
          scopeKey,
          leaseDurationMs: WECHAT_RECHARGE_CREATE_LEASE_MS,
        });
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
                error: "服务包下单请求过于频繁，请稍后使用同一操作重试。",
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

    try {
      if (useWeChatPay && createGateLease) {
        // The first lookup may predate a previous owner's commit. Recheck only
        // after this request owns the gate, before creating another local
        // out_trade_no.
        const activeCheckout =
          await findActiveWeChatRechargeOrder({
            audienceIdentityId: principal.audienceIdentityId,
            representativeId: representative.id,
          });
        if (activeCheckout) {
          const response = activeWeChatCheckoutResponse(
            activeCheckout,
            billingPriceVersionId,
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

      const orderInput = {
        externalUserId,
        audienceIdentityId: principal.audienceIdentityId,
        representativeId: representative.id,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        billingProductId: servicePackage.productId,
        billingPriceVersionId: servicePackage.priceVersionId,
        productNameSnapshot: servicePackage.name,
        unitNameSnapshot: servicePackage.unitName,
        entitlementUnitsSnapshot: servicePackage.entitlementUnits,
        creatorRevenueShareBpsSnapshot:
          servicePackage.creatorRevenueShareBps,
        platformRevenueShareBpsSnapshot:
          servicePackage.platformRevenueShareBps,
        refundPolicySnapshot: servicePackage.refundPolicy,
        expiryPolicySnapshot: servicePackage.expiryPolicy,
        entitlementValidityDaysSnapshot:
          servicePackage.entitlementValidityDays,
        displayName: typeof body.displayName === "string"
          ? body.displayName
          : contact.displayName ?? externalUserId,
        amountCents,
        currency: "CNY",
        idempotencyKey,
        ...(createGateLease
          ? {
              creationFence: createWeChatRechargeCreationFence(
                createGateLease,
              ),
            }
          : {}),
      };
      const rechargeOrder = useWeChatPay
        ? await createRechargeOrder(
            orderInput,
            createWeChatPayApiV3PaymentProviderAdapter(
              loadWeChatPayProcessingConfigFromEnv(),
            ),
          )
        : await createMockRechargeOrder(orderInput);

      const response = privateJson(
        { rechargeOrder: serializePublicCheckoutOrder(rechargeOrder) },
        201,
      );
      setPublicAudienceSessionCookie(response, request, slug, sessionState);
      return response;
    } finally {
      if (createGateLease) {
        await releasePaymentProviderOperationSafely(createGateLease);
      }
    }
  } catch (error) {
    logPublicRechargeError(error);
    if (error instanceof PaymentProviderOperationLeaseLostError) {
      const response = privateJson(
        {
          error: "微信支付订单正在由另一请求安全创建，请稍后重试。",
          code: "payment_rate_limited",
        },
        429,
      );
      response.headers.set("Retry-After", "1");
      return response;
    }
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
          error: "本次服务包购买与已有订单不一致，请重新发起。",
          code: "idempotency_conflict",
        },
        409,
      );
    }
    if (error instanceof PublicServicePackageError) {
      return privateJson(
        {
          error: error.code === "SERVICE_PACKAGE_INVALID"
            ? "该服务包配置暂不可用，请联系代表主人检查商品设置。"
            : "所选服务包已下架或不属于当前数字代表，请重新选择。",
          code: error.code.toLowerCase(),
        },
        error.code === "SERVICE_PACKAGE_INVALID" ? 503 : 400,
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
        error: "服务包订单创建失败，请稍后重试；如果问题持续，请联系代表主人检查支付配置。",
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
    checkoutExpiresAt: order.checkoutExpiresAt,
    paidAt: order.paidAt,
    billingProductId: order.billingProductId,
    billingPriceVersionId: order.billingPriceVersionId,
    productName: order.productNameSnapshot,
    entitlementUnits: order.entitlementUnitsSnapshot,
    unitName: order.unitNameSnapshot,
  };
}

async function findActiveWeChatRechargeOrder(input: {
  audienceIdentityId: string;
  representativeId: string;
}) {
  const order = await prisma.rechargeOrder.findFirst({
    where: {
      representativeId: input.representativeId,
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      provider: "WECHAT_PAY",
      status: {
        in: ["CREATED", "REQUIRES_PAYMENT"],
      },
      currency: "CNY",
      userWallet: {
        audienceIdentityId: input.audienceIdentityId,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      amountCents: true,
      currency: true,
      provider: true,
      status: true,
      checkoutUrl: true,
      providerPayload: true,
      paidAt: true,
      billingProductId: true,
      billingPriceVersionId: true,
      productNameSnapshot: true,
      entitlementUnitsSnapshot: true,
      unitNameSnapshot: true,
    },
  });
  if (!order) {
    return null;
  }
  if (order.status === "CREATED") {
    return { ...order, checkoutExpiresAt: null };
  }
  const checkoutExpiresAt =
    readWeChatPayCheckoutExpiresAt(order.providerPayload);
  return { ...order, checkoutExpiresAt };
}

function serializePersistedPublicCheckoutOrder(
  order: NonNullable<
    Awaited<ReturnType<typeof findActiveWeChatRechargeOrder>>
  >,
) {
  return {
    id: order.id,
    amountCents: order.amountCents,
    currency: order.currency,
    provider: order.provider.toLowerCase(),
    status: order.status.toLowerCase(),
    checkoutUrl: order.checkoutUrl,
    checkoutExpiresAt: order.checkoutExpiresAt,
    paidAt: order.paidAt?.toISOString() ?? null,
    billingProductId: order.billingProductId,
    billingPriceVersionId: order.billingPriceVersionId,
    productName: order.productNameSnapshot,
    entitlementUnits: order.entitlementUnitsSnapshot,
    unitName: order.unitNameSnapshot,
  };
}

function activeWeChatCheckoutResponse(
  activeCheckout: NonNullable<
    Awaited<ReturnType<typeof findActiveWeChatRechargeOrder>>
  >,
  requestedBillingPriceVersionId: string,
) {
  const samePriceVersion =
    activeCheckout.billingPriceVersionId
      === requestedBillingPriceVersionId;
  return privateJson(
    samePriceVersion
      ? {
          rechargeOrder:
            serializePersistedPublicCheckoutOrder(activeCheckout),
          reused: true,
        }
      : {
          error: "已有另一金额的微信支付订单正在创建或待支付，请先完成或等待该订单关闭。",
          code: "payment_checkout_active",
          rechargeOrder:
            serializePersistedPublicCheckoutOrder(activeCheckout),
        },
    samePriceVersion ? 200 : 409,
  );
}

function createWeChatRechargeCreationFence(input: {
  scopeKey: string;
  leaseToken: string;
}) {
  return {
    async lockBeforeLocalCreate(client: unknown) {
      const owned = await lockPaymentProviderOperationLease(
        input,
        client as PaymentProviderOperationGateClient,
      );
      if (!owned) {
        throw new PaymentProviderOperationLeaseLostError();
      }
    },
    async renewBeforeProviderCreate() {
      const renewedUntil =
        await renewPaymentProviderOperationLease({
          ...input,
          leaseDurationMs: WECHAT_RECHARGE_CREATE_LEASE_MS,
        });
      if (!renewedUntil) {
        throw new PaymentProviderOperationLeaseLostError();
      }
    },
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
