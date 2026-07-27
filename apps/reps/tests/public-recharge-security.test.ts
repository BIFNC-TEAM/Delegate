import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimPaymentProviderOperation: vi.fn(),
  completeMockRechargeAndPurchaseAgentTokens: vi.fn(),
  createPaymentProviderOperationScopeKey: vi.fn(),
  createRechargeOrder: vi.fn(),
  createMockRechargeOrder: vi.fn(),
  createWeChatPayApiV3PaymentProviderAdapter: vi.fn(),
  getPublicAgentWalletState: vi.fn(),
  getPublicRepresentativeRuntime: vi.fn(),
  getUserAgentWalletBalance: vi.fn(),
  isWeChatPayApiV3Enabled: vi.fn(),
  loadWeChatPayApiV3ConfigFromEnv: vi.fn(),
  resolvePublicAudienceWalletExternalUserId: vi.fn(),
  agentTokenPurchaseFindFirst: vi.fn(),
  rechargeOrderFindUnique: vi.fn(),
  releasePaymentProviderOperation: vi.fn(),
  reverseAgentTokenPurchase: vi.fn(),
  resolveWebAudienceContact: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
  setPublicAudienceSessionCookie: vi.fn(),
  principalRevalidate: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE:
    "agent-wallet:service-credit:v1",
  AgentWalletReconciliationError: class AgentWalletReconciliationError
    extends Error {},
  RechargePaymentConflictError: class RechargePaymentConflictError
    extends Error {},
  WeChatPayConfigurationError: class WeChatPayConfigurationError
    extends Error {},
  WeChatPayProtocolError: class WeChatPayProtocolError extends Error {},
  WalletIdempotencyConflictError: class WalletIdempotencyConflictError
    extends Error {},
  claimPaymentProviderOperation: mocks.claimPaymentProviderOperation,
  completeMockRechargeAndPurchaseAgentTokens:
    mocks.completeMockRechargeAndPurchaseAgentTokens,
  createPaymentProviderOperationScopeKey:
    mocks.createPaymentProviderOperationScopeKey,
  createRechargeOrder: mocks.createRechargeOrder,
  createMockRechargeOrder: mocks.createMockRechargeOrder,
  createWeChatPayApiV3PaymentProviderAdapter:
    mocks.createWeChatPayApiV3PaymentProviderAdapter,
  getPublicAgentWalletState: mocks.getPublicAgentWalletState,
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  getUserAgentWalletBalance: mocks.getUserAgentWalletBalance,
  isWeChatPayApiV3Enabled: mocks.isWeChatPayApiV3Enabled,
  loadWeChatPayApiV3ConfigFromEnv:
    mocks.loadWeChatPayApiV3ConfigFromEnv,
  resolvePublicAudienceWalletExternalUserId:
    mocks.resolvePublicAudienceWalletExternalUserId,
  prisma: {
    agentTokenPurchase: {
      findFirst: mocks.agentTokenPurchaseFindFirst,
    },
    rechargeOrder: {
      findUnique: mocks.rechargeOrderFindUnique,
    },
  },
  releasePaymentProviderOperation: mocks.releasePaymentProviderOperation,
  reverseAgentTokenPurchase: mocks.reverseAgentTokenPurchase,
  resolveWebAudienceContact: mocks.resolveWebAudienceContact,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
  }),
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus: mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie: mocks.setPublicAudienceSessionCookie,
}));

import {
  GET as readWalletState,
  POST as createRecharge,
} from "../app/reps/[slug]/recharge/route";
import { POST as completeRecharge } from "../app/reps/[slug]/recharge/[id]/mock-success/route";
import { POST as reverseRechargePurchase } from "../app/reps/[slug]/recharge/[id]/mock-reversal/route";

const originalNodeEnv = process.env["NODE_ENV"];

describe("public mock recharge security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv("NODE_ENV", "development");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(false);
    mocks.loadWeChatPayApiV3ConfigFromEnv.mockReturnValue({
      appId: "wx_app",
    });
    mocks.createWeChatPayApiV3PaymentProviderAdapter.mockReturnValue({
      provider: "WECHAT_PAY",
    });
    mocks.createPaymentProviderOperationScopeKey.mockReturnValue(
      "a".repeat(64),
    );
    mocks.claimPaymentProviderOperation.mockResolvedValue({
      claimed: true,
      scopeKey: "a".repeat(64),
      leaseToken: "wechat-create-lease-1",
      leaseExpiresAt: new Date("2026-07-27T12:00:15.000Z"),
      nextAllowedAt: new Date("2026-07-27T12:00:10.000Z"),
    });
    mocks.releasePaymentProviderOperation.mockResolvedValue(true);
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: { id: "rep-1", slug: "delegate" },
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "anonymous",
        audienceId: "aud_current_visitor",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      sessionState: {
        audienceId: "aud_current_visitor",
        sessionToken: "session-token",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
      revalidate: mocks.principalRevalidate,
    });
    mocks.resolvePublicAudienceWalletExternalUserId.mockResolvedValue(
      "web:delegate:aud_current_visitor",
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
    mocks.resolveWebAudienceContact.mockResolvedValue({
      audienceIdentityId: "identity-1",
      displayName: "Visitor",
    });
    mocks.rechargeOrderFindUnique.mockResolvedValue(null);
    mocks.createMockRechargeOrder.mockResolvedValue({
      id: "order-1",
      status: "requires_payment",
    });
    mocks.createRechargeOrder.mockResolvedValue({
      id: "wechat-order-1",
      amountCents: 2000,
      currency: "CNY",
      provider: "wechat_pay",
      status: "requires_payment",
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=redacted",
      paidAt: null,
      cashBalanceCents: 0,
      externalUserId: "must-not-leak",
      userWalletId: "must-not-leak",
    });
    mocks.getPublicAgentWalletState.mockResolvedValue({
      summary: {
        currency: "CNY",
        cashBalanceCents: 0,
        serviceCreditsAvailable: 8,
        serviceCreditsReserved: 2,
        serviceCreditsPurchased: 12,
        serviceCreditsConsumed: 2,
      },
      orders: [],
      purchases: [],
      refunds: [],
    });
    mocks.completeMockRechargeAndPurchaseAgentTokens.mockResolvedValue({
      rechargeOrder: {
        id: "order-1",
        status: "paid",
        amountCents: 2000,
        currency: "CNY",
        cashBalanceCents: 0,
      },
      tokenPurchase: {
        id: "purchase-1",
        cashBalanceCents: 0,
        availableTokenAmount: 2000,
      },
    });
    mocks.agentTokenPurchaseFindFirst.mockResolvedValue({
      id: "purchase-1",
      userWallet: {
        externalUserId: "web:delegate:aud_current_visitor",
      },
    });
    mocks.reverseAgentTokenPurchase.mockResolvedValue({
      purchaseId: "purchase-1",
      status: "reversed",
      tokenAmount: 2000,
      remainingTokenAmount: 0,
      reversedAmountCents: 2000,
      cashBalanceCents: 2000,
      currency: "CNY",
    });
    mocks.getUserAgentWalletBalance.mockResolvedValue({
      availableTokenAmount: 0,
      reservedTokenAmount: 0,
    });
  });

  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    vi.restoreAllMocks();
  });

  it("does not expose the mock payment completion route in production", async () => {
    restoreEnv("NODE_ENV", "production");

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getPublicRepresentativeRuntime).not.toHaveBeenCalled();
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).not.toHaveBeenCalled();
  });

  it("restores only the active principal's representative and currency state", async () => {
    restoreEnv("NODE_ENV", "production");

    const request = new Request(
      "http://localhost/reps/delegate/recharge?currency=cny",
    );
    const response = await readWalletState(request, {
      params: Promise.resolve({ slug: "delegate" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.principalRevalidate).toHaveBeenCalledOnce();
    expect(mocks.getPublicAgentWalletState).toHaveBeenCalledWith({
      audienceIdentityId: "identity-1",
      representativeId: "rep-1",
      currency: "CNY",
    });
    expect(mocks.setPublicAudienceSessionCookie).toHaveBeenCalledWith(
      response,
      request,
      "delegate",
      expect.objectContaining({
        audienceId: "aud_current_visitor",
      }),
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          currency: "CNY",
          serviceCreditsAvailable: 8,
        }),
      }),
    );
  });

  it("rejects an unsupported wallet currency without resolving wallet data", async () => {
    const response = await readWalletState(
      new Request("http://localhost/reps/delegate/recharge?currency=EUR"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolvePublicAudienceRequestPrincipal).not.toHaveBeenCalled();
    expect(mocks.getPublicAgentWalletState).not.toHaveBeenCalled();
  });

  it("fails closed when the current wallet identity requires reconciliation", async () => {
    mocks.getPublicAgentWalletState.mockRejectedValue(
      new Error("multiple canonical wallets"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(409);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await readWalletState(
      new Request("http://localhost/reps/delegate/recharge?currency=CNY"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.not.toContain(
      "multiple canonical wallets",
    );
  });

  it("does not expose database details from the read-only wallet route", async () => {
    mocks.getPublicAgentWalletState.mockRejectedValue(
      new Error("postgres://wallet:secret@private-host/delegate"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await readWalletState(
      new Request("http://localhost/reps/delegate/recharge"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("钱包状态读取失败");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-host");
  });

  it("fails closed without exposing mock recharge creation in production", async () => {
    restoreEnv("NODE_ENV", "production");

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 2000 }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getPublicRepresentativeRuntime).not.toHaveBeenCalled();
    expect(mocks.createMockRechargeOrder).not.toHaveBeenCalled();
    expect(mocks.createRechargeOrder).not.toHaveBeenCalled();
  });

  it("uses only the server-selected WeChat adapter in production", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: 2000,
          provider: "MOCK",
          currency: "USD",
          externalUserId: "attacker-selected",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    const body = await response.json() as {
      rechargeOrder: Record<string, unknown>;
    };

    expect(response.status).toBe(201);
    expect(mocks.createMockRechargeOrder).not.toHaveBeenCalled();
    expect(
      mocks.createWeChatPayApiV3PaymentProviderAdapter,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.createPaymentProviderOperationScopeKey,
    ).toHaveBeenCalledWith([
      "wechat_pay",
      "recharge_create",
      "identity-1",
    ]);
    expect(mocks.claimPaymentProviderOperation).toHaveBeenCalledWith({
      scopeKey: "a".repeat(64),
    });
    expect(mocks.createRechargeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: "web:delegate:aud_current_visitor",
        audienceIdentityId: "identity-1",
        representativeId: "rep-1",
        productCode: "agent-wallet:service-credit:v1",
        amountCents: 2000,
        currency: "CNY",
      }),
      { provider: "WECHAT_PAY" },
    );
    expect(mocks.releasePaymentProviderOperation).toHaveBeenCalledWith({
      scopeKey: "a".repeat(64),
      leaseToken: "wechat-create-lease-1",
    });
    expect(body.rechargeOrder).not.toHaveProperty("externalUserId");
    expect(body.rechargeOrder).not.toHaveProperty("userWalletId");
  });

  it("rate-limits a new WeChat creation using only the canonical audience identity", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.claimPaymentProviderOperation.mockResolvedValue({
      claimed: false,
      scopeKey: "a".repeat(64),
      retryAfterSeconds: 9,
    });

    const request = new Request(
      "http://localhost/reps/delegate/recharge",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9",
        },
        body: JSON.stringify({
          amountCents: 2000,
          idempotencyKey: "rate-limited-operation",
        }),
      },
    );
    const response = await createRecharge(request, {
      params: Promise.resolve({ slug: "delegate" }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    await expect(response.json()).resolves.toEqual({
      error: "充值请求过于频繁，请稍后使用同一操作重试。",
      code: "payment_rate_limited",
    });
    expect(
      mocks.createPaymentProviderOperationScopeKey,
    ).toHaveBeenCalledWith([
      "wechat_pay",
      "recharge_create",
      "identity-1",
    ]);
    expect(
      JSON.stringify(mocks.createPaymentProviderOperationScopeKey.mock.calls),
    ).not.toContain("203.0.113.9");
    expect(mocks.rechargeOrderFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.loadWeChatPayApiV3ConfigFromEnv).not.toHaveBeenCalled();
    expect(
      mocks.createWeChatPayApiV3PaymentProviderAdapter,
    ).not.toHaveBeenCalled();
    expect(mocks.createRechargeOrder).not.toHaveBeenCalled();
    expect(mocks.releasePaymentProviderOperation).not.toHaveBeenCalled();
    expect(mocks.setPublicAudienceSessionCookie).toHaveBeenCalledWith(
      response,
      request,
      "delegate",
      expect.objectContaining({
        audienceId: "aud_current_visitor",
      }),
    );
  });

  it("reuses a durable idempotent WeChat order without occupying the creation gate", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      status: "REQUIRES_PAYMENT",
    });

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: 2000,
          idempotencyKey: "existing-operation",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.claimPaymentProviderOperation).not.toHaveBeenCalled();
    expect(mocks.createRechargeOrder).toHaveBeenCalledOnce();
    expect(mocks.releasePaymentProviderOperation).not.toHaveBeenCalled();
  });

  it("claims the creation gate before retrying an unfinished local WeChat order", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      status: "CREATED",
    });

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: 2000,
          idempotencyKey: "unfinished-operation",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.claimPaymentProviderOperation).toHaveBeenCalledOnce();
    expect(mocks.createRechargeOrder).toHaveBeenCalledOnce();
    expect(mocks.releasePaymentProviderOperation).toHaveBeenCalledOnce();
  });

  it("reuses an idempotent order that finishes while its gate claim is deferred", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.rechargeOrderFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "REQUIRES_PAYMENT" });
    mocks.claimPaymentProviderOperation.mockResolvedValue({
      claimed: false,
      scopeKey: "a".repeat(64),
      retryAfterSeconds: 9,
    });

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: 2000,
          idempotencyKey: "raced-operation",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.createRechargeOrder).toHaveBeenCalledOnce();
    expect(mocks.releasePaymentProviderOperation).not.toHaveBeenCalled();
  });

  it("releases the fenced creation lease when provider creation fails", async () => {
    restoreEnv("NODE_ENV", "production");
    mocks.isWeChatPayApiV3Enabled.mockReturnValue(true);
    mocks.createRechargeOrder.mockRejectedValue(
      new Error("provider-internal-secret"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: 2000,
          idempotencyKey: "failed-operation",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.releasePaymentProviderOperation).toHaveBeenCalledWith({
      scopeKey: "a".repeat(64),
      leaseToken: "wechat-create-lease-1",
    });
    expect(await response.text()).not.toContain("provider-internal-secret");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "provider-internal-secret",
    );
  });

  it("does not expose the mock unused-credit reversal route in production", async () => {
    restoreEnv("NODE_ENV", "production");

    const response = await reverseRechargePurchase(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-reversal", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.agentTokenPurchaseFindFirst).not.toHaveBeenCalled();
    expect(mocks.reverseAgentTokenPurchase).not.toHaveBeenCalled();
  });

  it("rejects an order owned by a different browser audience or representative", async () => {
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      userWallet: { externalUserId: "web:other-rep:aud_other_visitor" },
    });

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).not.toHaveBeenCalled();
  });

  it("completes only an order belonging to the signed browser audience and representative", async () => {
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      representativeId: "rep-1",
      productCode: "agent-wallet:service-credit:v1",
      userWallet: { externalUserId: "web:delegate:aud_current_visitor" },
    });

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 2000 }),
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).toHaveBeenCalledWith({
      rechargeOrderId: "order-1",
      externalUserId: "web:delegate:aud_current_visitor",
      representativeId: "rep-1",
      amountCents: 2000,
      purchaseIdempotencyKey: "public_token_purchase:order-1",
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        rechargeOrder: expect.objectContaining({
          cashBalanceCents: 0,
        }),
        tokenPurchase: expect.objectContaining({
          id: "purchase-1",
          availableTokenAmount: 2000,
        }),
      }),
    );
  });

  it("does not complete a canonical wallet order through another representative", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "aud_current_visitor",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      sessionState: {
        audienceId: "aud_current_visitor",
        sessionToken: "session-token",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    });
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      representativeId: "rep-other",
      productCode: "agent-wallet:service-credit:v1",
      userWallet: {
        audienceIdentityId: "identity-1",
        externalUserId: "web:delegate:aud_current_visitor",
      },
    });

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).not.toHaveBeenCalled();
  });

  it("uses the canonical wallet owner after the same Logto user signs in on another browser", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "aud_first_browser",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      sessionState: {
        audienceId: "aud_second_browser",
        sessionToken: "second-browser-session",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    });
    mocks.resolvePublicAudienceWalletExternalUserId.mockResolvedValue(
      "web:delegate:aud_first_browser",
    );
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      representativeId: "rep-1",
      productCode: "agent-wallet:service-credit:v1",
      userWallet: {
        audienceIdentityId: "identity-1",
        externalUserId: "web:delegate:aud_first_browser",
      },
    });

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        rechargeOrderId: "order-1",
        externalUserId: "web:delegate:aud_first_browser",
        representativeId: "rep-1",
      }),
    );
  });

  it("does not authorize an authenticated user from a matching external id alone", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "aud_first_browser",
        audienceIdentityId: "identity-1",
        businessKey: "audience:identity-1",
      },
      sessionState: {
        audienceId: "aud_second_browser",
        sessionToken: "second-browser-session",
        expiresAt: "2026-07-30T00:00:00.000Z",
      },
    });
    mocks.resolvePublicAudienceWalletExternalUserId.mockResolvedValue(
      "web:delegate:aud_first_browser",
    );
    mocks.rechargeOrderFindUnique.mockResolvedValue({
      userWallet: {
        audienceIdentityId: "identity-other",
        externalUserId: "web:delegate:aud_first_browser",
      },
    });

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-other/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-other" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.completeMockRechargeAndPurchaseAgentTokens).not.toHaveBeenCalled();
  });

  it("returns only the signed visitor's unused representative credits to wallet cash", async () => {
    const response = await reverseRechargePurchase(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-reversal", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.agentTokenPurchaseFindFirst).toHaveBeenCalledWith({
      where: {
        rechargeOrderId: "order-1",
        representativeId: "rep-1",
        userWallet: {
          OR: [
            { audienceIdentityId: "identity-1" },
            { externalUserId: "web:delegate:aud_current_visitor" },
          ],
        },
      },
      select: {
        id: true,
        userWallet: {
          select: {
            externalUserId: true,
          },
        },
      },
    });
    expect(mocks.reverseAgentTokenPurchase).toHaveBeenCalledWith(
      "purchase-1",
      {
        reason: "public_demo_unused_credit_reversal",
        idempotencyKey: "public_demo_reversal:purchase-1",
      },
    );
    await expect(response.json()).resolves.toEqual({
      reversal: expect.objectContaining({
        purchaseId: "purchase-1",
        remainingTokenAmount: 0,
        cashBalanceCents: 2000,
      }),
      walletBalance: {
        availableTokenAmount: 0,
        reservedTokenAmount: 0,
      },
    });
  });

  it("does not reveal whether another visitor owns a recharge purchase", async () => {
    mocks.agentTokenPurchaseFindFirst.mockResolvedValue(null);

    const response = await reverseRechargePurchase(
      new Request("http://localhost/reps/delegate/recharge/order-other/mock-reversal", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-other" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.reverseAgentTokenPurchase).not.toHaveBeenCalled();
  });

  it("does not expose wallet or database exception details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rechargeOrderFindUnique.mockRejectedValue(
      new Error("postgres://wallet:secret@private-host/delegate"),
    );

    const response = await completeRecharge(
      new Request("http://localhost/reps/delegate/recharge/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "delegate", id: "order-1" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("模拟支付确认失败");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-host");
  });

  it("namespaces a stable client operation key to the representative and audience", async () => {
    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "checkout-click-1",
        },
        body: JSON.stringify({ amountCents: 2000 }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createMockRechargeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: "web:delegate:aud_current_visitor",
        representativeId: "rep-1",
        productCode: "agent-wallet:service-credit:v1",
        idempotencyKey:
          "public_recharge:delegate:audience:identity-1:checkout-click-1",
      }),
    );
  });

  it("generates a distinct operation id for separate same-amount requests", async () => {
    const request = () => new Request(
      "http://localhost/reps/delegate/recharge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 2000 }),
      },
    );

    await createRecharge(request(), {
      params: Promise.resolve({ slug: "delegate" }),
    });
    await createRecharge(request(), {
      params: Promise.resolve({ slug: "delegate" }),
    });

    const firstKey = mocks.createMockRechargeOrder.mock.calls[0]?.[0]?.idempotencyKey;
    const secondKey = mocks.createMockRechargeOrder.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstKey).toMatch(
      /^public_recharge:delegate:audience:identity-1:[0-9a-f-]{36}$/,
    );
    expect(secondKey).toMatch(
      /^public_recharge:delegate:audience:identity-1:[0-9a-f-]{36}$/,
    );
    expect(secondKey).not.toBe(firstKey);
  });

  it("rejects an oversized client idempotency key before creating an order", async () => {
    const response = await createRecharge(
      new Request("http://localhost/reps/delegate/recharge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "x".repeat(161),
        },
        body: JSON.stringify({ amountCents: 2000 }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createMockRechargeOrder).not.toHaveBeenCalled();
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
