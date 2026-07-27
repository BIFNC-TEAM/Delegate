export const PUBLIC_WALLET_UPDATED_EVENT = "delegate:public-wallet-updated";

export type PublicWalletUpdatedDetail = {
  representativeSlug: string;
  serviceCreditsAvailable: number;
  serviceCreditsReserved: number;
};

export type PublicWalletStateSnapshot = {
  summary: {
    currency: string;
    cashBalanceCents: number;
    serviceCreditsAvailable: number;
    serviceCreditsReserved: number;
    serviceCreditsPurchased: number;
    serviceCreditsConsumed: number;
  };
  orders: Array<{
    id: string;
    amountCents: number;
    currency: string;
    provider: string;
    status: string;
    checkoutUrl: string | null;
    paidAt: string | null;
    refundedAt: string | null;
    createdAt: string;
  }>;
  purchases: Array<{
    id: string;
    rechargeOrderId: string | null;
    amountCents: number;
    currency: string;
    tokenAmount: number;
    remainingTokenAmount: number;
    status: string;
    refundedAt: string | null;
    createdAt: string;
  }>;
  refunds: Array<{
    id: string;
    purchaseId: string;
    currency: string;
    tokenAmount: number;
    amountCents: number;
    status: "succeeded";
    completedAt: string;
  }>;
};

export type CurrentPublicWalletActivity = {
  order: PublicWalletStateSnapshot["orders"][number] | null;
  purchase: PublicWalletStateSnapshot["purchases"][number] | null;
  refund: PublicWalletStateSnapshot["refunds"][number] | null;
};

export function publishPublicWalletUpdate(
  detail: PublicWalletUpdatedDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<PublicWalletUpdatedDetail>(
      PUBLIC_WALLET_UPDATED_EVENT,
      { detail },
    ),
  );
}

/**
 * Restores one coherent checkout chain. A newer unpaid order must not be shown
 * with an older purchase or refund merely because those are the latest records
 * of their own kinds.
 */
export function selectCurrentPublicWalletActivity(
  snapshot: PublicWalletStateSnapshot,
): CurrentPublicWalletActivity {
  const order = snapshot.orders[0] ?? null;
  if (!order) {
    return { order: null, purchase: null, refund: null };
  }
  const purchase =
    snapshot.purchases.find(
      (candidate) => candidate.rechargeOrderId === order.id,
    ) ?? null;
  const refund = purchase
    ? snapshot.refunds.find(
        (candidate) => candidate.purchaseId === purchase.id,
      ) ?? null
    : null;
  return { order, purchase, refund };
}
