import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  assertMockRechargeMutationsEnabled,
  AGENT_WALLET_TIP_PRODUCT_CODE,
  completeMockRechargeAndPurchaseAgentTokens,
  completeRechargeFromProviderWebhook,
  completeMockRechargeOrder,
  createRechargeOrder,
  createMockRechargeOrder,
  readWeChatPayCheckoutExpiresAt,
} from "../src/agent-wallet-recharge";
import type {
  NormalizedPaymentProviderEvent,
  PaymentProviderAdapter,
} from "../src/agent-wallet-payment-providers";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "../src/service-entitlements";

describe("agent wallet mock recharge", () => {
  it("derives only canonical Native checkout expiry values", () => {
    expect(
      readWeChatPayCheckoutExpiresAt({
        provider: "wechat_pay",
        privateMerchantField: "must-not-leak",
        rawPayload: {
          mode: "native",
          expiresAt: "2026-07-27T10:10:00.000Z",
        },
      }),
    ).toBe("2026-07-27T10:10:00.000Z");
    expect(
      readWeChatPayCheckoutExpiresAt({
        rawPayload: {
          mode: "native",
          expiresAt: "2026-07-27T10:10:00Z",
        },
      }),
    ).toBeNull();
    expect(
      readWeChatPayCheckoutExpiresAt({
        rawPayload: {
          mode: "jsapi",
          expiresAt: "2026-07-27T10:10:00.000Z",
        },
      }),
    ).toBeNull();
  });

  it("disables mock recharge mutations in production", () => {
    expect(() =>
      assertMockRechargeMutationsEnabled({ NODE_ENV: "production" }),
    ).toThrow("disabled in production");
    expect(() =>
      assertMockRechargeMutationsEnabled({ NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      assertMockRechargeMutationsEnabled({}),
    ).toThrow("production-like");
  });

  it("rejects direct mock recharge writes before touching storage in production", async () => {
    const client = new FakeRechargeClient();
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        createMockRechargeOrder(
          {
            externalUserId: "user_1",
            amountCents: 1200,
          },
          client,
        ),
      ).rejects.toThrow("disabled in production");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(client.userWallets).toHaveLength(0);
    expect(client.rechargeOrders).toHaveLength(0);
  });

  it("creates a mock recharge order idempotently", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        displayName: "User One",
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(first.status).toBe("requires_payment");
    expect(client.rechargeOrders).toHaveLength(1);
    expect(client.userWallets[0]).toMatchObject({
      externalUserId: "user_1",
      cashBalanceCents: 0,
    });
  });

  it("rejects an idempotency key reused by another owner, amount, or currency", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_facts_bound",
      },
      client,
    );

    const mismatchedRequests = [
      {
          externalUserId: "user_2",
          amountCents: 1200,
          currency: "CNY",
          idempotencyKey: "recharge_facts_bound",
      },
      {
          externalUserId: "user_1",
          amountCents: 1201,
          currency: "CNY",
          idempotencyKey: "recharge_facts_bound",
      },
      {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_facts_bound",
      },
    ];

    for (const request of mismatchedRequests) {
      await expect(
        createMockRechargeOrder(request, client),
      ).rejects.toThrow();
    }

    expect(client.rechargeOrders).toHaveLength(1);
    expect(client.userWallets).toHaveLength(1);
  });

  it("persists representative product intent and rejects cross-context replay", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        amountCents: 1200,
        idempotencyKey: "recharge_purchase_intent",
      },
      client,
    );

    expect(client.rechargeOrders[0]).toMatchObject({
      representativeId: "rep_1",
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
    });
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          representativeId: "rep_other",
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1200,
          idempotencyKey: "recharge_purchase_intent",
        },
        client,
      ),
    ).rejects.toThrow("different representative");
  });

  it("freezes a complete immutable commercial snapshot on a billing order", async () => {
    const client = new FakeRechargeClient();
    const input = {
      externalUserId: "user_1",
      representativeId: "rep_1",
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      billingProductId: "product_1",
      billingPriceVersionId: "price_v1",
      productNameSnapshot: "标准服务包",
      productKindSnapshot: "SERVICE_PACKAGE" as const,
      unitNameSnapshot: "credit" as const,
      entitlementUnitsSnapshot: 333,
      handoffAllowanceSnapshot: "LIMITED" as const,
      handoffUnitsSnapshot: 2,
      handoffServiceLevelSnapshot: "PRIORITY" as const,
      handoffValidityDaysSnapshot: 30,
      creatorRevenueShareBpsSnapshot: 2500,
      platformRevenueShareBpsSnapshot: 7500,
      refundPolicySnapshot: "FULL_WHEN_UNUSED" as const,
      expiryPolicySnapshot: "NEVER_EXPIRES" as const,
      entitlementValidityDaysSnapshot: null,
      amountCents: 1200,
      idempotencyKey: "recharge_commercial_snapshot",
    };

    const first = await createMockRechargeOrder(input, client);
    const replay = await createMockRechargeOrder(input, client);

    expect(replay.id).toBe(first.id);
    expect(client.rechargeOrders[0]).toMatchObject({
      billingProductId: "product_1",
      billingPriceVersionId: "price_v1",
      productNameSnapshot: "标准服务包",
      productKindSnapshot: "SERVICE_PACKAGE",
      unitNameSnapshot: "credit",
      entitlementUnitsSnapshot: 333,
      handoffAllowanceSnapshot: "LIMITED",
      handoffUnitsSnapshot: 2,
      handoffServiceLevelSnapshot: "PRIORITY",
      handoffValidityDaysSnapshot: 30,
      creatorRevenueShareBpsSnapshot: 2500,
      platformRevenueShareBpsSnapshot: 7500,
      refundPolicySnapshot: "FULL_WHEN_UNUSED",
      expiryPolicySnapshot: "NEVER_EXPIRES",
      entitlementValidityDaysSnapshot: null,
    });
    await expect(
      createMockRechargeOrder(
        {
          ...input,
          billingPriceVersionId: "price_v2",
        },
        client,
      ),
    ).rejects.toThrow("different billing price version");
  });

  it("fulfills a paid tip exactly once without issuing service credits", async () => {
    const client = new FakeRechargeClient();
    const recharge = await createMockRechargeOrder(
      {
        externalUserId: "tip_payer",
        audienceIdentityId: "audience_tip_payer",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_TIP_PRODUCT_CODE,
        billingProductId: "tip_product_1",
        billingPriceVersionId: "tip_price_1",
        productNameSnapshot: "感谢支持",
        productKindSnapshot: "TIP",
        unitNameSnapshot: "tip",
        entitlementUnitsSnapshot: 0,
        handoffAllowanceSnapshot: "NONE",
        handoffUnitsSnapshot: null,
        handoffServiceLevelSnapshot: null,
        handoffValidityDaysSnapshot: null,
        creatorRevenueShareBpsSnapshot: 2500,
        platformRevenueShareBpsSnapshot: 7500,
        refundPolicySnapshot: "NON_REFUNDABLE",
        expiryPolicySnapshot: "NEVER_EXPIRES",
        entitlementValidityDaysSnapshot: null,
        amountCents: 101,
        idempotencyKey: "tip_recharge_1",
      },
      client,
    );

    const first = await completeMockRechargeAndPurchaseAgentTokens(
      {
        rechargeOrderId: recharge.id,
        externalUserId: "tip_payer",
        representativeId: "rep_1",
      },
      client as never,
    );
    const replay = await completeMockRechargeAndPurchaseAgentTokens(
      {
        rechargeOrderId: recharge.id,
        externalUserId: "tip_payer",
        representativeId: "rep_1",
      },
      client as never,
    );

    expect(first).toMatchObject({
      productKind: "TIP",
      tokenPurchase: null,
      rechargeOrder: { status: "paid", cashBalanceCents: 0 },
      fulfillment: {
        kind: "TIP",
        tipContribution: {
          amountMinor: 101,
          creatorAmountMinor: 25,
          platformAmountMinor: 76,
          status: "completed",
        },
        creatorEarning: {
          status: "withdrawable",
          withdrawableCents: 25,
        },
        cashBalanceCents: 0,
      },
    });
    expect(replay.fulfillment).toEqual(first.fulfillment);

    const earning = client.creatorEarnings[0]!;
    earning.status = CreatorEarningStatus.FROZEN;
    earning.withdrawableCents = 0;
    earning.frozenCents = 25;
    const replayAfterFreeze = await completeMockRechargeAndPurchaseAgentTokens(
      {
        rechargeOrderId: recharge.id,
        externalUserId: "tip_payer",
        representativeId: "rep_1",
      },
      client as never,
    );
    expect(replayAfterFreeze.fulfillment).toMatchObject({
      kind: "TIP",
      creatorEarning: {
        status: "frozen",
        withdrawableCents: 0,
        frozenCents: 25,
      },
    });

    earning.status = CreatorEarningStatus.WITHDRAWN;
    earning.frozenCents = 0;
    earning.withdrawnCents = 25;
    const replayAfterWithdrawal =
      await completeMockRechargeAndPurchaseAgentTokens(
        {
          rechargeOrderId: recharge.id,
          externalUserId: "tip_payer",
          representativeId: "rep_1",
        },
        client as never,
      );
    expect(replayAfterWithdrawal.fulfillment).toMatchObject({
      kind: "TIP",
      creatorEarning: {
        status: "withdrawn",
        withdrawnCents: 25,
      },
    });

    expect(client.tipContributions).toHaveLength(1);
    expect(client.creatorEarnings).toHaveLength(1);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    const tipEntries = client.ledgerEntries.filter(
      (entry) => entry.eventGroupId === "tip:tip_contribution_1",
    );
    expect(tipEntries).toHaveLength(3);
    expect(sumLedgerAmount(tipEntries)).toBe(0);
    expect(tipEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.USER_CASH,
          amountCents: -101,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          amountCents: 25,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
          amountCents: 76,
        }),
      ]),
    );
  });

  it("does not collapse separate keyless same-amount recharge operations", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
      },
      client,
    );

    expect(second.id).not.toBe(first.id);
    expect(client.rechargeOrders).toHaveLength(2);
  });

  it("attaches mock recharge wallets to an audience identity when provided", async () => {
    const client = new FakeRechargeClient();

    await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_123",
        audienceIdentityId: "identity-1",
        amountCents: 1200,
        idempotencyKey: "recharge_identity_1_1200",
      },
      client,
    );

    expect(client.userWallets[0]).toMatchObject({
      externalUserId: "web:rep:aud_123",
      audienceIdentityId: "identity-1",
    });
  });

  it("reuses the audience identity wallet across changing payment external ids", async () => {
    const client = new FakeRechargeClient();

    const first = await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_first",
        audienceIdentityId: "identity-1",
        amountCents: 1200,
        idempotencyKey: "recharge_identity_1_first",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_second",
        audienceIdentityId: "identity-1",
        amountCents: 2400,
        idempotencyKey: "recharge_identity_1_second",
      },
      client,
    );

    expect(second.userWalletId).toBe(first.userWalletId);
    expect(second.externalUserId).toBe("web:rep:aud_first");
    expect(client.userWallets).toHaveLength(1);
    expect(client.identityLinks).toEqual([
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: "web:rep:aud_first",
      }),
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: "web:rep:aud_second",
      }),
    ]);
  });

  it("does not change the currency of an existing user wallet", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_cny",
      },
      client,
    );

    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_usd",
        },
        client,
      ),
    ).rejects.toThrow("currency cannot be changed");
    expect(client.userWallets[0]?.currency).toBe("CNY");
  });

  it("completes payment once and credits the user wallet ledger", async () => {
    const client = new FakeRechargeClient();
    const created = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    const paid = await completeMockRechargeOrder(created.id, {}, client);
    const paidAgain = await completeMockRechargeOrder(created.id, {}, client);

    expect(paid.status).toBe("paid");
    expect(paid.cashBalanceCents).toBe(1200);
    expect(paidAgain.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries[0]).toMatchObject({
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: `recharge:${created.id}:paid:user_cash_recharge`,
    });
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
  });

  it("rejects a mock payment with the wrong amount", async () => {
    const client = new FakeRechargeClient();
    const created = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    await expect(
      completeMockRechargeOrder(created.id, { amountCents: 1000 }, client),
    ).rejects.toThrow("amount does not match");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("does not allow a provider event id to be attached to another order", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_first",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_second",
      },
      client,
    );

    await completeMockRechargeOrder(
      first.id,
      { providerEventId: "evt_bound_once" },
      client,
    );
    await expect(
      completeMockRechargeOrder(
        second.id,
        { providerEventId: "evt_bound_once" },
        client,
      ),
    ).rejects.toThrow("already attached to another");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
  });

  it("rejects invalid recharge input", async () => {
    const client = new FakeRechargeClient();
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "",
          amountCents: 1200,
        },
        client,
      ),
    ).rejects.toThrow("externalUserId");
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 12.5,
        },
        client,
      ),
    ).rejects.toThrow("positive integer");
  });

  it("does not relabel an existing wallet into another currency", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_cny",
      },
      client,
    );

    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_usd",
        },
        client,
      ),
    ).rejects.toThrow("currency cannot be changed");
    expect(client.userWallets[0]?.currency).toBe("CNY");
  });

  it("creates a WeChat order locally before requesting its checkout", async () => {
    const client = new FakeRechargeClient();
    const checkoutInputs: Array<{
      rechargeOrderId?: string;
      idempotencyKey: string;
    }> = [];
    const adapter = weChatAdapter({
      createRechargeCheckout: async (input) => {
        checkoutInputs.push(input);
        return {
          provider: PaymentProvider.WECHAT_PAY,
          providerOrderId: input.rechargeOrderId!,
          checkoutUrl: "weixin://wxpay/bizpayurl?pr=test",
          providerPayload: {
            mode: "native",
            expiresAt: "2026-07-27T10:10:00.000Z",
            merchantSecret: "must-not-leak",
          },
        };
      },
    });

    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_recharge_1",
      },
      adapter,
      client,
    );

    expect(order).toMatchObject({
      provider: "wechat_pay",
      status: "requires_payment",
      providerOrderId: order.id,
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=test",
      checkoutExpiresAt: "2026-07-27T10:10:00.000Z",
    });
    expect(JSON.stringify(order)).not.toContain("must-not-leak");
    expect(JSON.stringify(order)).not.toContain("providerPayload");
    expect(checkoutInputs).toEqual([
      expect.objectContaining({
        rechargeOrderId: order.id,
        idempotencyKey: "wechat_recharge_1",
      }),
    ]);
    expect(client.outboxEvents).toEqual([
      expect.objectContaining({
        aggregateType: "recharge_order",
        aggregateId: order.id,
        eventType: "wechat_pay.order.reconcile",
        status: "PENDING",
        idempotencyKey: `wechat_pay:reconcile:${order.id}`,
      }),
    ]);
  });

  it("durably records a frozen CREATED recovery job before the first WeChat provider request and never blindly re-posts its replay", async () => {
    const client = new FakeRechargeClient();
    const createRechargeCheckout = vi.fn(async (input) => {
      expect(client.rechargeOrders[0]).toMatchObject({
        status: RechargeOrderStatus.CREATED,
        providerPayload: {
          provider: "wechat_pay",
          rawPayload: {
            version: 1,
            outTradeNo: "recharge_1",
          },
        },
      });
      expect(client.outboxEvents[0]).toMatchObject({
        aggregateId: "recharge_1",
        status: "PENDING",
      });
      expect(input.preparedProviderPayload).toEqual(
        client.rechargeOrders[0]!.providerPayload,
      );
      throw Object.assign(
        new Error("ambiguous provider timeout"),
        { code: "WECHAT_PAY_PROTOCOL_ERROR" },
      );
    });
    const adapter = weChatAdapter({
      prepareRechargeCheckout: async (input) => ({
        provider: "wechat_pay",
        rawPayload: {
          version: 1,
          mode: "native",
          outTradeNo: input.rechargeOrderId!,
          expiresAt: "2026-07-27T12:00:00.000Z",
        },
      }),
      createRechargeCheckout,
    });
    const input = {
      externalUserId: "user_wechat_timeout",
      amountCents: 1_200,
      currency: "CNY",
      idempotencyKey: "wechat_recharge_timeout",
    };

    await expect(
      createRechargeOrder(input, adapter, client),
    ).rejects.toThrow("ambiguous provider timeout");
    const replay = await createRechargeOrder(
      input,
      adapter,
      client,
    );

    expect(replay).toMatchObject({
      id: "recharge_1",
      status: "created",
      checkoutUrl: null,
    });
    expect(createRechargeCheckout).toHaveBeenCalledOnce();
    expect(client.rechargeOrders).toHaveLength(1);
    expect(client.outboxEvents).toHaveLength(1);
    expect(
      client.outboxEvents[0]!.availableAt.getTime()
      - Date.now(),
    ).toBeGreaterThan(60_000);
  });

  it("rolls back the CREATED order when its durable WeChat recovery fact cannot be written", async () => {
    const client = new FakeRechargeClient();
    client.outboxEvent.upsert = vi.fn(async () => {
      throw new Error("outbox unavailable");
    });
    const createRechargeCheckout = vi.fn();

    await expect(
      createRechargeOrder(
        {
          externalUserId: "user_wechat_atomic",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_recharge_atomic",
        },
        weChatAdapter({ createRechargeCheckout }),
        client,
      ),
    ).rejects.toThrow("outbox unavailable");

    expect(client.rechargeOrders).toHaveLength(0);
    expect(client.userWallets).toHaveLength(0);
    expect(createRechargeCheckout).not.toHaveBeenCalled();
  });

  it("rolls back local creation when the database-held provider gate is no longer owned", async () => {
    const client = new FakeRechargeClient();
    const createRechargeCheckout = vi.fn();
    const renewBeforeProviderCreate = vi.fn();

    await expect(
      createRechargeOrder(
        {
          externalUserId: "user_wechat_stale_local_owner",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_stale_local_owner",
          creationFence: {
            lockBeforeLocalCreate: async () => {
              throw new Error("provider creation lease lost");
            },
            renewBeforeProviderCreate,
          },
        },
        weChatAdapter({ createRechargeCheckout }),
        client,
      ),
    ).rejects.toThrow("provider creation lease lost");

    expect(client.userWallets).toHaveLength(0);
    expect(client.rechargeOrders).toHaveLength(0);
    expect(client.outboxEvents).toHaveLength(0);
    expect(renewBeforeProviderCreate).not.toHaveBeenCalled();
    expect(createRechargeCheckout).not.toHaveBeenCalled();
  });

  it("never POSTs after the creation lease is lost following the durable local intent", async () => {
    const client = new FakeRechargeClient();
    const createRechargeCheckout = vi.fn();
    const lockBeforeLocalCreate = vi.fn();

    await expect(
      createRechargeOrder(
        {
          externalUserId: "user_wechat_stale_remote_owner",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_stale_remote_owner",
          creationFence: {
            lockBeforeLocalCreate,
            renewBeforeProviderCreate: async () => {
              throw new Error("provider creation lease lost");
            },
          },
        },
        weChatAdapter({ createRechargeCheckout }),
        client,
      ),
    ).rejects.toThrow("provider creation lease lost");

    expect(lockBeforeLocalCreate).toHaveBeenCalledOnce();
    expect(client.rechargeOrders).toEqual([
      expect.objectContaining({
        status: RechargeOrderStatus.CREATED,
        idempotencyKey: "wechat_stale_remote_owner",
      }),
    ]);
    expect(client.outboxEvents).toHaveLength(1);
    expect(createRechargeCheckout).not.toHaveBeenCalled();
  });

  it("credits a verified WeChat SUCCESS directly from an ambiguous CREATED order", async () => {
    const client = new FakeRechargeClient();
    const adapter = weChatAdapter({
      createRechargeCheckout: async () => {
        throw new Error("provider response lost");
      },
      normalizeWebhookEvent: async () =>
        normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId: "EVT_WECHAT_CREATED_SUCCESS",
          providerTransactionId:
            "4200000000000000099",
        }),
    });

    await expect(
      createRechargeOrder(
        {
          externalUserId: "user_wechat_created_success",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_created_success",
        },
        adapter,
        client,
      ),
    ).rejects.toThrow("provider response lost");

    const paid = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "verified-success" },
      client,
    );

    expect(paid).toMatchObject({
      id: "recharge_1",
      providerOrderId: "recharge_1",
      status: "paid",
      cashBalanceCents: 1_200,
    });
    expect(client.rechargeOrders[0]).toMatchObject({
      status: RechargeOrderStatus.PAID,
      providerOrderId: "recharge_1",
      providerTransactionId:
        "4200000000000000099",
    });
    expect(client.providerEvents).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
  });

  it("credits one WeChat transaction once across differently-id'd notifications", async () => {
    const client = new FakeRechargeClient();
    let providerEventId = "EVT_WECHAT_1";
    let providerTransactionId = "4200000000000000001";
    const adapter = weChatAdapter({
      normalizeWebhookEvent: async () =>
        normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId,
          providerTransactionId,
        }),
    });
    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_recharge_paid_1",
      },
      adapter,
      client,
    );

    const paid = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-event-1" },
      client,
    );
    providerEventId = "EVT_WECHAT_RETRY_DIFFERENT_ID";
    const replayed = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-event-2" },
      client,
    );

    expect(paid.cashBalanceCents).toBe(1200);
    expect(replayed.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);

    providerTransactionId = "4200000000000000002";
    await expect(
      completeRechargeFromProviderWebhook(
        adapter,
        { rawBody: "different-transaction" },
        client,
      ),
    ).rejects.toThrow("providerTransactionId");
    expect(order.id).toBe(paid.id);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
  });

  it("credits a verified late WeChat payment after a local cancellation exactly once", async () => {
    const client = new FakeRechargeClient();
    let providerEventId = "EVT_WECHAT_LATE_PAYMENT";
    const providerTransactionId = "4200000000000000006";
    const adapter = weChatAdapter({
      normalizeWebhookEvent: async () =>
        normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId,
          providerTransactionId,
        }),
    });
    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat_late_payment",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_late_payment",
      },
      adapter,
      client,
    );
    client.rechargeOrders[0]!.status = RechargeOrderStatus.CANCELED;
    client.rechargeOrders[0]!.checkoutUrl = null;

    const paid = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-late-payment" },
      client,
    );
    providerEventId = "EVT_WECHAT_LATE_PAYMENT_REPLAY";
    const replayed = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-late-payment-replay" },
      client,
    );

    expect(paid).toMatchObject({
      id: order.id,
      status: "paid",
      cashBalanceCents: 1200,
    });
    expect(replayed).toEqual(paid);
    expect(client.rechargeOrders[0]).toMatchObject({
      status: RechargeOrderStatus.PAID,
      providerTransactionId,
    });
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
  });

  it("fails closed when a successful WeChat refund was persisted before payment confirmation", async () => {
    const client = new FakeRechargeClient();
    const adapter = weChatAdapter({
      normalizeWebhookEvent: async () =>
        normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId: "EVT_WECHAT_REFUNDED_BEFORE_PAYMENT",
          providerTransactionId: "4200000000000000004",
        }),
    });
    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat_refunded_before_payment",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_refunded_before_payment",
      },
      adapter,
      client,
    );
    client.rechargeRefunds.push({
      id: "refund_1",
      rechargeOrderId: order.id,
      provider: PaymentProvider.WECHAT_PAY,
      providerStatus: RechargeRefundProviderStatus.SUCCEEDED,
    });

    await expect(
      completeRechargeFromProviderWebhook(
        adapter,
        { rawBody: "signed-refunded-payment-event" },
        client,
      ),
    ).rejects.toThrow(
      "already has a successful provider refund",
    );

    expect(client.rechargeOrders[0]).toMatchObject({
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      providerTransactionId: null,
      paidAt: null,
    });
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    expect(client.providerEvents).toHaveLength(0);
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
    expect(client.rechargeRefunds).toHaveLength(1);
  });

  it("keeps an already-paid WeChat transaction idempotent after a successful refund fact", async () => {
    const client = new FakeRechargeClient();
    let providerEventId = "EVT_WECHAT_PAID_BEFORE_REFUND";
    const providerTransactionId = "4200000000000000005";
    const adapter = weChatAdapter({
      normalizeWebhookEvent: async () =>
        normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId,
          providerTransactionId,
        }),
    });
    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat_paid_before_refund",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_paid_before_refund",
      },
      adapter,
      client,
    );
    const paid = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-paid-event" },
      client,
    );
    client.rechargeRefunds.push({
      id: "refund_after_payment",
      rechargeOrderId: order.id,
      provider: PaymentProvider.WECHAT_PAY,
      providerStatus: RechargeRefundProviderStatus.SUCCEEDED,
    });
    providerEventId = "EVT_WECHAT_PAYMENT_REPLAY_AFTER_REFUND";

    const replayed = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-replay-after-refund" },
      client,
    );

    expect(replayed).toEqual(paid);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(client.rechargeRefunds).toHaveLength(1);
  });

  it("uses the provider occurrence time for paidAt while retaining verification processing time", async () => {
    const client = new FakeRechargeClient();
    const providerOccurredAt = new Date(
      "2026-07-27T08:00:01.000Z",
    );
    const verifiedAt = new Date("2026-07-27T08:00:09.000Z");
    const adapter = weChatAdapter({
      normalizeWebhookEvent: async () => ({
        ...normalizedWeChatPaidEvent({
          orderId: "recharge_1",
          providerEventId: "EVT_WECHAT_PROVIDER_TIME",
          providerTransactionId: "4200000000000000003",
        }),
        providerOccurredAt,
        verifiedAt,
      }),
    });
    const order = await createRechargeOrder(
      {
        externalUserId: "user_wechat_provider_time",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "wechat_recharge_provider_time",
      },
      adapter,
      client,
    );

    const paid = await completeRechargeFromProviderWebhook(
      adapter,
      { rawBody: "signed-provider-time-event" },
      client,
    );

    expect(paid.id).toBe(order.id);
    expect(paid.paidAt).toBe(providerOccurredAt.toISOString());
    expect(client.rechargeOrders[0]?.paidAt).toEqual(
      providerOccurredAt,
    );
    expect(client.providerEvents[0]?.processedAt).toEqual(verifiedAt);
  });
});

function weChatAdapter(
  overrides: Partial<PaymentProviderAdapter>,
): PaymentProviderAdapter {
  return {
    provider: PaymentProvider.WECHAT_PAY,
    async createRechargeCheckout(input) {
      return {
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: input.rechargeOrderId!,
        checkoutUrl: "weixin://wxpay/bizpayurl?pr=test",
        providerPayload: {
          mode: "native",
        },
      };
    },
    async normalizeWebhookEvent() {
      throw new Error("Webhook normalization was not configured.");
    },
    ...overrides,
  };
}

function normalizedWeChatPaidEvent(input: {
  orderId: string;
  providerEventId: string;
  providerTransactionId: string;
}): NormalizedPaymentProviderEvent {
  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId: input.providerEventId,
    providerTransactionId: input.providerTransactionId,
    eventType: PaymentProviderEventType.RECHARGE_PAID,
    rechargeOrderId: input.orderId,
    providerOrderId: input.orderId,
    amountCents: 1200,
    currency: "CNY",
    rawPayload: {
      id: input.providerEventId,
      resource: {
        ciphertext: "encrypted",
      },
    },
    normalizedPayload: {
      providerTransactionId: input.providerTransactionId,
    },
    idempotencyKey: `wechat_pay:${input.providerEventId}`,
    verifiedAt: new Date("2026-07-27T00:00:00.000Z"),
  };
}

type UserWalletRow = {
  id: string;
  audienceIdentityId: string | null;
  externalUserId: string;
  telegramUserId: string | null;
  email: string | null;
  displayName: string | null;
  currency: string;
  cashBalanceCents: number;
};

type RechargeOrderRow = {
  id: string;
  userWalletId: string;
  representativeId: string | null;
  productCode: string | null;
  billingProductId?: string | null;
  billingPriceVersionId?: string | null;
  productNameSnapshot?: string | null;
  productKindSnapshot?: string | null;
  unitNameSnapshot?: string | null;
  entitlementUnitsSnapshot?: number | null;
  handoffAllowanceSnapshot?: string | null;
  handoffUnitsSnapshot?: number | null;
  handoffServiceLevelSnapshot?: string | null;
  handoffValidityDaysSnapshot?: number | null;
  creatorRevenueShareBpsSnapshot?: number | null;
  platformRevenueShareBpsSnapshot?: number | null;
  refundPolicySnapshot?: string | null;
  expiryPolicySnapshot?: string | null;
  entitlementValidityDaysSnapshot?: number | null;
  provider: PaymentProvider;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  idempotencyKey: string;
  checkoutUrl: string | null;
  providerPayload?: unknown;
  paidAt: Date | null;
  refundedAt: Date | null;
  userWallet?: UserWalletRow;
};

type ProviderEventRow = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  providerTransactionId: string | null;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
  processedAt: Date | null;
};

type RechargeRefundRow = {
  id: string;
  rechargeOrderId: string;
  provider: PaymentProvider;
  providerStatus: RechargeRefundProviderStatus;
};

type LedgerRow = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  transactionId: string | null;
  createdAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: string;
  providerSubject: string;
};

type TipCreatorEarningRow = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  status: CreatorEarningStatus;
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents: number;
  currency: string;
  revenueShareBps: number;
  idempotencyKey: string;
};

type TipContributionRow = {
  id: string;
  rechargeOrderId: string;
  audienceIdentityId: string;
  representativeId: string;
  agentWalletId: string;
  creatorEarningId: string;
  amountMinor: number;
  currency: string;
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  creatorAmountMinor: number;
  platformAmountMinor: number;
  status: string;
  idempotencyKey: string;
  completedAt: Date;
  creatorEarning?: TipCreatorEarningRow;
};

class FakeRechargeClient {
  userWallets: UserWalletRow[] = [];
  rechargeOrders: RechargeOrderRow[] = [];
  rechargeRefunds: RechargeRefundRow[] = [];
  providerEvents: ProviderEventRow[] = [];
  ledgerEntries: LedgerRow[] = [];
  identityLinks: IdentityLinkRow[] = [];
  walletTransactions: any[] = [];
  outboxEvents: any[] = [];
  creatorEarnings: TipCreatorEarningRow[] = [];
  tipContributions: TipContributionRow[] = [];

  outboxEvent = {
    upsert: async (args: any) => {
      const existing = this.outboxEvents.find(
        (row) =>
          row.idempotencyKey === args.where.idempotencyKey,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row = {
        id: `outbox_${this.outboxEvents.length + 1}`,
        ...args.create,
        attemptCount: 0,
        processedAt: null,
        lastError: null,
      };
      this.outboxEvents.push(row);
      return row;
    },
  };

  userWallet = {
    findFirst: async (args: any) => {
      return (
        this.userWallets.find(
          (wallet) => wallet.audienceIdentityId === args.where.audienceIdentityId,
        ) ?? null
      );
    },
    findUnique: async (args: any) => {
      const wallet =
        this.userWallets.find((wallet) =>
          typeof args.where.id === "string"
            ? wallet.id === args.where.id
            : wallet.externalUserId === args.where.externalUserId,
        ) ?? null;
      return wallet ? { ...wallet } : null;
    },
    upsert: async (args: any) => {
      const existing = this.userWallets.find(
        (wallet) => wallet.externalUserId === args.where.externalUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const wallet: UserWalletRow = {
        id: args.create.id ?? `user_wallet_${this.userWallets.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        externalUserId: args.create.externalUserId,
        telegramUserId: args.create.telegramUserId ?? null,
        email: args.create.email ?? null,
        displayName: args.create.displayName ?? null,
        currency: args.create.currency ?? "CNY",
        cashBalanceCents: args.create.cashBalanceCents ?? 0,
      };
      this.userWallets.push(wallet);
      return wallet;
    },
    update: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("wallet not found");
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      if (args.data.audienceIdentityId !== undefined) {
        wallet.audienceIdentityId = args.data.audienceIdentityId;
      }
      if (args.data.telegramUserId !== undefined) {
        wallet.telegramUserId = args.data.telegramUserId;
      }
      if (args.data.displayName !== undefined) {
        wallet.displayName = args.data.displayName;
      }
      if (args.data.currency !== undefined) {
        wallet.currency = args.data.currency;
      }
      return wallet;
    },
    updateMany: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (
        !wallet ||
        (args.where.currency && wallet.currency !== args.where.currency) ||
        (typeof args.where.cashBalanceCents?.equals === "number" &&
          wallet.cashBalanceCents !== args.where.cashBalanceCents.equals) ||
        (typeof args.where.cashBalanceCents?.gte === "number" &&
          wallet.cashBalanceCents < args.where.cashBalanceCents.gte)
      ) {
        return { count: 0 };
      }
      if (typeof args.data.cashBalanceCents?.decrement === "number") {
        wallet.cashBalanceCents -= args.data.cashBalanceCents.decrement;
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      return { count: 1 };
    },
  };

  agentWallet = {
    findUnique: async (args: any) => {
      if (args.where.representativeId !== "rep_1") return null;
      return {
        id: "agent_wallet_1",
        representativeId: "rep_1",
        currency: "CNY",
        representative: { ownerId: "owner_1" },
      };
    },
  };

  creatorEarning = {
    findUnique: async (args: any) =>
      this.creatorEarnings.find((row) => row.id === args.where.id) ?? null,
    create: async (args: any) => {
      const row: TipCreatorEarningRow = {
        id: `tip_creator_earning_${this.creatorEarnings.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        status: args.data.status,
        pendingCents: args.data.pendingCents ?? 0,
        withdrawableCents: args.data.withdrawableCents ?? 0,
        frozenCents: args.data.frozenCents ?? 0,
        withdrawnCents: args.data.withdrawnCents ?? 0,
        currency: args.data.currency,
        revenueShareBps: args.data.revenueShareBps,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.creatorEarnings.push(row);
      return row;
    },
  };

  tipContribution = {
    findUnique: async (args: any) => {
      const row = this.tipContributions.find(
        (contribution) =>
          contribution.rechargeOrderId === args.where.rechargeOrderId,
      );
      if (!row) return null;
      const creatorEarning = this.creatorEarnings.find(
        (earning) => earning.id === row.creatorEarningId,
      );
      return creatorEarning ? { ...row, creatorEarning } : row;
    },
    create: async (args: any) => {
      const row: TipContributionRow = {
        id: `tip_contribution_${this.tipContributions.length + 1}`,
        rechargeOrderId: args.data.rechargeOrderId,
        audienceIdentityId: args.data.audienceIdentityId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        creatorEarningId: args.data.creatorEarningId,
        amountMinor: args.data.amountMinor,
        currency: args.data.currency,
        creatorRevenueShareBps: args.data.creatorRevenueShareBps,
        platformRevenueShareBps: args.data.platformRevenueShareBps,
        creatorAmountMinor: args.data.creatorAmountMinor,
        platformAmountMinor: args.data.platformAmountMinor,
        status: args.data.status,
        idempotencyKey: args.data.idempotencyKey,
        completedAt: args.data.completedAt,
      };
      this.tipContributions.push(row);
      return row;
    },
  };

  identityLink = {
    upsert: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) => link.provider === key.provider && link.providerSubject === key.providerSubject,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const link: IdentityLinkRow = {
        id: `identity_link_${this.identityLinks.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId,
        provider: args.create.provider,
        providerSubject: args.create.providerSubject,
      };
      this.identityLinks.push(link);
      return link;
    },
  };

  rechargeOrder = {
    findUnique: async (args: any) => {
      const order =
        typeof args.where.id === "string"
          ? this.rechargeOrders.find((row) => row.id === args.where.id)
          : this.rechargeOrders.find(
              (row) => row.idempotencyKey === args.where.idempotencyKey,
            );
      return order ? this.withUserWallet(order) : null;
    },
    create: async (args: any) => {
      const order: RechargeOrderRow = {
        id: args.data.id ?? `recharge_${this.rechargeOrders.length + 1}`,
        userWalletId: args.data.userWalletId,
        representativeId: args.data.representativeId ?? null,
        productCode: args.data.productCode ?? null,
        billingProductId: args.data.billingProductId ?? null,
        billingPriceVersionId:
          args.data.billingPriceVersionId ?? null,
        productNameSnapshot: args.data.productNameSnapshot ?? null,
        productKindSnapshot: args.data.productKindSnapshot ?? null,
        unitNameSnapshot: args.data.unitNameSnapshot ?? null,
        entitlementUnitsSnapshot:
          args.data.entitlementUnitsSnapshot ?? null,
        handoffAllowanceSnapshot:
          args.data.handoffAllowanceSnapshot ?? null,
        handoffUnitsSnapshot: args.data.handoffUnitsSnapshot ?? null,
        handoffServiceLevelSnapshot:
          args.data.handoffServiceLevelSnapshot ?? null,
        handoffValidityDaysSnapshot:
          args.data.handoffValidityDaysSnapshot ?? null,
        creatorRevenueShareBpsSnapshot:
          args.data.creatorRevenueShareBpsSnapshot ?? null,
        platformRevenueShareBpsSnapshot:
          args.data.platformRevenueShareBpsSnapshot ?? null,
        refundPolicySnapshot: args.data.refundPolicySnapshot ?? null,
        expiryPolicySnapshot: args.data.expiryPolicySnapshot ?? null,
        entitlementValidityDaysSnapshot:
          args.data.entitlementValidityDaysSnapshot ?? null,
        provider: args.data.provider,
        providerOrderId: args.data.providerOrderId ?? null,
        providerTransactionId:
          args.data.providerTransactionId ?? null,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        status: args.data.status,
        idempotencyKey: args.data.idempotencyKey,
        checkoutUrl: args.data.checkoutUrl ?? null,
        providerPayload: args.data.providerPayload ?? null,
        paidAt: null,
        refundedAt: null,
      };
      this.rechargeOrders.push(order);
      return order;
    },
    update: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      if (!order) {
        throw new Error("order not found");
      }
      Object.assign(order, args.data);
      return order;
    },
    updateMany: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      if (
        !order ||
        (args.where.provider && order.provider !== args.where.provider) ||
        (typeof args.where.amountCents === "number" &&
          order.amountCents !== args.where.amountCents) ||
        (args.where.currency && order.currency !== args.where.currency) ||
        (args.where.status && order.status !== args.where.status)
      ) {
        return { count: 0 };
      }
      Object.assign(order, args.data);
      return { count: 1 };
    },
  };

  paymentProviderEvent = {
    findUnique: async (args: any) => {
      const eventKey = args.where.provider_providerEventId;
      const transactionKey =
        args.where.provider_providerTransactionId;
      return (
        this.providerEvents.find(
          (event) =>
            eventKey
              ? event.provider === eventKey.provider
                && event.providerEventId === eventKey.providerEventId
              : event.provider === transactionKey.provider
                && event.providerTransactionId
                  === transactionKey.providerTransactionId,
        ) ?? null
      );
    },
    upsert: async (args: any) => {
      const key = args.where.provider_providerEventId;
      const existing = this.providerEvents.find(
        (event) =>
          event.provider === key.provider && event.providerEventId === key.providerEventId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const event: ProviderEventRow = {
        id: `provider_event_${this.providerEvents.length + 1}`,
        provider: args.create.provider,
        providerEventId: args.create.providerEventId,
        providerTransactionId:
          args.create.providerTransactionId ?? null,
        eventType: args.create.eventType,
        rechargeOrderId: args.create.rechargeOrderId ?? null,
        processedAt: args.create.processedAt ?? null,
      };
      this.providerEvents.push(event);
      return event;
    },
  };

  rechargeRefund = {
    findFirst: async (args: any) => {
      return (
        this.rechargeRefunds.find(
          (refund) =>
            refund.rechargeOrderId === args.where.rechargeOrderId
            && refund.provider === args.where.provider
            && refund.providerStatus === args.where.providerStatus,
        ) ?? null
      );
    },
  };

  walletTransaction = {
    findUnique: async (args: any) =>
      this.walletTransactions.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    create: async (args: any) => {
      const row = {
        id: `wallet_transaction_${this.walletTransactions.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        sourceType: args.data.sourceType,
        sourceId: args.data.sourceId ?? null,
        eventType: args.data.eventType,
        status: args.data.status,
        currency: args.data.currency,
        ownerId: args.data.ownerId ?? null,
        representativeId: args.data.representativeId ?? null,
        userWalletId: args.data.userWalletId ?? null,
        metadata: args.data.metadata ?? null,
      };
      this.walletTransactions.push(row);
      return row;
    },
    updateMany: async (args: any) => {
      const rows = this.walletTransactions.filter(
        (row) => row.eventGroupId === args.where.eventGroupId,
      );
      for (const row of rows) Object.assign(row, args.data);
      return { count: rows.length };
    },
  };

  walletLedgerEntry = {
    findFirst: async (args: any) => {
      return (
        this.ledgerEntries.find(
          (entry) =>
            entry.eventGroupId === args.where.eventGroupId &&
            entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith),
        ) ?? null
      );
    },
    findMany: async (args: any) => {
      return this.ledgerEntries.filter((entry) => entry.eventGroupId === args.where.eventGroupId);
    },
    create: async (args: { data: Prisma.WalletLedgerEntryUncheckedCreateInput }) => {
      const entry: LedgerRow = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        accountType: args.data.accountType,
        entryKind: args.data.entryKind,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeRechargeClient) => Promise<T>): Promise<T> {
    const userWallets = this.userWallets.map((row) => ({ ...row }));
    const rechargeOrders = this.rechargeOrders.map((row) => ({ ...row }));
    const rechargeRefunds = this.rechargeRefunds.map((row) => ({ ...row }));
    const providerEvents = this.providerEvents.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    const identityLinks = this.identityLinks.map((row) => ({ ...row }));
    const walletTransactions = this.walletTransactions.map((row) => ({ ...row }));
    const outboxEvents = this.outboxEvents.map((row) => ({ ...row }));
    const creatorEarnings = this.creatorEarnings.map((row) => ({ ...row }));
    const tipContributions = this.tipContributions.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.userWallets = userWallets;
      this.rechargeOrders = rechargeOrders;
      this.rechargeRefunds = rechargeRefunds;
      this.providerEvents = providerEvents;
      this.ledgerEntries = ledgerEntries;
      this.identityLinks = identityLinks;
      this.walletTransactions = walletTransactions;
      this.outboxEvents = outboxEvents;
      this.creatorEarnings = creatorEarnings;
      this.tipContributions = tipContributions;
      throw error;
    }
  }

  private withUserWallet(order: RechargeOrderRow): RechargeOrderRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === order.userWalletId);
    if (!userWallet) {
      return order;
    }
    return { ...order, userWallet };
  }
}

function sumLedgerAmount(entries: LedgerRow[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
