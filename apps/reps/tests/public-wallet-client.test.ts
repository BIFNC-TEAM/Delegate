import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_WALLET_UPDATED_EVENT,
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
