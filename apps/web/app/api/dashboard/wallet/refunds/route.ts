import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createWeChatRefundIntent,
  isWeChatPayProcessingEnabled,
  loadWeChatPayRefundNotifyUrlFromEnv,
  prisma,
  WalletIdempotencyConflictError,
  WeChatRefundIntentConflictError,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../auth";

const refundRequestSchema = z.object({
  tokenPurchaseId: z.string().trim().min(1).max(64),
  reason: z.string().transform((value) => value.trim()).refine(
    (value) => new TextEncoder().encode(value).byteLength <= 80,
    "reason must not exceed 80 UTF-8 bytes.",
  ).optional(),
  idempotencyKey: z.string().trim().min(1).max(64),
}).strict();

export async function POST(request: Request) {
  const activeRepresentativeSlug =
    new URL(request.url).searchParams.get("rep")?.trim() ?? "";
  if (!activeRepresentativeSlug) {
    return privateJson(
      {
        error: "An active representative is required.",
        code: "representative_required",
      },
      400,
    );
  }

  try {
    const session = await requireDashboardRepresentativeBillingAccess(
      activeRepresentativeSlug,
    );

    if (!isWeChatPayProcessingEnabled()) {
      return privateJson(
        {
          error: "WeChat Pay refund processing is temporarily unavailable.",
          code: "wechat_pay_processing_unavailable",
        },
        503,
      );
    }

    const parsed = refundRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return privateJson(
        {
          error:
            "A token purchase, idempotency key, and optional reason of at most 80 UTF-8 bytes are required.",
          code: "refund_request_invalid",
        },
        400,
      );
    }

    const purchase = await prisma.agentTokenPurchase.findUnique({
      where: { id: parsed.data.tokenPurchaseId },
      select: {
        id: true,
        rechargeOrder: {
          select: {
            id: true,
            provider: true,
            status: true,
            representative: {
              select: { ownerId: true },
            },
          },
        },
      },
    });
    if (
      !purchase
      || !purchase.rechargeOrder
      || purchase.rechargeOrder.representative?.ownerId !== session.ownerId
    ) {
      return privateJson(
        {
          error: "The refundable purchase was not found.",
          code: "refund_purchase_not_found",
        },
        404,
      );
    }
    if (
      purchase.rechargeOrder.provider !== "WECHAT_PAY"
      || purchase.rechargeOrder.status !== "PAID"
    ) {
      return privateJson(
        {
          error: "Only paid WeChat Pay purchases can be refunded here.",
          code: "refund_order_not_eligible",
        },
        409,
      );
    }

    let refundNotifyUrl: string;
    try {
      refundNotifyUrl = loadWeChatPayRefundNotifyUrlFromEnv();
    } catch {
      return privateJson(
        {
          error: "WeChat Pay refund processing is temporarily unavailable.",
          code: "wechat_pay_configuration_invalid",
        },
        503,
      );
    }

    const refund = await createWeChatRefundIntent({
      rechargeOrderId: purchase.rechargeOrder.id,
      requestedByOwnerId: session.ownerId,
      requestIdempotencyKey: scopedRefundIdempotencyKey({
        ownerId: session.ownerId,
        tokenPurchaseId: purchase.id,
        clientKey: parsed.data.idempotencyKey,
      }),
      refundNotifyUrl,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });

    return privateJson(
      {
        refund: {
          id: refund.id,
          rechargeOrderId: refund.rechargeOrderId,
          providerRefundOrderId: refund.providerRefundOrderId,
          submissionStatus: refund.submissionStatus,
          providerStatus: refund.providerStatus,
          reversalStatus: refund.reversalStatus,
        },
      },
      202,
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);

    if (error instanceof WalletIdempotencyConflictError) {
      return privateJson(
        {
          error:
            "This refund retry key belongs to a different request. Refresh and try again.",
          code: "refund_idempotency_conflict",
        },
        409,
      );
    }
    if (error instanceof WeChatRefundIntentConflictError) {
      return refundConflictResponse(error);
    }

    console.error("Failed to queue a Dashboard WeChat Pay refund.", {
      code: "wechat_refund_queue_failed",
    });
    return privateJson(
      {
        error: "The refund could not be queued. Please retry.",
        code: "refund_queue_failed",
      },
      500,
    );
  }
}

function refundConflictResponse(error: WeChatRefundIntentConflictError) {
  const conflictByMessage = new Map<string, {
    code: string;
    message: string;
    status?: number;
  }>([
    [
      "Recharge order already has an unresolved or successful refund.",
      {
        code: "refund_already_queued",
        message:
          "This purchase already has a refund in progress or completed.",
      },
    ],
    [
      "Recharge credits are consumed, reserved, ambiguous, or no longer safely refundable.",
      {
        code: "refund_credits_not_unused",
        message:
          "Only completely unused and unreserved credits can be refunded.",
      },
    ],
    [
      "Recharge order is not an eligible paid WeChat order.",
      {
        code: "refund_order_not_eligible",
        message: "Only paid WeChat Pay purchases can be refunded here.",
      },
    ],
    [
      "Recharge order must have exactly one token purchase.",
      {
        code: "refund_purchase_ambiguous",
        message:
          "This payment cannot be refunded automatically and needs operations review.",
      },
    ],
    [
      "Recharge order not found.",
      {
        code: "refund_purchase_not_found",
        message: "The refundable purchase was not found.",
        status: 404,
      },
    ],
    [
      "Recharge order is not owned by the requester.",
      {
        code: "refund_purchase_not_found",
        message: "The refundable purchase was not found.",
        status: 404,
      },
    ],
  ]);
  const conflict = conflictByMessage.get(error.message) ?? {
    code: "refund_request_conflict",
    message:
      "This purchase cannot be refunded automatically. Refresh its status or contact operations.",
  };
  return privateJson(
    { error: conflict.message, code: conflict.code },
    conflict.status ?? 409,
  );
}

function privateJson(body: unknown, status: number) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}

function scopedRefundIdempotencyKey(input: {
  ownerId: string;
  tokenPurchaseId: string;
  clientKey: string;
}) {
  const digest = createHash("sha256")
    .update(input.ownerId)
    .update("\u0000")
    .update(input.tokenPurchaseId)
    .update("\u0000")
    .update(input.clientKey)
    .digest("hex");
  return `dashboard_refund:${digest}`;
}
