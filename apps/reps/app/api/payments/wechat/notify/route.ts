import { NextResponse } from "next/server";

import {
  PaymentProviderWebhookVerificationError,
  RechargePaymentConflictError,
  WeChatPayConfigurationError,
  WalletIdempotencyConflictError,
  completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
  createWeChatPayApiV3PaymentProviderAdapter,
  isWeChatPayApiV3Enabled,
  loadWeChatPayApiV3ConfigFromEnv,
} from "@delegate/web-data";

import {
  readBoundedWeChatNotificationBody,
  readWeChatPaySignatureHeaders,
} from "../notification-request";

export async function POST(request: Request) {
  if (!isWeChatPayApiV3Enabled()) {
    return noStoreJson(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Payment notification service is unavailable.",
      },
      503,
    );
  }

  try {
    // Signature verification must receive the exact bytes delivered by
    // WeChat Pay. Do not call request.json() or reserialize this payload.
    const rawBody = await readBoundedWeChatNotificationBody(request);
    if (!rawBody) {
      return noStoreJson(
        {
          code: "INVALID_REQUEST",
          message: "Payment notification is invalid.",
        },
        413,
      );
    }

    const adapter = createWeChatPayApiV3PaymentProviderAdapter(
      loadWeChatPayApiV3ConfigFromEnv(),
    );
    await completeRechargeAndPurchaseAgentTokensFromProviderWebhook(
      adapter,
      {
        rawBody,
        headers: readWeChatPaySignatureHeaders(request.headers),
      },
    );

    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logWeChatNotificationError(error);
    if (error instanceof WeChatPayConfigurationError) {
      return noStoreJson(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Payment notification service is unavailable.",
        },
        503,
      );
    }
    if (error instanceof PaymentProviderWebhookVerificationError) {
      return noStoreJson(
        {
          code: "INVALID_SIGNATURE",
          message: "Payment notification could not be verified.",
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
          code: "PAYMENT_CONFLICT",
          message: "Payment notification does not match the order.",
        },
        409,
      );
    }
    return noStoreJson(
      {
        code: "PROCESSING_FAILED",
        message: "Payment notification could not be processed.",
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

function logWeChatNotificationError(error: unknown) {
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
  console.error("Failed to process WeChat Pay notification.", details);
}
