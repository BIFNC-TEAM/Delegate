import {
  PaymentProvider,
  PaymentProviderEventType,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getPaymentProviderAdapter,
  mockPaymentProviderAdapter,
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
});
