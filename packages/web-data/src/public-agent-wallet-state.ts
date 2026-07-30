import {
  AgentTokenPurchaseStatus,
  PaymentProvider,
  RechargeOrderStatus,
  WalletTransactionEventType,
  WalletTransactionStatus,
  type Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { PublicAudiencePrincipalError } from "./public-audience-principal";
import { readWeChatPayCheckoutExpiresAt } from "./agent-wallet-recharge";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "./service-entitlements";

const PUBLIC_WALLET_RECORD_LIMIT = 20;
const SUPPORTED_PUBLIC_WALLET_CURRENCIES = new Set(["CNY", "USD"]);

type PublicUserWalletRecord = {
  id: string;
};

type PublicUserAgentWalletRecord = {
  availableTokenAmount: number;
  reservedTokenAmount: number;
  totalPurchasedTokenAmount: number;
  totalConsumedTokenAmount: number;
};

type PublicRechargeOrderRecord = {
  id: string;
  billingProductId: string | null;
  billingPriceVersionId: string | null;
  productNameSnapshot: string | null;
  entitlementUnitsSnapshot: number | null;
  unitNameSnapshot: string | null;
  amountCents: number;
  currency: string;
  provider: PaymentProvider;
  status: RechargeOrderStatus;
  checkoutUrl: string | null;
  providerPayload: unknown;
  paidAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
};

type PublicAgentTokenPurchaseRecord = {
  id: string;
  rechargeOrderId: string | null;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number | null;
  status: AgentTokenPurchaseStatus;
  refundedAt: Date | null;
  createdAt: Date;
};

type PublicWalletRefundRecord = {
  id: string;
  sourceId: string | null;
  currency: string;
  status: WalletTransactionStatus;
  occurredAt: Date;
  completedAt: Date | null;
  metadata: unknown;
};

export type PublicAgentWalletStateClient = {
  userWallet: {
    findMany(args: unknown): Promise<PublicUserWalletRecord[]>;
  };
  userAgentWallet: {
    findFirst(args: unknown): Promise<PublicUserAgentWalletRecord | null>;
  };
  rechargeOrder: {
    findMany(args: unknown): Promise<PublicRechargeOrderRecord[]>;
  };
  agentTokenPurchase: {
    findMany(args: unknown): Promise<PublicAgentTokenPurchaseRecord[]>;
  };
  walletTransaction: {
    findMany(args: unknown): Promise<PublicWalletRefundRecord[]>;
  };
  $transaction?<T>(
    fn: (tx: PublicAgentWalletStateClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export type PublicAgentWalletSummary = {
  currency: string;
  serviceCreditsAvailable: number;
  serviceCreditsReserved: number;
  serviceCreditsPurchased: number;
  serviceCreditsConsumed: number;
};

export type PublicAgentWalletOrder = {
  id: string;
  billingProductId: string | null;
  billingPriceVersionId: string | null;
  productName: string | null;
  entitlementUnits: number | null;
  unitName: string | null;
  amountCents: number;
  currency: string;
  provider:
    | "mock"
    | "stripe"
    | "wechat_pay"
    | "alipay"
    | "telegram_stars";
  status:
    | "created"
    | "requires_payment"
    | "paid"
    | "failed"
    | "canceled"
    | "refunded";
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  createdAt: string;
};

export type PublicAgentWalletPurchase = {
  id: string;
  rechargeOrderId: string | null;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  status: "pending" | "completed" | "failed" | "refunded" | "reversed";
  refundedAt: string | null;
  createdAt: string;
};

export type PublicAgentWalletRefund = {
  id: string;
  purchaseId: string;
  currency: string;
  tokenAmount: number;
  amountCents: number;
  status: "succeeded";
  completedAt: string;
};

export type PublicAgentWalletState = {
  summary: PublicAgentWalletSummary;
  orders: PublicAgentWalletOrder[];
  purchases: PublicAgentWalletPurchase[];
  refunds: PublicAgentWalletRefund[];
};

export type GetPublicAgentWalletStateInput = {
  audienceIdentityId: string;
  representativeId: string;
  currency?: string;
};

/**
 * Returns a browser-safe view of the current visitor's wallet activity for one
 * representative and one currency. The canonical audience identity is supplied
 * by the server-side principal resolver; browser-provided wallet identifiers
 * are deliberately not accepted.
 */
export async function getPublicAgentWalletState(
  input: GetPublicAgentWalletStateInput,
  client: PublicAgentWalletStateClient =
    prisma as unknown as PublicAgentWalletStateClient,
): Promise<PublicAgentWalletState> {
  const audienceIdentityId = requirePublicWalletValue(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const representativeId = requirePublicWalletValue(
    input.representativeId,
    "representativeId",
  );
  const currency = (input.currency?.trim().toUpperCase() || "CNY");
  if (!SUPPORTED_PUBLIC_WALLET_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported public wallet currency: ${currency}`);
  }

  const read = (tx: PublicAgentWalletStateClient) =>
    readPublicAgentWalletState(
      { audienceIdentityId, representativeId, currency },
      tx,
    );
  return client.$transaction
    ? client.$transaction(read, { isolationLevel: "RepeatableRead" })
    : read(client);
}

async function readPublicAgentWalletState(
  input: {
    audienceIdentityId: string;
    representativeId: string;
    currency: string;
  },
  client: PublicAgentWalletStateClient,
): Promise<PublicAgentWalletState> {
  const { audienceIdentityId, representativeId, currency } = input;
  const userWallets = await client.userWallet.findMany({
    where: {
      audienceIdentityId,
      currency,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: {
      id: true,
    },
  } satisfies Prisma.UserWalletFindManyArgs);
  if (userWallets.length > 1) {
    throw new PublicAudiencePrincipalError(
      "WALLET_IDENTITY_CONFLICT",
      "Multiple wallets exist for this audience identity and currency.",
    );
  }

  const userWallet = userWallets[0];
  if (!userWallet) {
    return emptyPublicAgentWalletState(currency);
  }

  const [
    scopedWallet,
    rechargeOrders,
    tokenPurchases,
    refundTransactions,
  ] = await Promise.all([
    client.userAgentWallet.findFirst({
      where: {
        userWalletId: userWallet.id,
        currency,
        agentWallet: {
          representativeId,
          currency,
        },
      },
      select: {
        availableTokenAmount: true,
        reservedTokenAmount: true,
        totalPurchasedTokenAmount: true,
        totalConsumedTokenAmount: true,
      },
    } satisfies Prisma.UserAgentWalletFindFirstArgs),
    client.rechargeOrder.findMany({
      where: {
        userWalletId: userWallet.id,
        representativeId,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        currency,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PUBLIC_WALLET_RECORD_LIMIT,
      select: {
        id: true,
        billingProductId: true,
        billingPriceVersionId: true,
        productNameSnapshot: true,
        entitlementUnitsSnapshot: true,
        unitNameSnapshot: true,
        amountCents: true,
        currency: true,
        provider: true,
        status: true,
        checkoutUrl: true,
        providerPayload: true,
        paidAt: true,
        refundedAt: true,
        createdAt: true,
      },
    } satisfies Prisma.RechargeOrderFindManyArgs),
    client.agentTokenPurchase.findMany({
      where: {
        userWalletId: userWallet.id,
        audienceIdentityId,
        representativeId,
        currency,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PUBLIC_WALLET_RECORD_LIMIT,
      select: {
        id: true,
        rechargeOrderId: true,
        amountCents: true,
        currency: true,
        tokenAmount: true,
        remainingTokenAmount: true,
        status: true,
        refundedAt: true,
        createdAt: true,
      },
    } satisfies Prisma.AgentTokenPurchaseFindManyArgs),
    client.walletTransaction.findMany({
      where: {
        userWalletId: userWallet.id,
        representativeId,
        currency,
        sourceType: "AgentTokenPurchase",
        eventType: WalletTransactionEventType.REVERSAL,
        status: WalletTransactionStatus.SUCCEEDED,
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PUBLIC_WALLET_RECORD_LIMIT,
      select: {
        id: true,
        sourceId: true,
        currency: true,
        status: true,
        occurredAt: true,
        completedAt: true,
        metadata: true,
      },
    } satisfies Prisma.WalletTransactionFindManyArgs),
  ]);

  return {
    summary: {
      currency,
      serviceCreditsAvailable: scopedWallet?.availableTokenAmount ?? 0,
      serviceCreditsReserved: scopedWallet?.reservedTokenAmount ?? 0,
      serviceCreditsPurchased:
        scopedWallet?.totalPurchasedTokenAmount ?? 0,
      serviceCreditsConsumed: scopedWallet?.totalConsumedTokenAmount ?? 0,
    },
    orders: rechargeOrders.map(serializePublicRechargeOrder),
    purchases: tokenPurchases.map(serializePublicTokenPurchase),
    refunds: refundTransactions.flatMap(serializePublicWalletRefund),
  };
}

function emptyPublicAgentWalletState(
  currency: string,
): PublicAgentWalletState {
  return {
    summary: {
      currency,
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
      serviceCreditsPurchased: 0,
      serviceCreditsConsumed: 0,
    },
    orders: [],
    purchases: [],
    refunds: [],
  };
}

function serializePublicRechargeOrder(
  order: PublicRechargeOrderRecord,
): PublicAgentWalletOrder {
  return {
    id: order.id,
    billingProductId: order.billingProductId ?? null,
    billingPriceVersionId: order.billingPriceVersionId ?? null,
    productName: order.productNameSnapshot ?? null,
    entitlementUnits: order.entitlementUnitsSnapshot ?? null,
    unitName: order.unitNameSnapshot ?? null,
    amountCents: order.amountCents,
    currency: order.currency,
    provider: order.provider.toLowerCase() as PublicAgentWalletOrder["provider"],
    status: order.status.toLowerCase() as PublicAgentWalletOrder["status"],
    checkoutUrl:
      order.status === RechargeOrderStatus.REQUIRES_PAYMENT
        ? order.checkoutUrl
        : null,
    checkoutExpiresAt:
      order.provider === PaymentProvider.WECHAT_PAY
      && order.status === RechargeOrderStatus.REQUIRES_PAYMENT
        ? readWeChatPayCheckoutExpiresAt(order.providerPayload)
        : null,
    paidAt: isoDate(order.paidAt),
    refundedAt: isoDate(order.refundedAt),
    createdAt: order.createdAt.toISOString(),
  };
}

function serializePublicTokenPurchase(
  purchase: PublicAgentTokenPurchaseRecord,
): PublicAgentWalletPurchase {
  return {
    id: purchase.id,
    rechargeOrderId: purchase.rechargeOrderId,
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    tokenAmount: purchase.tokenAmount,
    remainingTokenAmount:
      purchase.remainingTokenAmount ?? purchase.tokenAmount,
    status:
      purchase.status.toLowerCase() as PublicAgentWalletPurchase["status"],
    refundedAt: isoDate(purchase.refundedAt),
    createdAt: purchase.createdAt.toISOString(),
  };
}

function serializePublicWalletRefund(
  transaction: PublicWalletRefundRecord,
): PublicAgentWalletRefund[] {
  const metadata = jsonObject(transaction.metadata);
  const purchaseId = transaction.sourceId?.trim();
  const tokenAmount = positiveIntegerMetadata(metadata, "tokenAmount");
  const amountCents = positiveIntegerMetadata(metadata, "amountCents");
  if (!purchaseId || tokenAmount === null || amountCents === null) {
    return [];
  }
  return [{
    id: transaction.id,
    purchaseId,
    currency: transaction.currency,
    tokenAmount,
    amountCents,
    status: "succeeded",
    completedAt:
      (transaction.completedAt ?? transaction.occurredAt).toISOString(),
  }];
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveIntegerMetadata(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function isoDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function requirePublicWalletValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
