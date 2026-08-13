export const PUBLIC_WALLET_UPDATED_EVENT = "delegate:public-wallet-updated";

export type PublicWalletUpdatedDetail = {
  representativeSlug: string;
  serviceCreditsAvailable: number;
  serviceCreditsReserved: number;
  serviceCreditsPurchased: number;
  /** Present only when the balance came from a fresh authoritative read. */
  handoffEntitlement?: PublicHandoffEntitlementSummary;
};

export type PublicHandoffEntitlementSummary = {
  hasUnlimited: boolean;
  limitedRemainingUses: number;
  highestServiceLevel: "STANDARD" | "PRIORITY" | null;
  nextExpiryAt: string | null;
};

type PublicCommerceProductBase = {
  productId: string;
  priceVersionId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isRecommended: boolean;
  amountCents: number;
  currency: "CNY";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
};

export type PublicServiceCommerceProduct = PublicCommerceProductBase & {
  kind: "SERVICE_PACKAGE";
  entitlementUnits: number;
  unitName: "credit";
  refundPolicy: "FULL_WHEN_UNUSED";
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED";
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
};

export type PublicTipCommerceProduct = PublicCommerceProductBase & {
  kind: "TIP";
  entitlementUnits: 0;
  unitName: "tip";
  refundPolicy: "NON_REFUNDABLE";
  handoffAllowance: "NONE";
  handoffUnits: null;
  handoffServiceLevel: null;
  handoffValidityDays: null;
};

export type PublicCommerceProduct =
  | PublicServiceCommerceProduct
  | PublicTipCommerceProduct;

export type PublicRechargeOrderStatus =
  | "created"
  | "requires_payment"
  | "paid"
  | "failed"
  | "canceled"
  | "refunded";

export type PublicRechargeStatusTone =
  | "success"
  | "warning"
  | "error"
  | "neutral";

export type PublicRechargeStatusPresentation = {
  label: string;
  tone: PublicRechargeStatusTone;
};

export type PublicWalletOrder = {
  id: string;
  billingProductId: string | null;
  billingPriceVersionId: string | null;
  productName: string | null;
  productKind: "SERVICE_PACKAGE" | "TIP" | null;
  entitlementUnits: number | null;
  unitName: string | null;
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED" | null;
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
  amountCents: number;
  currency: string;
  provider: string;
  status: PublicRechargeOrderStatus;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  createdAt: string;
};

export type PublicWalletStateSnapshot = {
  summary: {
    currency: string;
    serviceCreditsAvailable: number;
    serviceCreditsReserved: number;
    serviceCreditsPurchased: number;
    serviceCreditsConsumed: number;
  };
  commerceSettings: {
    accessMode: "FREE" | "TRIAL_THEN_CREDITS" | "CREDITS_ONLY";
    humanInLoop: boolean;
    handoffAccessMode: "FREE" | "PACKAGE_REQUIRED";
    tipsEnabled: boolean;
  };
  handoffEntitlement: PublicHandoffEntitlementSummary;
  commerceProducts: PublicCommerceProduct[];
  orders: PublicWalletOrder[];
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

const rechargeStatusCopy = {
  zh: {
    created: "正在创建",
    requires_payment: "待支付",
    paid: "支付已确认",
    failed: "支付失败",
    canceled: "已关闭",
    refunded: "已退款",
    expired: "二维码已过期",
  },
  en: {
    created: "Creating",
    requires_payment: "Awaiting payment",
    paid: "Payment confirmed",
    failed: "Payment failed",
    canceled: "Closed",
    refunded: "Refunded",
    expired: "QR code expired",
  },
} as const;

export function getPublicRechargeStatusPresentation(
  status: PublicRechargeOrderStatus,
  locale: "zh" | "en",
  options: { checkoutExpired?: boolean } = {},
): PublicRechargeStatusPresentation {
  if (status === "requires_payment" && options.checkoutExpired) {
    return {
      label: rechargeStatusCopy[locale].expired,
      tone: "warning",
    };
  }
  switch (status) {
    case "paid":
      return {
        label: rechargeStatusCopy[locale].paid,
        tone: "success",
      };
    case "created":
    case "requires_payment":
      return {
        label: rechargeStatusCopy[locale][status],
        tone: "warning",
      };
    case "failed":
      return {
        label: rechargeStatusCopy[locale].failed,
        tone: "error",
      };
    case "canceled":
    case "refunded":
      return {
        label: rechargeStatusCopy[locale][status],
        tone: "neutral",
      };
  }
}

export function getCheckoutSecondsRemaining(
  checkoutExpiresAt: string | null,
  nowMs = Date.now(),
): number | null {
  if (!checkoutExpiresAt) {
    return null;
  }
  const parsed = new Date(checkoutExpiresAt);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== checkoutExpiresAt
  ) {
    return null;
  }
  return Math.max(0, Math.ceil((parsed.getTime() - nowMs) / 1_000));
}

export function getWeChatPaymentPollDelayMs(attempt: number): number {
  const normalizedAttempt =
    Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.min(15_000, 2_000 * (2 ** normalizedAttempt));
}

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

export function buildPublicCommerceCompletionWalletUpdate(input: {
  representativeSlug: string;
  tokenPurchase: {
    availableTokenAmount: number;
    reservedTokenAmount: number;
    totalPurchasedTokenAmount: number;
  } | null;
}): PublicWalletUpdatedDetail | null {
  if (!input.tokenPurchase) return null;
  return {
    representativeSlug: input.representativeSlug,
    serviceCreditsAvailable: input.tokenPurchase.availableTokenAmount,
    serviceCreditsReserved: input.tokenPurchase.reservedTokenAmount,
    serviceCreditsPurchased: input.tokenPurchase.totalPurchasedTokenAmount,
  };
}

/**
 * Restores one coherent checkout chain. A newer unpaid order must not be shown
 * with an older purchase or refund merely because those are the latest records
 * of their own kinds.
 */
export function selectCurrentPublicWalletActivity(
  snapshot: PublicWalletStateSnapshot,
): CurrentPublicWalletActivity {
  // Public commerce no longer exposes simulated checkout. Keep this client
  // boundary defensive so a stale response containing a historical MOCK row
  // cannot be mistaken for an active WeChat Pay order.
  const order = snapshot.orders.find(
    (candidate) => candidate.provider.toLowerCase() === "wechat_pay",
  ) ?? null;
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
