import {
  PaymentProvider,
  PaymentProviderEventType,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  createAlipayPaymentProviderAdapter,
  createStripePaymentProviderAdapter,
  createWeChatPayPaymentProviderAdapter,
  getPaymentProviderAdapter,
  mockPaymentProviderAdapter,
  type StripeCheckoutSessionCreateOptions,
  type StripeCheckoutSessionCreateParams,
} from "../src/agent-wallet-payment-providers";

describe("agent wallet payment provider adapters", () => {
  it("creates a mock recharge checkout without mutating wallet state", async () => {
    const wallet = { cashBalanceCents: 0 };
    const checkout = await mockPaymentProviderAdapter.createRechargeCheckout({
      externalUserId: "user_1",
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: "mock_order_1",
    });

    expect(checkout).toMatchObject({
      provider: PaymentProvider.MOCK,
      providerOrderId: "mock_mock_order_1",
      checkoutUrl: "/api/amn/recharges/mock/mock_order_1",
    });
    expect(wallet.cashBalanceCents).toBe(0);
  });

  it("normalizes a mock recharge paid webhook event", async () => {
    const event = await mockPaymentProviderAdapter.normalizeWebhookEvent({
      payload: {
        providerEventId: "evt_mock_paid_1",
        rechargeOrderId: "recharge_1",
        amountCents: 1200,
        currency: "CNY",
        status: "paid",
      },
    });

    expect(event).toMatchObject({
      provider: PaymentProvider.MOCK,
      providerEventId: "evt_mock_paid_1",
      eventType: PaymentProviderEventType.RECHARGE_PAID,
      rechargeOrderId: "recharge_1",
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: "mock:evt_mock_paid_1",
    });
    expect(event.normalizedPayload).toMatchObject({
      type: "RechargePaid",
      provider: "mock",
    });
  });

  it("normalizes mock failed events from raw JSON", async () => {
    const event = await mockPaymentProviderAdapter.normalizeWebhookEvent({
      rawBody: JSON.stringify({
        rechargeOrderId: "recharge_1",
        amountCents: 1200,
        currency: "CNY",
        status: "failed",
      }),
    });

    expect(event.eventType).toBe(PaymentProviderEventType.RECHARGE_FAILED);
    expect(event.providerEventId).toBe("mock_recharge_failed_recharge_1");
  });

  it("reserves Stripe, WeChat Pay, and Alipay adapters behind the same interface", async () => {
    for (const provider of [
      PaymentProvider.STRIPE,
      PaymentProvider.WECHAT_PAY,
      PaymentProvider.ALIPAY,
    ]) {
      const adapter = getPaymentProviderAdapter(provider);
      expect(adapter.provider).toBe(provider);
      await expect(
        adapter.createRechargeCheckout({
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "CNY",
          idempotencyKey: "provider_reserved_1",
        }),
      ).rejects.toThrow("reserved but not configured");
    }
  });

  it("creates a Stripe Checkout Session through the injected client", async () => {
    const calls: Array<{
      params: StripeCheckoutSessionCreateParams;
      options?: StripeCheckoutSessionCreateOptions;
    }> = [];
    const adapter = createStripePaymentProviderAdapter({
      successUrl: "https://delegate.example/success",
      cancelUrl: "https://delegate.example/cancel",
      checkoutSessions: {
        create: async (params, options) => {
          calls.push({ params, ...(options ? { options } : {}) });
          return {
            id: "cs_test_123",
            url: "https://checkout.stripe.com/c/pay/cs_test_123",
          };
        },
      },
    });

    const checkout = await adapter.createRechargeCheckout({
      rechargeOrderId: "recharge_1",
      externalUserId: "web:user_1",
      amountCents: 2500,
      currency: "CNY",
      idempotencyKey: "stripe_recharge_1",
    });

    expect(checkout).toMatchObject({
      provider: PaymentProvider.STRIPE,
      providerOrderId: "cs_test_123",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      mode: "payment",
      client_reference_id: "stripe_recharge_1",
      success_url: "https://delegate.example/success",
      cancel_url: "https://delegate.example/cancel",
      metadata: {
        rechargeOrderId: "recharge_1",
        externalUserId: "web:user_1",
        amountCents: "2500",
        currency: "CNY",
        idempotencyKey: "stripe_recharge_1",
      },
    });
    expect(calls[0]?.params.line_items[0]?.price_data).toMatchObject({
      currency: "cny",
      unit_amount: 2500,
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: "stripe_recharge_1" });
  });

  it("normalizes Stripe Checkout paid and failed webhook events", async () => {
    const adapter = createStripePaymentProviderAdapter({
      successUrl: "https://delegate.example/success",
      checkoutSessions: {
        create: async () => ({ id: "cs_unused" }),
      },
    });

    const paid = await adapter.normalizeWebhookEvent({
      payload: {
        id: "evt_paid_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            amount_total: 2500,
            currency: "cny",
            metadata: {
              rechargeOrderId: "recharge_1",
            },
          },
        },
      },
    });
    const failed = await adapter.normalizeWebhookEvent({
      payload: {
        id: "evt_failed_1",
        type: "checkout.session.async_payment_failed",
        data: {
          object: {
            id: "cs_test_124",
            amount_total: 2500,
            currency: "cny",
            metadata: {
              rechargeOrderId: "recharge_1",
            },
          },
        },
      },
    });

    expect(paid).toMatchObject({
      provider: PaymentProvider.STRIPE,
      providerEventId: "evt_paid_1",
      eventType: PaymentProviderEventType.RECHARGE_PAID,
      rechargeOrderId: "recharge_1",
      amountCents: 2500,
      currency: "CNY",
      idempotencyKey: "stripe:evt_paid_1",
    });
    expect(failed.eventType).toBe(PaymentProviderEventType.RECHARGE_FAILED);
  });

  it("returns a configured Stripe adapter from the provider registry", async () => {
    const adapter = getPaymentProviderAdapter(PaymentProvider.STRIPE, {
      stripe: {
        successUrl: "https://delegate.example/success",
        checkoutSessions: {
          create: async () => ({ id: "cs_test_registry" }),
        },
      },
    });

    const checkout = await adapter.createRechargeCheckout({
      externalUserId: "user_1",
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: "registry_key",
    });
    expect(checkout.providerOrderId).toBe("cs_test_registry");
  });

  it("keeps WeChat Pay and Alipay skeletons fail-closed without injected provider callbacks", async () => {
    for (const adapter of [
      createWeChatPayPaymentProviderAdapter({
        appId: "wx_app",
        merchantId: "merchant_1",
      }),
      createAlipayPaymentProviderAdapter({
        appId: "alipay_app",
        merchantId: "merchant_1",
      }),
    ]) {
      await expect(
        adapter.createRechargeCheckout({
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "CNY",
          idempotencyKey: "signed_wallet_1",
        }),
      ).rejects.toThrow("official provider SDK");
      await expect(
        adapter.normalizeWebhookEvent({
          payload: {
            providerEventId: "evt_1",
          },
        }),
      ).rejects.toThrow("signature verification");
    }
  });

  it("normalizes injected WeChat Pay signed webhook payloads", async () => {
    const adapter = createWeChatPayPaymentProviderAdapter({
      appId: "wx_app",
      merchantId: "merchant_1",
      createRechargeCheckout: async () => ({
        providerOrderId: "wx_order_1",
        checkoutUrl: "weixin://wxpay/bizpayurl?pr=demo",
      }),
      verifyAndParseWebhook: async () => ({
        providerEventId: "wx_txn_1",
        rechargeOrderId: "recharge_1",
        amountCents: 1200,
        currency: "CNY",
        status: "transaction_success",
      }),
    });

    const checkout = await adapter.createRechargeCheckout({
      externalUserId: "user_1",
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: "wechat_1",
    });
    const event = await adapter.normalizeWebhookEvent({ rawBody: "{}" });

    expect(checkout).toMatchObject({
      provider: PaymentProvider.WECHAT_PAY,
      providerOrderId: "wx_order_1",
    });
    expect(event).toMatchObject({
      provider: PaymentProvider.WECHAT_PAY,
      providerEventId: "wx_txn_1",
      eventType: PaymentProviderEventType.RECHARGE_PAID,
      rechargeOrderId: "recharge_1",
      idempotencyKey: "wechat_pay:wx_txn_1",
    });
  });

  it("normalizes injected Alipay signed webhook payloads", async () => {
    const adapter = getPaymentProviderAdapter(PaymentProvider.ALIPAY, {
      alipay: {
        appId: "alipay_app",
        merchantId: "merchant_1",
        createRechargeCheckout: async () => ({
          providerOrderId: "alipay_trade_1",
          checkoutUrl: "https://openapi.alipay.com/gateway.do?demo=1",
        }),
        verifyAndParseWebhook: async () => ({
          tradeNo: "alipay_trade_1",
          rechargeOrderId: "recharge_1",
          totalAmountCents: 1200,
          currency: "CNY",
          tradeStatus: "TRADE_SUCCESS",
        }),
      },
    });

    const event = await adapter.normalizeWebhookEvent({ rawBody: "signed=true" });

    expect(event).toMatchObject({
      provider: PaymentProvider.ALIPAY,
      providerEventId: "alipay_trade_1",
      eventType: PaymentProviderEventType.RECHARGE_PAID,
      rechargeOrderId: "recharge_1",
      amountCents: 1200,
      idempotencyKey: "alipay:alipay_trade_1",
    });
  });
});
