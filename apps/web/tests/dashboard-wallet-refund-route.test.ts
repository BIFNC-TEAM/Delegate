import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WalletIdempotencyConflictError extends Error {}
  class WeChatRefundIntentConflictError extends Error {}
  return {
    WalletIdempotencyConflictError,
    WeChatRefundIntentConflictError,
    createWeChatRefundIntent: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    findTokenPurchase: vi.fn(),
    isWeChatPayProcessingEnabled: vi.fn(),
    loadWeChatPayRefundNotifyUrlFromEnv: vi.fn(),
    requireDashboardRepresentativeBillingAccess: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  WalletIdempotencyConflictError:
    mocks.WalletIdempotencyConflictError,
  WeChatRefundIntentConflictError:
    mocks.WeChatRefundIntentConflictError,
  createWeChatRefundIntent: mocks.createWeChatRefundIntent,
  isWeChatPayProcessingEnabled:
    mocks.isWeChatPayProcessingEnabled,
  loadWeChatPayRefundNotifyUrlFromEnv:
    mocks.loadWeChatPayRefundNotifyUrlFromEnv,
  prisma: {
    agentTokenPurchase: {
      findUnique: mocks.findTokenPurchase,
    },
  },
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

import { POST } from "../app/api/dashboard/wallet/refunds/route";

describe("dashboard wallet WeChat refund route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
    mocks.isWeChatPayProcessingEnabled.mockReturnValue(true);
    mocks.loadWeChatPayRefundNotifyUrlFromEnv.mockReturnValue(
      "https://delegate.example/api/payments/wechat/refund-notify",
    );
    mocks.findTokenPurchase.mockResolvedValue(refundablePurchase());
    mocks.createWeChatRefundIntent.mockResolvedValue({
      id: "refund-1",
      rechargeOrderId: "recharge-1",
      providerRefundOrderId: "delegate-refund-1",
      submissionStatus: "queued",
      providerStatus: null,
      reversalStatus: "pending",
      processingError: "internal detail must stay private",
    });
  });

  it("proves owner scope and queues a full refund with the canonical callback", async () => {
    const response = await POST(refundRequest({
      tokenPurchaseId: "purchase-1",
      reason: "用户申请",
      idempotencyKey: "dashboard-refund:purchase-1:attempt-1",
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("active");
    expect(mocks.findTokenPurchase).toHaveBeenCalledWith({
      where: { id: "purchase-1" },
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
    expect(mocks.createWeChatRefundIntent).toHaveBeenCalledWith({
      rechargeOrderId: "recharge-1",
      requestedByOwnerId: "owner-1",
      requestIdempotencyKey:
        expect.stringMatching(/^dashboard_refund:[a-f0-9]{64}$/),
      refundNotifyUrl:
        "https://delegate.example/api/payments/wechat/refund-notify",
      reason: "用户申请",
    });
    await expect(response.json()).resolves.toEqual({
      refund: {
        id: "refund-1",
        rechargeOrderId: "recharge-1",
        providerRefundOrderId: "delegate-refund-1",
        submissionStatus: "queued",
        providerStatus: null,
        reversalStatus: "pending",
      },
    });
  });

  it("scopes the client retry key by Owner and purchase", async () => {
    const clientKey = "same-client-retry-key";
    await POST(refundRequest({
      tokenPurchaseId: "purchase-1",
      idempotencyKey: clientKey,
    }));
    const firstKey = mocks.createWeChatRefundIntent.mock.calls[0]![0]!
      .requestIdempotencyKey as string;

    mocks.findTokenPurchase.mockResolvedValueOnce({
      id: "purchase-2",
      rechargeOrder: {
        id: "recharge-2",
        provider: "WECHAT_PAY",
        status: "PAID",
        representative: { ownerId: "owner-1" },
      },
    });
    await POST(refundRequest({
      tokenPurchaseId: "purchase-2",
      idempotencyKey: clientKey,
    }));
    const secondKey = mocks.createWeChatRefundIntent.mock.calls[1]![0]!
      .requestIdempotencyKey as string;

    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValueOnce({
      ownerId: "owner-2",
    });
    mocks.findTokenPurchase.mockResolvedValueOnce({
      id: "purchase-2",
      rechargeOrder: {
        id: "recharge-2",
        provider: "WECHAT_PAY",
        status: "PAID",
        representative: { ownerId: "owner-2" },
      },
    });
    await POST(refundRequest({
      tokenPurchaseId: "purchase-2",
      idempotencyKey: clientKey,
    }));
    const thirdKey = mocks.createWeChatRefundIntent.mock.calls[2]![0]!
      .requestIdempotencyKey as string;

    expect(firstKey).not.toBe(secondKey);
    expect(secondKey).not.toBe(thirdKey);
    expect(firstKey).not.toBe(thirdKey);
    expect(firstKey).toMatch(/^dashboard_refund:[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^dashboard_refund:[a-f0-9]{64}$/);
    expect(thirdKey).toMatch(/^dashboard_refund:[a-f0-9]{64}$/);
    expect(firstKey.length).toBeLessThanOrEqual(200);
    expect(secondKey.length).toBeLessThanOrEqual(200);
    expect(thirdKey.length).toBeLessThanOrEqual(200);
  });

  it("requires the processing release flag before reading financial data", async () => {
    mocks.isWeChatPayProcessingEnabled.mockReturnValue(false);

    const response = await POST(refundRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "WeChat Pay refund processing is temporarily unavailable.",
      code: "wechat_pay_processing_unavailable",
    });
    expect(mocks.findTokenPurchase).not.toHaveBeenCalled();
    expect(mocks.createWeChatRefundIntent).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and reasons over 80 UTF-8 bytes", async () => {
    const unknownField = await POST(refundRequest({
      tokenPurchaseId: "purchase-1",
      idempotencyKey: "refund-1",
      unexpected: true,
    }));
    const oversizedReason = await POST(refundRequest({
      tokenPurchaseId: "purchase-1",
      idempotencyKey: "refund-2",
      reason: "退".repeat(27),
    }));
    const oversizedClientKey = await POST(refundRequest({
      tokenPurchaseId: "purchase-1",
      idempotencyKey: "r".repeat(65),
    }));

    expect(unknownField.status).toBe(400);
    expect(oversizedReason.status).toBe(400);
    expect(oversizedClientKey.status).toBe(400);
    expect(oversizedReason.headers.get("cache-control"))
      .toBe("private, no-store");
    await expect(oversizedReason.json()).resolves.toMatchObject({
      code: "refund_request_invalid",
    });
    expect(mocks.findTokenPurchase).not.toHaveBeenCalled();
  });

  it("does not reveal whether another owner has a purchase", async () => {
    mocks.findTokenPurchase.mockResolvedValueOnce({
      ...refundablePurchase(),
      rechargeOrder: {
        ...refundablePurchase().rechargeOrder,
        representative: { ownerId: "owner-2" },
      },
    });

    const response = await POST(refundRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "The refundable purchase was not found.",
      code: "refund_purchase_not_found",
    });
    expect(mocks.loadWeChatPayRefundNotifyUrlFromEnv)
      .not.toHaveBeenCalled();
    expect(mocks.createWeChatRefundIntent).not.toHaveBeenCalled();
  });

  it("only accepts a paid WeChat recharge order", async () => {
    mocks.findTokenPurchase.mockResolvedValueOnce({
      ...refundablePurchase(),
      rechargeOrder: {
        ...refundablePurchase().rechargeOrder,
        status: "REQUIRES_PAYMENT",
      },
    });

    const response = await POST(refundRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Only paid WeChat Pay purchases can be refunded here.",
      code: "refund_order_not_eligible",
    });
    expect(mocks.createWeChatRefundIntent).not.toHaveBeenCalled();
  });

  it("returns stable, actionable business conflict codes", async () => {
    mocks.createWeChatRefundIntent.mockRejectedValueOnce(
      new mocks.WeChatRefundIntentConflictError(
        "Recharge credits are consumed, reserved, ambiguous, or no longer safely refundable.",
      ),
    );
    const used = await POST(refundRequest());
    expect(used.status).toBe(409);
    await expect(used.json()).resolves.toEqual({
      error: "Only completely unused and unreserved credits can be refunded.",
      code: "refund_credits_not_unused",
    });

    mocks.createWeChatRefundIntent.mockRejectedValueOnce(
      new mocks.WeChatRefundIntentConflictError(
        "Recharge order already has an unresolved or successful refund.",
      ),
    );
    const duplicate = await POST(refundRequest());
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: "refund_already_queued",
    });

    mocks.createWeChatRefundIntent.mockRejectedValueOnce(
      new mocks.WalletIdempotencyConflictError("conflict"),
    );
    const idempotency = await POST(refundRequest());
    expect(idempotency.status).toBe(409);
    await expect(idempotency.json()).resolves.toMatchObject({
      code: "refund_idempotency_conflict",
    });
  });

  it("redacts configuration and unexpected failures", async () => {
    mocks.loadWeChatPayRefundNotifyUrlFromEnv.mockImplementationOnce(() => {
      throw new Error("merchant_private_key=secret");
    });
    const configuration = await POST(refundRequest());
    expect(configuration.status).toBe(503);
    expect(await configuration.text()).not.toContain("secret");

    mocks.findTokenPurchase.mockRejectedValueOnce(
      new Error("postgres://owner:password@private-host/delegate"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unexpected = await POST(refundRequest());
    const body = await unexpected.text();
    expect(unexpected.status).toBe(500);
    expect(body).toContain("refund_queue_failed");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to queue a Dashboard WeChat Pay refund.",
      { code: "wechat_refund_queue_failed" },
    );
    consoleError.mockRestore();
  });

  it("keeps auth errors and missing representative responses private", async () => {
    const missing = await POST(new Request(
      "http://localhost/api/dashboard/wallet/refunds",
      { method: "POST" },
    ));
    expect(missing.status).toBe(400);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");

    const unauthorized = Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
    mocks.requireDashboardRepresentativeBillingAccess.mockRejectedValueOnce(
      new Error("auth"),
    );
    mocks.dashboardAuthErrorResponse.mockReturnValueOnce(unauthorized);
    const response = await POST(refundRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.findTokenPurchase).not.toHaveBeenCalled();
  });
});

function refundablePurchase() {
  return {
    id: "purchase-1",
    rechargeOrder: {
      id: "recharge-1",
      provider: "WECHAT_PAY",
      status: "PAID",
      representative: { ownerId: "owner-1" },
    },
  };
}

function refundRequest(
  body: Record<string, unknown> = {
    tokenPurchaseId: "purchase-1",
    idempotencyKey: "dashboard-refund:purchase-1:attempt-1",
  },
) {
  return new Request(
    "http://localhost/api/dashboard/wallet/refunds?rep=active",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
