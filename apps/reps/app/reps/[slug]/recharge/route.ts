import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  buildWebAudienceExternalUserId,
  createMockRechargeOrder,
  getPublicRepresentativeRuntime,
  resolveWebAudienceContact,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../public-chat";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (process.env.NODE_ENV === "production") {
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
    const cookieStore = await cookies();
    const sessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const contact = await resolveWebAudienceContact({
      representativeId: representative.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    const externalUserId = buildWebAudienceExternalUserId(slug, sessionState.audienceId);
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
      `public_recharge:${slug}:${sessionState.audienceId}:${operationId}`;
    const sessionCookieValue = writePublicChatSessionState({
      representativeSlug: slug,
      state: sessionState,
    });

    const rechargeOrder = await createMockRechargeOrder({
      externalUserId,
      ...(contact.audienceIdentityId ? { audienceIdentityId: contact.audienceIdentityId } : {}),
      displayName: typeof body.displayName === "string" ? body.displayName : contact.displayName ?? externalUserId,
      amountCents,
      currency: "CNY",
      idempotencyKey,
    });

    const response = privateJson({ rechargeOrder }, 201);
    response.cookies.set(
      getPublicChatCookieName(slug),
      sessionCookieValue,
      {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecurePublicChatCookie(request),
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: `/reps/${slug}`,
      },
    );

    return response;
  } catch (error) {
    console.error("Failed to create public recharge order.", error);
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
