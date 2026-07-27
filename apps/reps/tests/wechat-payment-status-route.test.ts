import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AgentWalletReconciliationError extends Error {
    readonly code = "AGENT_WALLET_RECONCILIATION_REQUIRED";
  }

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

  class WeChatPayReconciliationConflictError extends Error {
    readonly code = "WECHAT_PAY_RECONCILIATION_CONFLICT";
  }

  return {
    AgentWalletReconciliationError,
    RechargePaymentConflictError,
    WalletIdempotencyConflictError,
    WeChatPayConfigurationError,
    WeChatPayProtocolError,
    WeChatPayReconciliationConflictError,
    getPublicRepresentativeRuntime: vi.fn(),
    isWeChatPayApiV3Enabled: vi.fn(),
    reconcileWeChatPayOrderIfDue: vi.fn(),
    rechargeOrderFindUnique: vi.fn(),
    resolvePublicAudienceWalletExternalUserId: vi.fn(),
    publicAudiencePrincipalErrorStatus: vi.fn(),
    resolvePublicAudienceRequestPrincipal: vi.fn(),
    setPublicAudienceSessionCookie: vi.fn(),
    cookieGet: vi.fn(),
    principalRevalidate: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE:
    "agent-wallet:service-credit:v1",
  AgentWalletReconciliationError: mocks.AgentWalletReconciliationError,
  RechargePaymentConflictError: mocks.RechargePaymentConflictError,
  WalletIdempotencyConflictError:
    mocks.WalletIdempotencyConflictError,
  WeChatPayConfigurationError: mocks.WeChatPayConfigurationError,
  WeChatPayProtocolError: mocks.WeChatPayProtocolError,
  WeChatPayReconciliationConflictError:
    mocks.WeChatPayReconciliationConflictError,
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  isWeChatPayApiV3Enabled: mocks.isWeChatPayApiV3Enabled,
  reconcileWeChatPayOrderIfDue:
    mocks.reconcileWeChatPayOrderIfDue,
  prisma: {
    rechargeOrder: {
      findUnique: mocks.rechargeOrderFindUnique,
    },
  },
  resolvePublicAudienceWalletExternalUserId:
    mocks.resolvePublicAudienceWalletExternalUserId,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
  }),
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie:
    mocks.setPublicAudienceSessionCookie,
}));

import { POST as readWeChatPaymentStatus } from "../app/reps/[slug]/recharge/[id]/wechat-status/route";

describe("public WeChat Pay status reconciliation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "rep-1", slug: "delegate" },
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "aud-current",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      sessionState: {
        audienceId: "aud-current",
        sessionToken: "session-token",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
      revalidate: mocks.principalRevalidate,
    });
    mocks.resolvePublicAudienceWalletExternalUserId.mockResolvedValue(
      "web:delegate:aud-current",
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
    mocks.rechargeOrderFindUnique.mockResolvedValue(ownedWeChatOrder());
    mocks.reconcileWeChatPayOrderIfDue.mockResolvedValue({
      status: "pending",
      queried: true,
    });
  });

  it("returns 503 before loading credentials or identity when WeChat Pay is disabled", async () => {
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(false);

    const response = await reconcile();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolvePublicAudienceRequestPrincipal).not.toHaveBeenCalled();
    expect(mocks.reconcileWeChatPayOrderIfDue).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an anonymous visitor without the order session",
      principal: {
        mode: "anonymous",
        audienceId: "aud-current",
        audienceIdentityId: "identity-current",
        businessKey: "audience:identity-current",
      },
      order: ownedWeChatOrder({
        userWallet: {
          audienceIdentityId: null,
          externalUserId: "web:delegate:aud-other",
        },
      }),
    },
    {
      name: "another canonical wallet owner",
      principal: {
        mode: "authenticated",
        audienceId: "aud-current",
        audienceIdentityId: "identity-current",
        businessKey: "audience:identity-current",
      },
      order: ownedWeChatOrder({
        userWallet: {
          audienceIdentityId: "identity-other",
          externalUserId: "web:delegate:aud-current",
        },
      }),
    },
    {
      name: "the same wallet through another representative",
      principal: {
        mode: "authenticated",
        audienceId: "aud-current",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      order: ownedWeChatOrder({ representativeId: "rep-other" }),
    },
  ])("hides the order from $name", async ({ principal, order }) => {
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal,
      sessionState: {
        audienceId: principal.audienceId,
        sessionToken: "session-token",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
      revalidate: mocks.principalRevalidate,
    });
    mocks.rechargeOrderFindUnique.mockResolvedValue(order);

    const response = await reconcile();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("identity-other");
    expect(mocks.reconcileWeChatPayOrderIfDue).not.toHaveBeenCalled();
  });

  it("fails safely for an order that was not created by WeChat Pay", async () => {
    mocks.rechargeOrderFindUnique.mockResolvedValue(
      ownedWeChatOrder({ provider: "MOCK" }),
    );

    const response = await reconcile();

    expect([404, 409]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("MOCK");
    expect(mocks.reconcileWeChatPayOrderIfDue).not.toHaveBeenCalled();
  });

  it("returns a minimal pending state without completing or exposing checkout data", async () => {
    const response = await reconcile();
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.principalRevalidate).toHaveBeenCalledOnce();
    expect(mocks.reconcileWeChatPayOrderIfDue).toHaveBeenCalledWith(
      "order-1",
    );
    expect(body).toEqual(expect.objectContaining({ status: "pending" }));
    expect(JSON.stringify(body)).not.toContain("checkoutUrl");
    expect(JSON.stringify(body)).not.toContain("providerPayload");
    expect(JSON.stringify(body)).not.toContain("externalUserId");
    expect(JSON.stringify(body)).not.toContain("audienceIdentityId");
  });

  it.each(["closed", "refunded", "failed"] as const)(
    "persists a signed %s terminal state and removes its checkout URL",
    async (status) => {
      mocks.reconcileWeChatPayOrderIfDue.mockResolvedValue({
        status,
        queried: true,
      });

      const response = await reconcile();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status });
      expect(mocks.reconcileWeChatPayOrderIfDue)
        .toHaveBeenCalledWith("order-1");
    },
  );

  it("atomically completes a signed SUCCESS query and returns a safe paid state", async () => {
    mocks.reconcileWeChatPayOrderIfDue.mockResolvedValue({
      status: "paid",
      queried: true,
    });

    const response = await reconcile();
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mocks.reconcileWeChatPayOrderIfDue).toHaveBeenCalledOnce();
    expect(body).toEqual(
      expect.objectContaining({
        status: "paid",
      }),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("checkoutUrl");
    expect(serialized).not.toContain("providerPayload");
    expect(serialized).not.toContain("userWalletId");
    expect(serialized).not.toContain("externalUserId");
  });

  it("ignores attacker-controlled amount, provider, order, and wallet identity fields", async () => {
    mocks.reconcileWeChatPayOrderIfDue.mockResolvedValue({
      status: "paid",
      queried: true,
    });

    const response = await reconcile({
      amountCents: 1,
      currency: "USD",
      provider: "MOCK",
      outTradeNo: "order-other",
      externalUserId: "attacker-wallet",
      audienceIdentityId: "identity-other",
    });

    expect(response.status).toBe(200);
    expect(mocks.reconcileWeChatPayOrderIfDue).toHaveBeenCalledWith(
      "order-1",
    );
    const serializedCalls = JSON.stringify(
      mocks.reconcileWeChatPayOrderIfDue.mock.calls,
    );
    expect(serializedCalls).not.toContain("attacker-wallet");
    expect(serializedCalls).not.toContain("identity-other");
    expect(serializedCalls).not.toContain("order-other");
  });

  it("maps an invalid signed upstream response to a safe provider error", async () => {
    mocks.reconcileWeChatPayOrderIfDue.mockRejectedValue(
      new mocks.WeChatPayProtocolError(
        "Wechatpay-Signature failed for merchant-server-only; body=secret",
      ),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await reconcile();
    const body = await response.text();
    const logged = JSON.stringify(consoleError.mock.calls);

    expect([502, 503]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toContain("merchant-server-only");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("Wechatpay-Signature");
    expect(logged).not.toContain("merchant-server-only");
    expect(logged).not.toContain("secret");
    expect(mocks.reconcileWeChatPayOrderIfDue).toHaveBeenCalledOnce();
  });

  it("fails closed when the durable job conflicts with local order truth", async () => {
    mocks.reconcileWeChatPayOrderIfDue.mockRejectedValue(
      new mocks.WeChatPayReconciliationConflictError(
        "internal reconciliation details",
      ),
    );

    const response = await reconcile();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "支付结果与钱包账目不一致，当前操作未执行。",
      code: "wallet_reconciliation_required",
    });
  });
});

function ownedWeChatOrder(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "order-1",
    provider: "WECHAT_PAY",
    status: "REQUIRES_PAYMENT",
    representativeId: "rep-1",
    productCode: "agent-wallet:service-credit:v1",
    amountCents: 2_000,
    currency: "CNY",
    checkoutUrl: "weixin://wxpay/bizpayurl?pr=must-not-leak",
    providerPayload: { secret: "must-not-leak" },
    userWallet: {
      audienceIdentityId: "identity-1",
      externalUserId: "web:delegate:aud-current",
    },
    ...overrides,
  };
}

async function reconcile(body: Record<string, unknown> = {}) {
  return readWeChatPaymentStatus(
    new Request(
      "https://delegate.example/reps/delegate/recharge/order-1/wechat-status",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    {
      params: Promise.resolve({ slug: "delegate", id: "order-1" }),
    },
  );
}
