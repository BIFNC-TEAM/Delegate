import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  createMockRechargeOrder,
  getPublicRepresentativeRuntime,
  isVerifiedPrivateChannelIdentityBinding,
  listActivePrivateChannelIdentityBindings,
  privateChannelIdentityProviders,
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return privateJson({ error: "Not found." }, 404);
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
    const amountCents = Number(body.amountCents ?? 0);
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

    const rechargeOrder = await createMockRechargeOrder({
      externalUserId,
      audienceIdentityId: principal.audienceIdentityId,
      representativeId: representative.id,
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      displayName: typeof body.displayName === "string" ? body.displayName : contact.displayName ?? externalUserId,
      amountCents,
      currency: "CNY",
      idempotencyKey,
    });

    const response = privateJson({ rechargeOrder }, 201);
    setPublicAudienceSessionCookie(response, request, slug, sessionState);

    return response;
  } catch (error) {
    console.error("Failed to create public recharge order.", error);
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

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
