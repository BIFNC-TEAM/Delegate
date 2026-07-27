import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RechargePaymentConflictError extends Error {
    readonly code = "RECHARGE_PAYMENT_CONFLICT";
  }

  class WalletIdempotencyConflictError extends Error {
    readonly code = "WALLET_IDEMPOTENCY_CONFLICT";
  }

  class WeChatPayConfigurationError extends Error {
    readonly code = "WECHAT_PAY_CONFIGURATION_ERROR";
  }

  class WeChatPayProtocolError extends Error {
    readonly code = "WECHAT_PAY_PROTOCOL_ERROR";
  }

  return {
    RechargePaymentConflictError,
    WalletIdempotencyConflictError,
    WeChatPayConfigurationError,
    WeChatPayProtocolError,
    isWeChatPayApiV3Enabled: vi.fn(),
    loadWeChatPayApiV3ConfigFromEnv: vi.fn(),
    persistVerifiedWeChatPayRefund: vi.fn(),
    verifyWeChatPayApiV3RefundNotification: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  RechargePaymentConflictError: mocks.RechargePaymentConflictError,
  WalletIdempotencyConflictError:
    mocks.WalletIdempotencyConflictError,
  WeChatPayConfigurationError: mocks.WeChatPayConfigurationError,
  WeChatPayProtocolError: mocks.WeChatPayProtocolError,
  isWeChatPayApiV3Enabled: mocks.isWeChatPayApiV3Enabled,
  loadWeChatPayApiV3ConfigFromEnv:
    mocks.loadWeChatPayApiV3ConfigFromEnv,
  persistVerifiedWeChatPayRefund:
    mocks.persistVerifiedWeChatPayRefund,
  verifyWeChatPayApiV3RefundNotification:
    mocks.verifyWeChatPayApiV3RefundNotification,
}));

import { POST as notifyWeChatRefund } from "../app/api/payments/wechat/refund-notify/route";

const config = { merchantId: "merchant-test-config" };
const normalizedRefund = {
  providerEventId: "refund-event-1",
  refundId: "refund-provider-1",
};

describe("WeChat Pay refund notification route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.loadWeChatPayApiV3ConfigFromEnv.mockReturnValue(config);
    mocks.verifyWeChatPayApiV3RefundNotification
      .mockResolvedValue(normalizedRefund);
    mocks.persistVerifiedWeChatPayRefund.mockResolvedValue({
      refundId: "refund-local-1",
      reversalStatus: "pending",
    });
  });

  it("does not load credentials when WeChat Pay is disabled", async () => {
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(false);

    const response = await notifyWeChatRefund(notificationRequest("{}"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadWeChatPayApiV3ConfigFromEnv).not.toHaveBeenCalled();
    expect(
      mocks.verifyWeChatPayApiV3RefundNotification,
    ).not.toHaveBeenCalled();
    expect(mocks.persistVerifiedWeChatPayRefund).not.toHaveBeenCalled();
  });

  it("verifies exact bytes, persists the provider fact, and acknowledges with 204", async () => {
    const rawBody =
      '{\n  "id": "refund-event-1", "summary": "退款成功"\n}\n';
    const response = await notifyWeChatRefund(
      notificationRequest(rawBody, {
        "Wechatpay-Timestamp": "1785100000",
        "Wechatpay-Nonce": "nonce-value",
        "Wechatpay-Serial": "serial-value",
        "Wechatpay-Signature": "signature-value",
        "Wechatpay-Signature-Type":
          "WECHATPAY2-SHA256-RSA2048",
      }),
    );

    expect(
      mocks.verifyWeChatPayApiV3RefundNotification,
    ).toHaveBeenCalledWith(
      {
        rawBody,
        headers: {
          "Wechatpay-Timestamp": "1785100000",
          "Wechatpay-Nonce": "nonce-value",
          "Wechatpay-Serial": "serial-value",
          "Wechatpay-Signature": "signature-value",
          "Wechatpay-Signature-Type":
            "WECHATPAY2-SHA256-RSA2048",
        },
      },
      config,
    );
    expect(mocks.persistVerifiedWeChatPayRefund)
      .toHaveBeenCalledWith(normalizedRefund);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("");
  });

  it("returns a safe 401 when verification fails", async () => {
    mocks.verifyWeChatPayApiV3RefundNotification.mockRejectedValue(
      new mocks.WeChatPayProtocolError("signature secret leaked"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await notifyWeChatRefund(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain("INVALID_NOTIFICATION");
    expect(body).not.toContain("secret");
    expect(mocks.persistVerifiedWeChatPayRefund).not.toHaveBeenCalled();
  });

  it("requests a retry after durably recording an unmatched refund", async () => {
    mocks.persistVerifiedWeChatPayRefund.mockResolvedValue({
      refundId: null,
      rechargeOrderId: null,
      reversalStatus: "reconciliation_required",
      processingError: "wechat_refund_order_missing",
    });

    const response = await notifyWeChatRefund(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("REFUND_MATCH_PENDING");
    expect(body).not.toContain("wechat_refund_order_missing");
    expect(mocks.persistVerifiedWeChatPayRefund).toHaveBeenCalledOnce();
  });

  it("returns 409 when a provider event id is reused for different facts", async () => {
    mocks.persistVerifiedWeChatPayRefund.mockRejectedValue(
      new mocks.WalletIdempotencyConflictError(
        "private provider event mismatch",
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await notifyWeChatRefund(notificationRequest("{}"));
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(body).toContain("REFUND_CONFLICT");
    expect(body).not.toContain("private provider event");
  });

  it("returns a safe 500 when the verified fact cannot be persisted", async () => {
    mocks.persistVerifiedWeChatPayRefund.mockRejectedValue(
      new Error("postgres://wallet:secret@private-host/delegate"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await notifyWeChatRefund(notificationRequest("{}"));
    const body = await response.text();
    const logged = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(500);
    expect(body).toContain("PROCESSING_FAILED");
    expect(body).not.toContain("secret");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("private-host");
  });

  it("rejects oversized bodies before loading configuration", async () => {
    const response = await notifyWeChatRefund(
      notificationRequest("x".repeat(1_100_001)),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadWeChatPayApiV3ConfigFromEnv).not.toHaveBeenCalled();
    expect(
      mocks.verifyWeChatPayApiV3RefundNotification,
    ).not.toHaveBeenCalled();
    expect(mocks.persistVerifiedWeChatPayRefund).not.toHaveBeenCalled();
  });
});

function notificationRequest(
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request(
    "https://delegate.example/api/payments/wechat/refund-notify",
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
