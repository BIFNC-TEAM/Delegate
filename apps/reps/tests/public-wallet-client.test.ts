import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_WALLET_UPDATED_EVENT,
  getCheckoutSecondsRemaining,
  getPublicRechargeStatusPresentation,
  getWeChatPaymentPollDelayMs,
  publishPublicWalletUpdate,
  selectCurrentPublicWalletActivity,
  type PublicWalletStateSnapshot,
  type PublicWalletUpdatedDetail,
} from "../app/reps/[slug]/public-wallet-client";

describe("public wallet client updates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes the representative-scoped authoritative credit balance", () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal("window", eventTarget);
    let received: PublicWalletUpdatedDetail | null = null;
    eventTarget.addEventListener(PUBLIC_WALLET_UPDATED_EVENT, (event) => {
      received = (event as CustomEvent<PublicWalletUpdatedDetail>).detail;
    });

    publishPublicWalletUpdate({
      representativeSlug: "delegate",
      serviceCreditsAvailable: 18,
      serviceCreditsReserved: 2,
    });

    expect(received).toEqual({
      representativeSlug: "delegate",
      serviceCreditsAvailable: 18,
      serviceCreditsReserved: 2,
    });
  });

  it("restores the purchase and refund belonging to the latest order", () => {
    const snapshot = walletStateFixture();

    expect(selectCurrentPublicWalletActivity(snapshot)).toEqual({
      order: expect.objectContaining({ id: "order-latest" }),
      purchase: expect.objectContaining({ id: "purchase-latest" }),
      refund: expect.objectContaining({ id: "refund-latest" }),
    });
  });

  it("does not combine a newer unpaid order with an older purchase chain", () => {
    const snapshot = walletStateFixture();
    snapshot.orders.unshift({
      id: "order-new-unpaid",
      amountCents: 500,
      currency: "CNY",
      provider: "mock",
      status: "requires_payment",
      checkoutUrl: "/mock/checkout",
      checkoutExpiresAt: null,
      paidAt: null,
      refundedAt: null,
      createdAt: "2026-07-27T05:00:00.000Z",
    });

    expect(selectCurrentPublicWalletActivity(snapshot)).toEqual({
      order: expect.objectContaining({ id: "order-new-unpaid" }),
      purchase: null,
      refund: null,
    });
  });

  it("maps every recharge state to localized text and a semantic tone", () => {
    expect(
      getPublicRechargeStatusPresentation("requires_payment", "zh"),
    ).toEqual({ label: "待支付", tone: "warning" });
    expect(
      getPublicRechargeStatusPresentation("paid", "en"),
    ).toEqual({ label: "Payment confirmed", tone: "success" });
    expect(
      getPublicRechargeStatusPresentation("failed", "zh"),
    ).toEqual({ label: "支付失败", tone: "error" });
    expect(
      getPublicRechargeStatusPresentation("refunded", "en"),
    ).toEqual({ label: "Refunded", tone: "neutral" });
    expect(
      getPublicRechargeStatusPresentation(
        "requires_payment",
        "zh",
        { checkoutExpired: true },
      ),
    ).toEqual({ label: "二维码已过期", tone: "warning" });
  });

  it("derives a canonical checkout countdown without accepting malformed dates", () => {
    expect(
      getCheckoutSecondsRemaining(
        "2026-07-27T10:00:10.000Z",
        Date.parse("2026-07-27T10:00:00.250Z"),
      ),
    ).toBe(10);
    expect(
      getCheckoutSecondsRemaining(
        "2026-07-27T10:00:00.000Z",
        Date.parse("2026-07-27T10:00:01.000Z"),
      ),
    ).toBe(0);
    expect(getCheckoutSecondsRemaining("2026-07-27", 0)).toBeNull();
  });

  it("uses bounded exponential delays for serialized payment polling", () => {
    expect([
      getWeChatPaymentPollDelayMs(0),
      getWeChatPaymentPollDelayMs(1),
      getWeChatPaymentPollDelayMs(2),
      getWeChatPaymentPollDelayMs(3),
      getWeChatPaymentPollDelayMs(20),
    ]).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
  });
});

function walletStateFixture(): PublicWalletStateSnapshot {
  return {
    summary: {
      currency: "CNY",
      cashBalanceCents: 300,
      serviceCreditsAvailable: 7,
      serviceCreditsReserved: 1,
      serviceCreditsPurchased: 12,
      serviceCreditsConsumed: 4,
    },
    orders: [{
      id: "order-latest",
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
    purchases: [
      {
        id: "purchase-latest",
        rechargeOrderId: "order-latest",
        amountCents: 2000,
        currency: "CNY",
        tokenAmount: 20,
        remainingTokenAmount: 8,
        status: "completed",
        refundedAt: "2026-07-27T03:00:00.000Z",
        createdAt: "2026-07-27T02:00:00.000Z",
      },
      {
        id: "purchase-old",
        rechargeOrderId: "order-old",
        amountCents: 500,
        currency: "CNY",
        tokenAmount: 5,
        remainingTokenAmount: 0,
        status: "reversed",
        refundedAt: "2026-07-26T03:00:00.000Z",
        createdAt: "2026-07-26T02:00:00.000Z",
      },
    ],
    refunds: [
      {
        id: "refund-latest",
        purchaseId: "purchase-latest",
        currency: "CNY",
        tokenAmount: 3,
        amountCents: 300,
        status: "succeeded",
        completedAt: "2026-07-27T03:00:00.000Z",
      },
      {
        id: "refund-old",
        purchaseId: "purchase-old",
        currency: "CNY",
        tokenAmount: 5,
        amountCents: 500,
        status: "succeeded",
        completedAt: "2026-07-26T03:00:00.000Z",
      },
    ],
  };
}
