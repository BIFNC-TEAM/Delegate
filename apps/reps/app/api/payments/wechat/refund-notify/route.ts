import { NextResponse } from "next/server";

import {
  RechargePaymentConflictError,
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  WalletIdempotencyConflictError,
  isWeChatPayProcessingEnabled,
  loadWeChatPayProcessingConfigFromEnv,
  persistVerifiedWeChatPayRefund,
  verifyWeChatPayApiV3RefundNotification,
} from "@delegate/web-data";

import {
  readBoundedWeChatNotificationBody,
  readWeChatPaySignatureHeaders,
} from "../notification-request";

export async function POST(request: Request) {
  if (!isWeChatPayProcessingEnabled()) {
    return noStoreJson(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Refund notification service is unavailable.",
      },
      503,
    );
  }

  try {
    const rawBody = await readBoundedWeChatNotificationBody(request);
    if (!rawBody) {
      return noStoreJson(
        {
          code: "INVALID_REQUEST",
          message: "Refund notification is invalid.",
        },
        413,
      );
    }

    const refund = await verifyWeChatPayApiV3RefundNotification(
      {
        rawBody,
        headers: readWeChatPaySignatureHeaders(request.headers),
      },
      loadWeChatPayProcessingConfigFromEnv(),
    );
    // Persist every verified terminal status before responding. Successful
    // refunds freeze linked entitlements and enqueue the durable reversal;
    // closed and abnormal facts remain auditable without inventing a local
    // financial transition.
    const persisted = await persistVerifiedWeChatPayRefund(refund);
    if (persisted.refundId === null) {
      // The external fact is already durable, but a retryable response keeps
      // WeChat delivering it while the local order becomes visible. Returning
      // 204 here would permanently strand the fact without a resolver.
      return noStoreJson(
        {
          code: "REFUND_MATCH_PENDING",
          message: "Refund notification is awaiting local order matching.",
        },
        500,
      );
    }

    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logWeChatRefundNotificationError(error);
    if (error instanceof WeChatPayConfigurationError) {
      return noStoreJson(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Refund notification service is unavailable.",
        },
        503,
      );
    }
    if (error instanceof WeChatPayProtocolError) {
      return noStoreJson(
        {
          code: "INVALID_NOTIFICATION",
          message: "Refund notification could not be verified.",
        },
        401,
      );
    }
    if (
      error instanceof RechargePaymentConflictError
      || error instanceof WalletIdempotencyConflictError
    ) {
      return noStoreJson(
        {
          code: "REFUND_CONFLICT",
          message: "Refund notification does not match the order.",
        },
        409,
      );
    }
    return noStoreJson(
      {
        code: "PROCESSING_FAILED",
        message: "Refund notification could not be persisted.",
      },
      500,
    );
  }
}

function noStoreJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function logWeChatRefundNotificationError(error: unknown) {
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
  console.error(
    "Failed to persist WeChat Pay refund notification.",
    details,
  );
}
