import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PaymentProviderWebhookVerificationError extends Error {
    readonly code = "PAYMENT_PROVIDER_WEBHOOK_VERIFICATION_FAILED";

    constructor(provider: string) {
      super(`${provider} webhook signature verification failed.`);
      this.name = "PaymentProviderWebhookVerificationError";
    }
  }

  class RechargePaymentConflictError extends Error {
    readonly code = "RECHARGE_PAYMENT_CONFLICT";

    constructor(message: string) {
      super(message);
      this.name = "RechargePaymentConflictError";
    }
  }

  class WalletIdempotencyConflictError extends Error {
    readonly code = "WALLET_IDEMPOTENCY_CONFLICT";

    constructor(operation: string, field: string) {
      super(`${operation} conflicts on ${field}.`);
      this.name = "WalletIdempotencyConflictError";
    }
  }

  class WeChatPayConfigurationError extends Error {
    readonly code = "WECHAT_PAY_CONFIGURATION_ERROR";

    constructor(message: string) {
      super(message);
      this.name = "WeChatPayConfigurationError";
    }
  }

  return {
    PaymentProviderWebhookVerificationError,
    RechargePaymentConflictError,
    WalletIdempotencyConflictError,
    WeChatPayConfigurationError,
    completeRechargeAndPurchaseAgentTokensFromProviderWebhook: vi.fn(),
    createWeChatPayApiV3PaymentProviderAdapter: vi.fn(),
    isWeChatPayApiV3Enabled: vi.fn(),
    loadWeChatPayApiV3ConfigFromEnv: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  PaymentProviderWebhookVerificationError:
    mocks.PaymentProviderWebhookVerificationError,
  RechargePaymentConflictError: mocks.RechargePaymentConflictError,
  WalletIdempotencyConflictError:
    mocks.WalletIdempotencyConflictError,
  WeChatPayConfigurationError: mocks.WeChatPayConfigurationError,
  completeRechargeAndPurchaseAgentTokensFromProviderWebhook:
    mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
  createWeChatPayApiV3PaymentProviderAdapter:
    mocks.createWeChatPayApiV3PaymentProviderAdapter,
  isWeChatPayApiV3Enabled: mocks.isWeChatPayApiV3Enabled,
  loadWeChatPayApiV3ConfigFromEnv:
    mocks.loadWeChatPayApiV3ConfigFromEnv,
}));

import { POST as notifyWeChatPayment } from "../app/api/payments/wechat/notify/route";

const config = { merchantId: "merchant-test-config" };
const adapter = { provider: "WECHAT_PAY" };

describe("WeChat Pay notification route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.loadWeChatPayApiV3ConfigFromEnv.mockReturnValue(config);
    mocks.createWeChatPayApiV3PaymentProviderAdapter.mockReturnValue(adapter);
    mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook
      .mockResolvedValue({
        duplicate: false,
      });
  });

  it("returns 503 without loading credentials when WeChat Pay is disabled", async () => {
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(false);

    const response = await notifyWeChatPayment(notificationRequest("{}"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Payment notification service is unavailable.",
    });
    expect(mocks.loadWeChatPayApiV3ConfigFromEnv).not.toHaveBeenCalled();
    expect(
      mocks.createWeChatPayApiV3PaymentProviderAdapter,
    ).not.toHaveBeenCalled();
    expect(
      mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
    ).not.toHaveBeenCalled();
  });

  it("forwards the exact raw body and five signature headers, then acknowledges with 204", async () => {
    const rawBody = '{\n  "id": "event-1", "summary": "支付成功"\n}\n';
    const request = notificationRequest(rawBody, {
      "Wechatpay-Timestamp": "1785100000",
      "Wechatpay-Nonce": "nonce-value",
      "Wechatpay-Serial": "serial-value",
      "Wechatpay-Signature": "signature-value",
      "Wechatpay-Signature-Type": "WECHATPAY2-SHA256-RSA2048",
    });

    const response = await notifyWeChatPayment(request);

    expect(
      mocks.createWeChatPayApiV3PaymentProviderAdapter,
    ).toHaveBeenCalledWith(config);
    expect(
      mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
    ).toHaveBeenCalledWith(adapter, {
      rawBody,
      headers: {
        "Wechatpay-Timestamp": "1785100000",
        "Wechatpay-Nonce": "nonce-value",
        "Wechatpay-Serial": "serial-value",
        "Wechatpay-Signature": "signature-value",
        "Wechatpay-Signature-Type": "WECHATPAY2-SHA256-RSA2048",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });

  it("returns 401 when the provider signature cannot be verified", async () => {
    mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook
      .mockRejectedValue(
        new mocks.PaymentProviderWebhookVerificationError("WECHAT_PAY"),
      );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await notifyWeChatPayment(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("INVALID_SIGNATURE");
    expect(body).not.toContain("signature verification failed");
  });

  it("returns 409 when a verified payment conflicts with its recharge order", async () => {
    mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook
      .mockRejectedValue(
        new mocks.RechargePaymentConflictError(
          "Payment amount for order-secret does not match.",
        ),
      );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await notifyWeChatPayment(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("PAYMENT_CONFLICT");
    expect(body).not.toContain("order-secret");
    expect(body).not.toContain("Payment amount for");
  });

  it("returns a safe 503 when server-side WeChat Pay configuration is invalid", async () => {
    mocks.loadWeChatPayApiV3ConfigFromEnv.mockImplementation(() => {
      throw new mocks.WeChatPayConfigurationError(
        "WECHAT_PAY_API_V3_KEY secret-value is invalid.",
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await notifyWeChatPayment(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("SERVICE_UNAVAILABLE");
    expect(body).not.toContain("WECHAT_PAY_API_V3_KEY");
    expect(body).not.toContain("secret-value");
    expect(
      mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
    ).not.toHaveBeenCalled();
  });

  it("returns a safe 500 without leaking unknown processing failures", async () => {
    const rawBody = '{"resource":{"ciphertext":"private-ciphertext"}}';
    mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook
      .mockRejectedValue(
        new Error("postgres://wallet:secret@private-host/delegate"),
      );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await notifyWeChatPayment(
      notificationRequest(rawBody),
    );
    const body = await response.text();
    const logged = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(body).toContain("PROCESSING_FAILED");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-host");
    expect(body).not.toContain("private-ciphertext");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("private-host");
    expect(logged).not.toContain("private-ciphertext");
  });

  it("rejects an oversized notification before loading config or processing it", async () => {
    const response = await notifyWeChatPayment(
      notificationRequest("x".repeat(1_100_001)),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_REQUEST",
      message: "Payment notification is invalid.",
    });
    expect(mocks.loadWeChatPayApiV3ConfigFromEnv).not.toHaveBeenCalled();
    expect(
      mocks.createWeChatPayApiV3PaymentProviderAdapter,
    ).not.toHaveBeenCalled();
    expect(
      mocks.completeRechargeAndPurchaseAgentTokensFromProviderWebhook,
    ).not.toHaveBeenCalled();
  });
});

function notificationRequest(
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request(
    "https://delegate.example/api/payments/wechat/notify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    },
  );
}
