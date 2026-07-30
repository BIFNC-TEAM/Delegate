import {
  AgentTokenPurchaseStatus,
  PaymentProvider,
  RechargeOrderStatus,
  WalletTransactionEventType,
  WalletTransactionStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPublicAgentWalletState,
  type PublicAgentWalletStateClient,
} from "../src";

const mocks = {
  userWalletFindMany: vi.fn(),
  userAgentWalletFindFirst: vi.fn(),
  rechargeOrderFindMany: vi.fn(),
  agentTokenPurchaseFindMany: vi.fn(),
  walletTransactionFindMany: vi.fn(),
};

const client: PublicAgentWalletStateClient = {
  userWallet: { findMany: mocks.userWalletFindMany },
  userAgentWallet: { findFirst: mocks.userAgentWalletFindFirst },
  rechargeOrder: { findMany: mocks.rechargeOrderFindMany },
  agentTokenPurchase: { findMany: mocks.agentTokenPurchaseFindMany },
  walletTransaction: { findMany: mocks.walletTransactionFindMany },
};

describe("public agent wallet state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userWalletFindMany.mockResolvedValue([
      { id: "wallet-private-1", cashBalanceCents: 1250 },
    ]);
    mocks.userAgentWalletFindFirst.mockResolvedValue({
      availableTokenAmount: 8,
      reservedTokenAmount: 2,
      totalPurchasedTokenAmount: 14,
      totalConsumedTokenAmount: 4,
    });
    mocks.rechargeOrderFindMany.mockResolvedValue([
      {
        id: "order-public-1",
        billingProductId: null,
        billingPriceVersionId: null,
        productName: null,
        entitlementUnits: null,
        unitName: null,
        amountCents: 2000,
        currency: "CNY",
        provider: PaymentProvider.MOCK,
        status: RechargeOrderStatus.PAID,
        checkoutUrl: null,
        providerPayload: {
          provider: "mock",
          private: "must-not-leak",
        },
        paidAt: new Date("2026-07-27T02:00:00.000Z"),
        refundedAt: null,
        createdAt: new Date("2026-07-27T01:00:00.000Z"),
      },
    ]);
    mocks.agentTokenPurchaseFindMany.mockResolvedValue([
      {
        id: "purchase-public-1",
        rechargeOrderId: "order-public-1",
        amountCents: 2000,
        currency: "CNY",
        tokenAmount: 20,
        remainingTokenAmount: 10,
        status: AgentTokenPurchaseStatus.COMPLETED,
        refundedAt: new Date("2026-07-27T03:00:00.000Z"),
        createdAt: new Date("2026-07-27T02:00:00.000Z"),
      },
    ]);
    mocks.walletTransactionFindMany.mockResolvedValue([
      {
        id: "refund-public-1",
        sourceId: "purchase-public-1",
        currency: "CNY",
        status: WalletTransactionStatus.SUCCEEDED,
        occurredAt: new Date("2026-07-27T03:00:00.000Z"),
        completedAt: new Date("2026-07-27T03:00:01.000Z"),
        metadata: {
          tokenAmount: 3,
          amountCents: 300,
          reason: "private-operation-reason",
          entitlementAccountId: "private-entitlement-id",
        },
      },
    ]);
  });

  it("scopes every record to the canonical audience, representative, and currency", async () => {
    const state = await getPublicAgentWalletState(
      {
        audienceIdentityId: "identity-1",
        representativeId: "rep-1",
        currency: "cny",
      },
      client,
    );

    expect(mocks.userWalletFindMany).toHaveBeenCalledWith({
      where: {
        audienceIdentityId: "identity-1",
        currency: "CNY",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      select: {
        id: true,
      },
    });
    expect(mocks.userAgentWalletFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userWalletId: "wallet-private-1",
          currency: "CNY",
          agentWallet: {
            representativeId: "rep-1",
            currency: "CNY",
          },
        },
      }),
    );
    expect(mocks.rechargeOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userWalletId: "wallet-private-1",
          representativeId: "rep-1",
          productCode: "agent-wallet:service-credit:v1",
          currency: "CNY",
        },
        take: 20,
      }),
    );
    expect(mocks.agentTokenPurchaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userWalletId: "wallet-private-1",
          audienceIdentityId: "identity-1",
          representativeId: "rep-1",
          currency: "CNY",
        },
        take: 20,
      }),
    );
    expect(mocks.walletTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userWalletId: "wallet-private-1",
          representativeId: "rep-1",
          currency: "CNY",
          sourceType: "AgentTokenPurchase",
          eventType: WalletTransactionEventType.REVERSAL,
          status: WalletTransactionStatus.SUCCEEDED,
        },
        take: 20,
      }),
    );
    expect(state).toEqual({
      summary: {
        currency: "CNY",
        serviceCreditsAvailable: 8,
        serviceCreditsReserved: 2,
        serviceCreditsPurchased: 14,
        serviceCreditsConsumed: 4,
      },
      orders: [{
        id: "order-public-1",
        billingProductId: null,
        billingPriceVersionId: null,
        productName: null,
        entitlementUnits: null,
        unitName: null,
        amountCents: 2000,
        currency: "CNY",
        provider: "mock",
        status: "paid",
        checkoutUrl: null,
        checkoutExpiresAt: null,
        paidAt: "2026-07-27T02:00:00.000Z",
        refundedAt: null,
        createdAt: "2026-07-27T01:00:00.000Z",
      }],
      purchases: [{
        id: "purchase-public-1",
        rechargeOrderId: "order-public-1",
        amountCents: 2000,
        currency: "CNY",
        tokenAmount: 20,
        remainingTokenAmount: 10,
        status: "completed",
        refundedAt: "2026-07-27T03:00:00.000Z",
        createdAt: "2026-07-27T02:00:00.000Z",
      }],
      refunds: [{
        id: "refund-public-1",
        purchaseId: "purchase-public-1",
        currency: "CNY",
        tokenAmount: 3,
        amountCents: 300,
        status: "succeeded",
        completedAt: "2026-07-27T03:00:01.000Z",
      }],
    });

    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("wallet-private-1");
    expect(serialized).not.toContain("identity-1");
    expect(serialized).not.toContain("private-operation-reason");
    expect(serialized).not.toContain("private-entitlement-id");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("exposes only a canonical Native expiry from a pending WeChat payload", async () => {
    mocks.rechargeOrderFindMany.mockResolvedValue([
      {
        id: "order-wechat-1",
        amountCents: 2000,
        currency: "CNY",
        provider: PaymentProvider.WECHAT_PAY,
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        checkoutUrl: "weixin://wxpay/bizpayurl?pr=safe-checkout",
        providerPayload: {
          provider: "wechat_pay",
          merchantId: "private-merchant-id",
          rawPayload: {
            mode: "native",
            outTradeNo: "private-out-trade-no",
            expiresAt: "2026-07-27T02:10:00.000Z",
          },
        },
        paidAt: null,
        refundedAt: null,
        createdAt: new Date("2026-07-27T02:00:00.000Z"),
      },
    ]);
    mocks.agentTokenPurchaseFindMany.mockResolvedValue([]);
    mocks.walletTransactionFindMany.mockResolvedValue([]);

    const state = await getPublicAgentWalletState(
      {
        audienceIdentityId: "identity-1",
        representativeId: "rep-1",
      },
      client,
    );

    expect(state.orders[0]).toEqual({
      id: "order-wechat-1",
      billingProductId: null,
      billingPriceVersionId: null,
      productName: null,
      entitlementUnits: null,
      unitName: null,
      amountCents: 2000,
      currency: "CNY",
      provider: "wechat_pay",
      status: "requires_payment",
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=safe-checkout",
      checkoutExpiresAt: "2026-07-27T02:10:00.000Z",
      paidAt: null,
      refundedAt: null,
      createdAt: "2026-07-27T02:00:00.000Z",
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("private-merchant-id");
    expect(serialized).not.toContain("private-out-trade-no");
    expect(serialized).not.toContain("providerPayload");
  });

  it("returns an empty, currency-specific state before a wallet exists", async () => {
    mocks.userWalletFindMany.mockResolvedValue([]);

    const state = await getPublicAgentWalletState(
      {
        audienceIdentityId: "identity-new",
        representativeId: "rep-1",
        currency: "USD",
      },
      client,
    );

    expect(state).toEqual({
      summary: {
        currency: "USD",
        serviceCreditsAvailable: 0,
        serviceCreditsReserved: 0,
        serviceCreditsPurchased: 0,
        serviceCreditsConsumed: 0,
      },
      orders: [],
      purchases: [],
      refunds: [],
    });
    expect(mocks.userAgentWalletFindFirst).not.toHaveBeenCalled();
    expect(mocks.rechargeOrderFindMany).not.toHaveBeenCalled();
    expect(mocks.agentTokenPurchaseFindMany).not.toHaveBeenCalled();
    expect(mocks.walletTransactionFindMany).not.toHaveBeenCalled();
  });

  it("fails closed when one canonical identity has multiple currency wallets", async () => {
    mocks.userWalletFindMany.mockResolvedValue([
      { id: "wallet-1", cashBalanceCents: 0 },
      { id: "wallet-2", cashBalanceCents: 0 },
    ]);

    await expect(
      getPublicAgentWalletState(
        {
          audienceIdentityId: "identity-1",
          representativeId: "rep-1",
          currency: "CNY",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "WALLET_IDENTITY_CONFLICT",
    });
    expect(mocks.rechargeOrderFindMany).not.toHaveBeenCalled();
  });

  it("omits malformed refund metadata instead of exposing raw transaction data", async () => {
    mocks.walletTransactionFindMany.mockResolvedValue([
      {
        id: "refund-malformed",
        sourceId: "purchase-public-1",
        currency: "CNY",
        status: WalletTransactionStatus.SUCCEEDED,
        occurredAt: new Date("2026-07-27T03:00:00.000Z"),
        completedAt: null,
        metadata: {
          tokenAmount: -1,
          amountCents: "300",
          rawPayload: "provider-secret",
        },
      },
    ]);

    const state = await getPublicAgentWalletState(
      {
        audienceIdentityId: "identity-1",
        representativeId: "rep-1",
      },
      client,
    );

    expect(state.refunds).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("provider-secret");
  });

  it("rejects unsupported currencies before querying wallet records", async () => {
    await expect(
      getPublicAgentWalletState(
        {
          audienceIdentityId: "identity-1",
          representativeId: "rep-1",
          currency: "EUR",
        },
        client,
      ),
    ).rejects.toThrow("Unsupported public wallet currency");
    expect(mocks.userWalletFindMany).not.toHaveBeenCalled();
  });
});
