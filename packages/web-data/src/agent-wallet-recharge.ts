import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  WalletTransactionEventType,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import {
  mockPaymentProviderAdapter,
  type PaymentProviderAdapter,
  type PaymentProviderWebhookInput,
  type NormalizedPaymentProviderEvent,
} from "./agent-wallet-payment-providers";
import {
  WECHAT_CREATED_ORDER_RECOVERY_DELAY_MS,
  enqueueWeChatPayOrderReconciliation,
} from "./agent-wallet-payment-reconciliation";
import {
  recordWalletTransaction,
  type WalletTransactionClient,
} from "./agent-wallet-transactions";
import {
  assertWalletIdempotencyField,
  resolveWalletOperationId,
  runWalletWriteTransaction,
  type WalletWriteTransactionOptions,
} from "./agent-wallet-write";
import {
  purchaseAgentTokens,
  type AgentTokenPurchaseSnapshot,
} from "./agent-wallet-token-purchase";
import { calculateAgentWalletRevenueSplit } from "./agent-wallet-revenue-policy";
import {
  grantPurchasedHandoffEntitlement,
  type PurchasedHandoffEntitlementSnapshot,
} from "./handoff-entitlements";
import { prisma } from "./prisma";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "./service-entitlements";

export const AGENT_WALLET_TIP_PRODUCT_CODE = "agent-wallet:tip:v1";

type UserWalletRecord = {
  id: string;
  audienceIdentityId: string | null;
  externalUserId: string;
  telegramUserId: string | null;
  email: string | null;
  displayName: string | null;
  currency: string;
  cashBalanceCents: number;
};

type RechargeOrderRecord = {
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
  providerTransactionId?: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  idempotencyKey: string;
  checkoutUrl: string | null;
  providerPayload?: unknown;
  paidAt: Date | null;
  refundedAt: Date | null;
  userWallet?: UserWalletRecord;
};

type PaymentProviderEventRecord = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  providerTransactionId?: string | null;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
};

type IdentityLinkRecord = {
  audienceIdentityId: string;
};

type TipCreatorEarningRecord = {
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
};

type TipContributionRecord = {
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
  completedAt: Date;
  creatorEarning?: TipCreatorEarningRecord;
};

type RechargeClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  userWallet: {
    findFirst?(args: unknown): Promise<UserWalletRecord | null>;
    findUnique?(args: unknown): Promise<UserWalletRecord | null>;
    upsert(args: unknown): Promise<UserWalletRecord>;
    update(args: unknown): Promise<UserWalletRecord>;
    updateMany?(args: unknown): Promise<{ count: number }>;
  };
  identityLink?: {
    upsert(args: unknown): Promise<IdentityLinkRecord>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderRecord | null>;
    create(args: unknown): Promise<RechargeOrderRecord>;
    update(args: unknown): Promise<RechargeOrderRecord>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  rechargeRefund: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  paymentProviderEvent: {
    findUnique(args: unknown): Promise<PaymentProviderEventRecord | null>;
    upsert(args: unknown): Promise<PaymentProviderEventRecord>;
  };
  agentWallet?: {
    findUnique(args: unknown): Promise<{
      id: string;
      representativeId: string;
      currency: string;
      representative?: { ownerId: string };
    } | null>;
  };
  creatorEarning?: {
    findUnique(args: unknown): Promise<TipCreatorEarningRecord | null>;
    create(args: unknown): Promise<TipCreatorEarningRecord>;
  };
  tipContribution?: {
    findUnique(args: unknown): Promise<TipContributionRecord | null>;
    create(args: unknown): Promise<TipContributionRecord>;
  };
  $transaction?<T>(
    fn: (tx: RechargeClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

export type RechargeOrderSnapshot = {
  id: string;
  userWalletId: string;
  externalUserId: string;
  amountCents: number;
  currency: string;
  provider:
    | "mock"
    | "stripe"
    | "wechat_pay"
    | "alipay"
    | "telegram_stars";
  providerOrderId: string | null;
  status: "created" | "requires_payment" | "paid" | "failed" | "canceled" | "refunded";
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  paidAt: string | null;
  cashBalanceCents: number;
  representativeId: string | null;
  billingProductId: string | null;
  billingPriceVersionId: string | null;
  productNameSnapshot: string | null;
  productKindSnapshot: "SERVICE_PACKAGE" | "TIP" | null;
  unitNameSnapshot: string | null;
  entitlementUnitsSnapshot: number | null;
  handoffAllowanceSnapshot: "NONE" | "LIMITED" | "UNLIMITED" | null;
  handoffUnitsSnapshot: number | null;
  handoffServiceLevelSnapshot: "STANDARD" | "PRIORITY" | null;
  handoffValidityDaysSnapshot: number | null;
  creatorRevenueShareBpsSnapshot: number | null;
  platformRevenueShareBpsSnapshot: number | null;
  refundPolicySnapshot: "FULL_WHEN_UNUSED" | "NON_REFUNDABLE" | null;
  expiryPolicySnapshot: "NEVER_EXPIRES" | null;
  entitlementValidityDaysSnapshot: number | null;
};

export type CreateRechargeOrderInput = {
  externalUserId: string;
  audienceIdentityId?: string;
  representativeId?: string;
  productCode?: string;
  billingProductId?: string;
  billingPriceVersionId?: string;
  productNameSnapshot?: string;
  productKindSnapshot?: "SERVICE_PACKAGE" | "TIP";
  unitNameSnapshot?: "credit" | "tip";
  entitlementUnitsSnapshot?: number;
  handoffAllowanceSnapshot?: "NONE" | "LIMITED" | "UNLIMITED";
  handoffUnitsSnapshot?: number | null;
  handoffServiceLevelSnapshot?: "STANDARD" | "PRIORITY" | null;
  handoffValidityDaysSnapshot?: number | null;
  creatorRevenueShareBpsSnapshot?: number;
  platformRevenueShareBpsSnapshot?: number;
  refundPolicySnapshot?: "FULL_WHEN_UNUSED" | "NON_REFUNDABLE";
  expiryPolicySnapshot?: "NEVER_EXPIRES";
  entitlementValidityDaysSnapshot?: null;
  amountCents: number;
  currency?: string;
  displayName?: string;
  telegramUserId?: string;
  idempotencyKey?: string;
  /**
   * Server-only fencing hooks for payment providers whose remote create call
   * must be serialized across replicas. The first hook runs inside the same
   * transaction that creates CREATED; the second runs immediately before the
   * provider request.
   */
  creationFence?: {
    lockBeforeLocalCreate(client: unknown): Promise<void>;
    renewBeforeProviderCreate(): Promise<void>;
  };
};

export type CreateMockRechargeOrderInput = CreateRechargeOrderInput;

export type CompleteMockRechargeOrderInput = {
  amountCents?: number;
  providerEventId?: string;
};

export type CompleteMockRechargeAndPurchaseInput = {
  rechargeOrderId: string;
  externalUserId: string;
  representativeId: string;
  amountCents?: number;
  providerEventId?: string;
  purchaseIdempotencyKey?: string;
};

export type TipCreatorEarningSnapshot = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  status: "pending" | "withdrawable" | "frozen" | "withdrawn" | "reversed";
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents: number;
  currency: string;
  revenueShareBps: number;
};

export type TipContributionSnapshot = {
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
  status: "completed";
  completedAt: string;
};

export type ServicePackagePaidCommerceFulfillment = {
  kind: "SERVICE_PACKAGE";
  tokenPurchase: AgentTokenPurchaseSnapshot;
  handoffEntitlement: PurchasedHandoffEntitlementSnapshot | null;
};

export type TipPaidCommerceFulfillment = {
  kind: "TIP";
  tipContribution: TipContributionSnapshot;
  creatorEarning: TipCreatorEarningSnapshot;
  cashBalanceCents: number;
};

export type PaidCommerceFulfillment =
  | ServicePackagePaidCommerceFulfillment
  | TipPaidCommerceFulfillment;

export type CompleteMockRechargeAndPurchaseSnapshot = {
  rechargeOrder: RechargeOrderSnapshot;
  fulfillment: PaidCommerceFulfillment;
} & (
  | {
      productKind: "SERVICE_PACKAGE";
      tokenPurchase: AgentTokenPurchaseSnapshot;
    }
  | {
      productKind: "TIP";
      tokenPurchase: null;
    }
);

export type CompleteRechargeFromProviderWebhookSnapshot =
  CompleteMockRechargeAndPurchaseSnapshot;

export class RechargePaymentConflictError extends Error {
  readonly code = "RECHARGE_PAYMENT_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "RechargePaymentConflictError";
  }
}

const SUPPORTED_RECHARGE_CURRENCIES = new Set(["CNY", "USD"]);

export function assertMockRechargeMutationsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error("Mock recharge mutations are disabled in production-like environments.");
  }
}

export async function createMockRechargeOrder(
  input: CreateMockRechargeOrderInput,
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
  assertMockRechargeMutationsEnabled();
  return createRechargeOrder(
    input,
    mockPaymentProviderAdapter,
    client,
  );
}

/**
 * Creates the local order before calling a payment network. The provider call
 * deliberately runs outside the serializable database transaction so network
 * latency cannot hold wallet locks. Retrying the same idempotency key reuses
 * both the local order id and the provider out-trade number. An ambiguous
 * WeChat result is never blindly submitted again here; its durable worker
 * queries the provider before deciding whether an exact retry is safe.
 */
export async function createRechargeOrder(
  input: CreateRechargeOrderInput,
  adapter: PaymentProviderAdapter,
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
  const normalized = normalizeCreateRechargeOrderInput(
    input,
    adapter.provider,
  );
  const prepare = async (tx: RechargeClient) => {
    const existing = await tx.rechargeOrder.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: { userWallet: true },
    });
    if (existing) {
      assertWalletIdempotencyField(
        `${adapter.provider.toLowerCase()} recharge`,
        "externalUserId",
        existing.userWallet?.externalUserId,
        normalized.externalUserId,
      );
      assertWalletIdempotencyField(
        `${adapter.provider.toLowerCase()} recharge`,
        "amountCents",
        existing.amountCents,
        normalized.amountCents,
      );
      assertWalletIdempotencyField(
        `${adapter.provider.toLowerCase()} recharge`,
        "currency",
        existing.currency,
        normalized.currency,
      );
      assertExistingRechargeOrderMatches(
        existing,
        normalized,
        adapter.provider,
      );
      const snapshot = serializeRechargeOrder(existing);
      await enqueueRecoverableWeChatOrderIfRequired(
        adapter.provider,
        snapshot.status,
        snapshot.id,
        tx,
      );
      return {
        snapshot,
        createdNow: false,
        preparedProviderPayload:
          existing.providerPayload,
      };
    }

    await input.creationFence?.lockBeforeLocalCreate(tx);
    const userWallet = await resolveRechargeUserWallet(normalized, tx);
    await linkPaymentExternalUserId(normalized, tx);

    let order = await tx.rechargeOrder.create({
      data: {
        userWalletId: userWallet.id,
        ...(normalized.representativeId
          ? { representativeId: normalized.representativeId }
          : {}),
        ...(normalized.productCode
          ? { productCode: normalized.productCode }
          : {}),
        ...(normalized.billingProductId
          ? { billingProductId: normalized.billingProductId }
          : {}),
        ...(normalized.billingPriceVersionId
          ? { billingPriceVersionId: normalized.billingPriceVersionId }
          : {}),
        ...(normalized.productNameSnapshot
          ? { productNameSnapshot: normalized.productNameSnapshot }
          : {}),
        ...(normalized.productKindSnapshot
          ? { productKindSnapshot: normalized.productKindSnapshot }
          : {}),
        ...(normalized.unitNameSnapshot
          ? { unitNameSnapshot: normalized.unitNameSnapshot }
          : {}),
        ...(normalized.entitlementUnitsSnapshot !== undefined
          ? {
              entitlementUnitsSnapshot:
                normalized.entitlementUnitsSnapshot,
            }
          : {}),
        ...(normalized.handoffAllowanceSnapshot
          ? {
              handoffAllowanceSnapshot:
                normalized.handoffAllowanceSnapshot,
              handoffUnitsSnapshot: normalized.handoffUnitsSnapshot,
              handoffServiceLevelSnapshot:
                normalized.handoffServiceLevelSnapshot,
              handoffValidityDaysSnapshot:
                normalized.handoffValidityDaysSnapshot,
            }
          : {}),
        ...(normalized.creatorRevenueShareBpsSnapshot !== undefined
          ? {
              creatorRevenueShareBpsSnapshot:
                normalized.creatorRevenueShareBpsSnapshot,
            }
          : {}),
        ...(normalized.platformRevenueShareBpsSnapshot !== undefined
          ? {
              platformRevenueShareBpsSnapshot:
                normalized.platformRevenueShareBpsSnapshot,
            }
          : {}),
        ...(normalized.refundPolicySnapshot
          ? { refundPolicySnapshot: normalized.refundPolicySnapshot }
          : {}),
        ...(normalized.expiryPolicySnapshot
          ? { expiryPolicySnapshot: normalized.expiryPolicySnapshot }
          : {}),
        ...(normalized.billingPriceVersionId
          ? {
              entitlementValidityDaysSnapshot:
                normalized.entitlementValidityDaysSnapshot,
            }
          : {}),
        provider: adapter.provider,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        status: RechargeOrderStatus.CREATED,
        idempotencyKey: normalized.idempotencyKey,
      },
    });
    const checkoutInput = {
      rechargeOrderId: order.id,
      externalUserId: userWallet.externalUserId,
      amountCents: order.amountCents,
      currency: order.currency,
      idempotencyKey: normalized.idempotencyKey,
    };
    const preparedProviderPayload =
      adapter.prepareRechargeCheckout
        ? await adapter.prepareRechargeCheckout(checkoutInput)
        : undefined;
    if (preparedProviderPayload !== undefined) {
      order = await tx.rechargeOrder.update({
        where: { id: order.id },
        data: {
          providerPayload: preparedProviderPayload,
        },
      });
    }
    await enqueueRecoverableWeChatOrderIfRequired(
      adapter.provider,
      "created",
      order.id,
      tx,
    );
    return {
      snapshot: serializeRechargeOrder({
        ...order,
        userWallet,
      }),
      createdNow: true,
      preparedProviderPayload,
    };
  };

  const prepared = await runWalletWriteTransaction(client, prepare);
  if (
    prepared.snapshot.status !== "created"
    || (
      !prepared.createdNow
      && adapter.provider === PaymentProvider.WECHAT_PAY
    )
  ) {
    return prepared.snapshot;
  }

  await input.creationFence?.renewBeforeProviderCreate();
  const checkout = await adapter.createRechargeCheckout({
    rechargeOrderId: prepared.snapshot.id,
    externalUserId: prepared.snapshot.externalUserId,
    amountCents: prepared.snapshot.amountCents,
    currency: prepared.snapshot.currency,
    idempotencyKey: normalized.idempotencyKey,
    ...(prepared.preparedProviderPayload !== undefined
      ? {
          preparedProviderPayload:
            prepared.preparedProviderPayload,
        }
      : {}),
  });
  if (checkout.provider !== adapter.provider) {
    throw new Error("Payment provider checkout returned a different provider.");
  }
  const providerOrderId = checkout.providerOrderId.trim();
  if (!providerOrderId) {
    throw new Error("Payment provider checkout did not return an order id.");
  }

  return runWalletWriteTransaction(client, async (tx) => {
    const current = await tx.rechargeOrder.findUnique({
      where: { id: prepared.snapshot.id },
      include: { userWallet: true },
    });
    if (!current?.userWallet) {
      throw new Error("Recharge order disappeared before checkout was saved.");
    }
    assertExistingRechargeOrderMatches(
      current,
      normalized,
      adapter.provider,
    );
    if (current.status !== RechargeOrderStatus.CREATED) {
      assertWalletIdempotencyField(
        `${adapter.provider.toLowerCase()} recharge`,
        "providerOrderId",
        current.providerOrderId,
        providerOrderId,
      );
      await enqueueRecoverableWeChatOrderIfRequired(
        adapter.provider,
        serializeRechargeOrder(current).status,
        current.id,
        tx,
      );
      return serializeRechargeOrder(current);
    }

    const updated = await tx.rechargeOrder.updateMany({
      where: {
        id: current.id,
        provider: adapter.provider,
        status: RechargeOrderStatus.CREATED,
      },
      data: {
        providerOrderId,
        checkoutUrl: checkout.checkoutUrl,
        providerPayload: checkout.providerPayload,
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
      },
    });
    if (updated.count !== 1) {
      const raced = await tx.rechargeOrder.findUnique({
        where: { id: current.id },
        include: { userWallet: true },
      });
      if (!raced?.userWallet) {
        throw new Error("Recharge order state changed concurrently.");
      }
      assertWalletIdempotencyField(
        `${adapter.provider.toLowerCase()} recharge`,
        "providerOrderId",
        raced.providerOrderId,
        providerOrderId,
      );
      await enqueueRecoverableWeChatOrderIfRequired(
        adapter.provider,
        serializeRechargeOrder(raced).status,
        raced.id,
        tx,
      );
      return serializeRechargeOrder(raced);
    }

    await enqueueRecoverableWeChatOrderIfRequired(
      adapter.provider,
      "requires_payment",
      current.id,
      tx,
    );
    return serializeRechargeOrder({
      ...current,
      providerOrderId,
      checkoutUrl: checkout.checkoutUrl,
      providerPayload: checkout.providerPayload,
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
    });
  });
}

async function enqueueRecoverableWeChatOrderIfRequired(
  provider: PaymentProvider,
  status: RechargeOrderSnapshot["status"],
  rechargeOrderId: string,
  client: RechargeClient,
): Promise<void> {
  if (
    provider !== PaymentProvider.WECHAT_PAY
    || (
      status !== "created"
      && status !== "requires_payment"
    )
  ) {
    return;
  }
  await enqueueWeChatPayOrderReconciliation(
    rechargeOrderId,
    client as unknown as Parameters<
      typeof enqueueWeChatPayOrderReconciliation
    >[1],
    status === "created"
      ? {
          initialDelayMs:
            WECHAT_CREATED_ORDER_RECOVERY_DELAY_MS,
        }
      : {},
  );
}

export async function completeMockRechargeOrder(
  rechargeOrderId: string,
  input: CompleteMockRechargeOrderInput = {},
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
  assertMockRechargeMutationsEnabled();
  if (!rechargeOrderId.trim()) {
    throw new Error("Recharge order id is required.");
  }

  const run = async (tx: RechargeClient) => {
    const order = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      include: { userWallet: true },
    });
    if (!order?.userWallet) {
      throw new Error("Recharge order not found.");
    }
    if (order.provider !== PaymentProvider.MOCK) {
      throw new Error("Only mock recharge orders can be completed by this operation.");
    }
    if (typeof input.amountCents === "number" && input.amountCents !== order.amountCents) {
      throw new Error("Mock payment amount does not match recharge order.");
    }

    const normalizedEvent = await mockPaymentProviderAdapter.normalizeWebhookEvent({
      payload: {
        providerEventId: input.providerEventId ?? `mock_recharge_paid_${order.id}`,
        rechargeOrderId: order.id,
        providerOrderId: order.providerOrderId,
        amountCents: order.amountCents,
        currency: order.currency,
        status: "paid",
      },
    });
    if (normalizedEvent.eventType !== PaymentProviderEventType.RECHARGE_PAID) {
      throw new Error("Mock payment event is not a paid recharge event.");
    }
    return applyVerifiedPaidRechargeEvent(normalizedEvent, tx);
  };

  return runWalletWriteTransaction(client, run);
}

export async function completeRechargeFromProviderWebhook(
  adapter: PaymentProviderAdapter,
  input: PaymentProviderWebhookInput,
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
  const normalizedEvent = await adapter.normalizeWebhookEvent(input);
  if (normalizedEvent.provider !== adapter.provider) {
    throw new Error("Payment provider webhook returned a different provider.");
  }
  return runWalletWriteTransaction(
    client,
    (tx) => applyVerifiedPaidRechargeEvent(normalizedEvent, tx),
  );
}

async function applyVerifiedPaidRechargeEvent(
  normalizedEvent: NormalizedPaymentProviderEvent,
  tx: RechargeClient,
): Promise<RechargeOrderSnapshot> {
  if (normalizedEvent.eventType !== PaymentProviderEventType.RECHARGE_PAID) {
    throw new RechargePaymentConflictError(
      "Payment provider event is not a paid recharge event.",
    );
  }
  if (!normalizedEvent.rechargeOrderId) {
    throw new RechargePaymentConflictError(
      "Payment provider event is missing the recharge order id.",
    );
  }
  if (
    normalizedEvent.provider === PaymentProvider.WECHAT_PAY
    && !normalizedEvent.providerTransactionId
  ) {
    throw new RechargePaymentConflictError(
      "WeChat Pay event is missing the provider transaction id.",
    );
  }

  const order = await tx.rechargeOrder.findUnique({
    where: { id: normalizedEvent.rechargeOrderId },
    include: { userWallet: true },
  });
  if (!order?.userWallet) {
    throw new RechargePaymentConflictError("Recharge order not found.");
  }
  assertPaymentEventMatchesRechargeOrder(normalizedEvent, order);

  const existingProviderEvent = await tx.paymentProviderEvent.findUnique({
    where: {
      provider_providerEventId: {
        provider: normalizedEvent.provider,
        providerEventId: normalizedEvent.providerEventId,
      },
    },
  });
  const existingTransactionEvent =
    normalizedEvent.providerTransactionId
      ? await tx.paymentProviderEvent.findUnique({
          where: {
            provider_providerTransactionId: {
              provider: normalizedEvent.provider,
              providerTransactionId:
                normalizedEvent.providerTransactionId,
            },
          },
        })
      : null;
  assertProviderEventCanAttach(
    existingProviderEvent,
    normalizedEvent,
    order,
  );
  assertProviderEventCanAttach(
    existingTransactionEvent,
    normalizedEvent,
    order,
  );

  if (order.status === RechargeOrderStatus.PAID) {
    assertWalletIdempotencyField(
      `${order.provider.toLowerCase()} recharge payment`,
      "providerTransactionId",
      order.providerTransactionId ?? null,
      normalizedEvent.providerTransactionId,
    );
    return serializeRechargeOrder(order);
  }
  const acceptsVerifiedLateWeChatPayment =
    normalizedEvent.provider === PaymentProvider.WECHAT_PAY
    && (
      order.status === RechargeOrderStatus.CANCELED
      || order.status === RechargeOrderStatus.CREATED
    );
  if (
    order.status !== RechargeOrderStatus.REQUIRES_PAYMENT
    && !acceptsVerifiedLateWeChatPayment
  ) {
    throw new RechargePaymentConflictError(
      `Recharge order cannot be paid from status ${order.status}.`,
    );
  }

  const successfulRefund = await tx.rechargeRefund.findFirst({
    where: {
      rechargeOrderId: order.id,
      provider: normalizedEvent.provider,
      providerStatus: RechargeRefundProviderStatus.SUCCEEDED,
    },
    select: { id: true },
  });
  if (successfulRefund) {
    throw new RechargePaymentConflictError(
      "Recharge order already has a successful provider refund and cannot be paid.",
    );
  }

  const processedAt = normalizedEvent.verifiedAt ?? new Date();
  const paidAt =
    normalizedEvent.providerOccurredAt
    ?? processedAt;
  const claimed = await tx.rechargeOrder.updateMany({
    where: {
      id: order.id,
      provider: order.provider,
      amountCents: order.amountCents,
      currency: order.currency,
      status: order.status,
    },
    data: {
      status: RechargeOrderStatus.PAID,
      paidAt,
      providerOrderId: normalizedEvent.providerOrderId,
      providerTransactionId: normalizedEvent.providerTransactionId,
    },
  });
  if (claimed.count !== 1) {
    const current = await tx.rechargeOrder.findUnique({
      where: { id: order.id },
      include: { userWallet: true },
    });
    if (current?.status === RechargeOrderStatus.PAID && current.userWallet) {
      assertWalletIdempotencyField(
        `${order.provider.toLowerCase()} recharge payment`,
        "providerTransactionId",
        current.providerTransactionId ?? null,
        normalizedEvent.providerTransactionId,
      );
      return serializeRechargeOrder(current);
    }
    throw new Error("Recharge order state changed concurrently.");
  }

  const providerEvent =
    existingTransactionEvent
    ?? await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: normalizedEvent.provider,
          providerEventId: normalizedEvent.providerEventId,
        },
      },
      create: {
        provider: normalizedEvent.provider,
        providerEventId: normalizedEvent.providerEventId,
        providerTransactionId:
          normalizedEvent.providerTransactionId,
        eventType: normalizedEvent.eventType,
        rechargeOrderId: order.id,
        rawPayload: normalizedEvent.rawPayload,
        normalizedPayload: normalizedEvent.normalizedPayload,
        verifiedAt: normalizedEvent.verifiedAt,
        processedAt,
        idempotencyKey: normalizedEvent.idempotencyKey,
      },
      update: {
        processedAt,
      },
    });
  assertWalletIdempotencyField(
    `${order.provider.toLowerCase()} recharge payment event`,
    "rechargeOrderId",
    providerEvent.rechargeOrderId,
    order.id,
  );
  assertWalletIdempotencyField(
    `${order.provider.toLowerCase()} recharge payment event`,
    "eventType",
    providerEvent.eventType,
    PaymentProviderEventType.RECHARGE_PAID,
  );
  assertProviderEventCanAttach(providerEvent, normalizedEvent, order);

  const walletTransaction = await recordWalletTransaction(
    {
      eventGroupId: `recharge:${order.id}`,
      idempotencyKey: `recharge:${order.id}:paid`,
      sourceType: "RechargeOrder",
      sourceId: order.id,
      eventType: WalletTransactionEventType.USER_RECHARGE,
      currency: order.currency,
      userWalletId: order.userWallet.id,
      metadata: {
        amountCents: order.amountCents,
        paymentProvider: order.provider,
        paymentProviderEventId: providerEvent.id,
        providerTransactionId:
          normalizedEvent.providerTransactionId,
      },
    },
    tx,
  );

  const ledgerNotes = `${order.provider.toLowerCase()}_recharge_paid`;
  await recordWalletLedgerTransaction(
    {
      eventGroupId: `recharge:${order.id}`,
      idempotencyKey: `recharge:${order.id}:paid`,
      currency: order.currency,
      requireBalancedAmount: true,
      initialBalances: {
        [`${AmnWalletAccountType.USER_CASH}:${order.userWallet.id}`]: {
          amountCents: order.userWallet.cashBalanceCents,
        },
      },
      movements: [
        {
          entryKey: "user_cash_recharge",
          accountType: AmnWalletAccountType.USER_CASH,
          entryKind: AmnLedgerEntryKind.USER_RECHARGE,
          transactionId: walletTransaction?.id ?? null,
          userWalletId: order.userWallet.id,
          rechargeOrderId: order.id,
          paymentProviderEventId: providerEvent.id,
          amountCents: order.amountCents,
          notes: ledgerNotes,
        },
        {
          entryKey: "external_settlement_debit",
          accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
          entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_DEBIT,
          transactionId: walletTransaction?.id ?? null,
          rechargeOrderId: order.id,
          paymentProviderEventId: providerEvent.id,
          amountCents: -order.amountCents,
          notes: ledgerNotes,
          metadata: {
            provider: order.provider,
          },
        },
      ],
    },
    tx,
  );

  const updatedWallet = await tx.userWallet.update({
    where: { id: order.userWallet.id },
    data: {
      cashBalanceCents: {
        increment: order.amountCents,
      },
    },
  });

  return serializeRechargeOrder({
    ...order,
    providerOrderId: normalizedEvent.providerOrderId,
    providerTransactionId:
      normalizedEvent.providerTransactionId,
    status: RechargeOrderStatus.PAID,
    paidAt,
    userWallet: updatedWallet,
  });
}

export async function completeMockRechargeAndPurchaseAgentTokens(
  input: CompleteMockRechargeAndPurchaseInput,
  client: typeof prisma = prisma,
): Promise<CompleteMockRechargeAndPurchaseSnapshot> {
  const rechargeOrderId = input.rechargeOrderId.trim();
  const externalUserId = input.externalUserId.trim();
  const representativeId = input.representativeId.trim();
  if (!rechargeOrderId) throw new Error("Recharge order id is required.");
  if (!externalUserId) throw new Error("externalUserId is required.");
  if (!representativeId) throw new Error("representativeId is required.");

  return runWalletWriteTransaction(client, async (tx) => {
    const purchaseIntent = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      select: {
        representativeId: true,
        productCode: true,
        productKindSnapshot: true,
        billingPriceVersionId: true,
      },
    });
    if (
      purchaseIntent?.representativeId !== representativeId
      || !isSupportedCommerceIntent(purchaseIntent)
    ) {
      throw new RechargePaymentConflictError(
        "Recharge order does not match the intended representative commerce product.",
      );
    }
    const rechargeOrder = await completeMockRechargeOrder(
      rechargeOrderId,
      {
        ...(input.amountCents !== undefined
          ? { amountCents: input.amountCents }
          : {}),
        ...(input.providerEventId
          ? { providerEventId: input.providerEventId }
          : {}),
      },
      tx as unknown as NonNullable<
        Parameters<typeof completeMockRechargeOrder>[2]
      >,
    );
    if (rechargeOrder.externalUserId !== externalUserId) {
      throw new Error("Recharge order does not belong to this external user.");
    }

    const fulfillment = await fulfillPaidCommerceOrder(
      rechargeOrder,
      externalUserId,
      representativeId,
      input.purchaseIdempotencyKey
        ?? `recharge_purchase:${rechargeOrder.id}:${representativeId}`,
      tx,
    );
    return buildPaidCommerceCompletion(rechargeOrder, fulfillment);
  });
}

/**
 * Verifies and normalizes the provider callback before opening the wallet
 * transaction, then atomically credits cash and purchases the representative-
 * scoped service credits captured by the original order intent.
 */
export async function completeRechargeAndPurchaseAgentTokensFromProviderWebhook(
  adapter: PaymentProviderAdapter,
  webhook: PaymentProviderWebhookInput,
  client: typeof prisma = prisma,
): Promise<CompleteRechargeFromProviderWebhookSnapshot> {
  const normalizedEvent = await adapter.normalizeWebhookEvent(webhook);
  if (normalizedEvent.provider !== adapter.provider) {
    throw new Error("Payment provider webhook returned a different provider.");
  }
  return completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
    normalizedEvent,
    client,
  );
}

/**
 * Applies a provider event that has already passed the provider-specific
 * signature and identity checks. This is shared by the asynchronous callback
 * and the signed order-query recovery path so both routes have identical
 * idempotency and wallet transaction semantics.
 */
export async function completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
  normalizedEvent: NormalizedPaymentProviderEvent,
  client: typeof prisma = prisma,
): Promise<CompleteRechargeFromProviderWebhookSnapshot> {
  const rechargeOrderId = normalizedEvent.rechargeOrderId?.trim();
  if (!rechargeOrderId) {
    throw new Error("Payment provider event is missing the recharge order id.");
  }

  return runWalletWriteTransaction(client, async (tx) => {
    const purchaseIntent = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      select: {
        representativeId: true,
        productCode: true,
        productKindSnapshot: true,
        userWallet: {
          select: {
            externalUserId: true,
          },
        },
      },
    });
    if (
      !purchaseIntent?.representativeId
      || !isSupportedCommerceIntent(purchaseIntent)
    ) {
      throw new Error(
        "Recharge order does not match the intended representative commerce product.",
      );
    }

    const rechargeOrder = await applyVerifiedPaidRechargeEvent(
      normalizedEvent,
      tx as unknown as RechargeClient,
    );
    if (
      rechargeOrder.externalUserId
      !== purchaseIntent.userWallet.externalUserId
    ) {
      throw new RechargePaymentConflictError(
        "Recharge order wallet identity changed unexpectedly.",
      );
    }
    const fulfillment = await fulfillPaidCommerceOrder(
      rechargeOrder,
      purchaseIntent.userWallet.externalUserId,
      purchaseIntent.representativeId,
      `recharge_purchase:${rechargeOrder.id}:${purchaseIntent.representativeId}`,
      tx,
    );
    return buildPaidCommerceCompletion(rechargeOrder, fulfillment);
  });
}

function isSupportedCommerceIntent(intent: {
  productCode: string | null;
  productKindSnapshot?: string | null;
}) {
  return (
    intent.productCode === AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
    && (intent.productKindSnapshot == null
      || intent.productKindSnapshot === "SERVICE_PACKAGE")
  ) || (
    intent.productCode === AGENT_WALLET_TIP_PRODUCT_CODE
    && intent.productKindSnapshot === "TIP"
  );
}

async function fulfillPaidCommerceOrder(
  rechargeOrder: RechargeOrderSnapshot,
  externalUserId: string,
  representativeId: string,
  servicePurchaseIdempotencyKey: string,
  transactionClient: unknown,
): Promise<PaidCommerceFulfillment> {
  if (
    rechargeOrder.productKindSnapshot === "TIP"
    && rechargeOrder.unitNameSnapshot === "tip"
  ) {
    return fulfillPaidTip(
      rechargeOrder,
      representativeId,
      transactionClient as RechargeClient,
    );
  }
  if (
    rechargeOrder.productKindSnapshot !== null
    && rechargeOrder.productKindSnapshot !== "SERVICE_PACKAGE"
  ) {
    throw new RechargePaymentConflictError(
      "Paid order has an unsupported commerce product kind.",
    );
  }
  const tokenPurchase = await purchaseRechargeServiceCredits(
    rechargeOrder,
    externalUserId,
    representativeId,
    servicePurchaseIdempotencyKey,
    transactionClient,
  );
  const handoffEntitlement =
    rechargeOrder.handoffAllowanceSnapshot
      && rechargeOrder.handoffAllowanceSnapshot !== "NONE"
      ? await grantPurchasedHandoffEntitlement(
          { rechargeOrderId: rechargeOrder.id },
          transactionClient as Parameters<
            typeof grantPurchasedHandoffEntitlement
          >[1],
        )
      : null;
  return { kind: "SERVICE_PACKAGE", tokenPurchase, handoffEntitlement };
}

function buildPaidCommerceCompletion(
  rechargeOrder: RechargeOrderSnapshot,
  fulfillment: PaidCommerceFulfillment,
): CompleteMockRechargeAndPurchaseSnapshot {
  if (fulfillment.kind === "TIP") {
    return {
      productKind: "TIP",
      rechargeOrder: {
        ...rechargeOrder,
        cashBalanceCents: fulfillment.cashBalanceCents,
      },
      tokenPurchase: null,
      fulfillment,
    };
  }
  return {
    productKind: "SERVICE_PACKAGE",
    rechargeOrder: {
      ...rechargeOrder,
      cashBalanceCents: fulfillment.tokenPurchase.cashBalanceCents,
    },
    tokenPurchase: fulfillment.tokenPurchase,
    fulfillment,
  };
}

async function fulfillPaidTip(
  rechargeOrder: RechargeOrderSnapshot,
  representativeId: string,
  tx: RechargeClient,
): Promise<TipPaidCommerceFulfillment> {
  if (
    rechargeOrder.productKindSnapshot !== "TIP"
    || rechargeOrder.unitNameSnapshot !== "tip"
    || rechargeOrder.entitlementUnitsSnapshot !== 0
    || rechargeOrder.refundPolicySnapshot !== "NON_REFUNDABLE"
    || rechargeOrder.expiryPolicySnapshot !== "NEVER_EXPIRES"
    || rechargeOrder.entitlementValidityDaysSnapshot !== null
    || rechargeOrder.handoffAllowanceSnapshot !== "NONE"
    || rechargeOrder.handoffUnitsSnapshot !== null
    || rechargeOrder.handoffServiceLevelSnapshot !== null
    || rechargeOrder.handoffValidityDaysSnapshot !== null
    || !rechargeOrder.billingProductId
    || !rechargeOrder.billingPriceVersionId
    || rechargeOrder.creatorRevenueShareBpsSnapshot === null
    || rechargeOrder.platformRevenueShareBpsSnapshot === null
    || rechargeOrder.creatorRevenueShareBpsSnapshot
      + rechargeOrder.platformRevenueShareBpsSnapshot !== 10_000
  ) {
    throw new RechargePaymentConflictError(
      "Paid tip order has an incomplete or unsupported commercial snapshot.",
    );
  }
  if (
    !tx.tipContribution
    || !tx.creatorEarning
    || !tx.agentWallet
    || !tx.userWallet.findUnique
    || !tx.userWallet.updateMany
  ) {
    throw new Error("Tip fulfillment persistence is unavailable.");
  }
  const wallet = await tx.userWallet.findUnique({
    where: { id: rechargeOrder.userWalletId },
  });
  if (!wallet?.audienceIdentityId) {
    throw new Error("Tip payer wallet must be linked to an audience identity.");
  }
  const existing = await tx.tipContribution.findUnique({
    where: { rechargeOrderId: rechargeOrder.id },
    include: { creatorEarning: true },
  });
  if (existing) {
    assertExistingTipContributionMatches(existing, rechargeOrder, wallet);
    if (!existing.creatorEarning) {
      throw new Error("Tip contribution is missing its creator earning.");
    }
    return {
      kind: "TIP",
      tipContribution: serializeTipContribution(existing),
      creatorEarning: serializeTipCreatorEarning(existing.creatorEarning),
      cashBalanceCents: wallet.cashBalanceCents,
    };
  }
  if (wallet.currency !== rechargeOrder.currency) {
    throw new Error("Tip payer wallet currency does not match the order.");
  }
  if (wallet.cashBalanceCents < rechargeOrder.amountCents) {
    throw new Error("Insufficient user wallet balance for tip fulfillment.");
  }
  const agentWallet = await tx.agentWallet.findUnique({
    where: { representativeId },
    include: { representative: true },
  });
  if (!agentWallet?.representative) {
    throw new Error("Representative agent wallet was not found.");
  }
  if (agentWallet.currency !== rechargeOrder.currency) {
    throw new Error("Representative wallet currency does not match the tip.");
  }
  const revenueSplit = calculateAgentWalletRevenueSplit({
    grossAmountCents: rechargeOrder.amountCents,
    creatorRevenueShareBps:
      rechargeOrder.creatorRevenueShareBpsSnapshot,
  });
  if (
    revenueSplit.platformGrossCents
      !== rechargeOrder.amountCents - revenueSplit.creatorShareCents
    || 10_000 - revenueSplit.creatorRevenueShareBps
      !== rechargeOrder.platformRevenueShareBpsSnapshot
  ) {
    throw new Error("Tip revenue split does not match the order snapshot.");
  }

  const debit = await tx.userWallet.updateMany({
    where: {
      id: wallet.id,
      currency: wallet.currency,
      cashBalanceCents: {
        equals: wallet.cashBalanceCents,
        gte: rechargeOrder.amountCents,
      },
    },
    data: {
      cashBalanceCents: { decrement: rechargeOrder.amountCents },
    },
  });
  if (debit.count !== 1) {
    throw new Error("Tip wallet balance changed concurrently.");
  }
  const creatorEarning = await tx.creatorEarning.create({
    data: {
      ownerId: agentWallet.representative.ownerId,
      representativeId,
      agentWalletId: agentWallet.id,
      status: CreatorEarningStatus.WITHDRAWABLE,
      pendingCents: 0,
      withdrawableCents: revenueSplit.creatorShareCents,
      currency: rechargeOrder.currency,
      revenueShareBps: revenueSplit.creatorRevenueShareBps,
      idempotencyKey: `tip_creator_earning:${rechargeOrder.id}`,
    },
  });
  const tipContribution = await tx.tipContribution.create({
    data: {
      rechargeOrderId: rechargeOrder.id,
      audienceIdentityId: wallet.audienceIdentityId,
      representativeId,
      agentWalletId: agentWallet.id,
      creatorEarningId: creatorEarning.id,
      amountMinor: rechargeOrder.amountCents,
      currency: rechargeOrder.currency,
      creatorRevenueShareBps: revenueSplit.creatorRevenueShareBps,
      platformRevenueShareBps:
        10_000 - revenueSplit.creatorRevenueShareBps,
      creatorAmountMinor: revenueSplit.creatorShareCents,
      platformAmountMinor: revenueSplit.platformGrossCents,
      status: "COMPLETED",
      idempotencyKey: `tip:${rechargeOrder.id}`,
      completedAt: rechargeOrder.paidAt
        ? new Date(rechargeOrder.paidAt)
        : new Date(),
    },
  });
  const walletTransaction = await recordWalletTransaction(
    {
      eventGroupId: `tip:${tipContribution.id}`,
      idempotencyKey: `tip:${rechargeOrder.id}:fulfilled`,
      sourceType: "TipContribution",
      sourceId: tipContribution.id,
      eventType: WalletTransactionEventType.ADJUSTMENT,
      currency: rechargeOrder.currency,
      ownerId: agentWallet.representative.ownerId,
      representativeId,
      userWalletId: wallet.id,
      metadata: {
        rechargeOrderId: rechargeOrder.id,
        amountCents: rechargeOrder.amountCents,
        creatorAmountCents: revenueSplit.creatorShareCents,
        platformAmountCents: revenueSplit.platformGrossCents,
      },
    },
    tx,
  );
  await recordWalletLedgerTransaction(
    {
      eventGroupId: `tip:${tipContribution.id}`,
      idempotencyKey: `tip:${rechargeOrder.id}:fulfilled`,
      currency: rechargeOrder.currency,
      requireBalancedAmount: true,
      initialBalances: {
        [`${AmnWalletAccountType.USER_CASH}:${wallet.id}`]: {
          amountCents: wallet.cashBalanceCents,
        },
      },
      movements: [
        {
          entryKey: "user_cash_debit",
          accountType: AmnWalletAccountType.USER_CASH,
          entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
          transactionId: walletTransaction?.id ?? null,
          userWalletId: wallet.id,
          representativeId,
          rechargeOrderId: rechargeOrder.id,
          amountCents: -rechargeOrder.amountCents,
          notes: "tip_fulfillment",
        },
        {
          entryKey: "creator_withdrawable_credit",
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
          transactionId: walletTransaction?.id ?? null,
          ownerId: agentWallet.representative.ownerId,
          representativeId,
          agentWalletId: agentWallet.id,
          creatorEarningId: creatorEarning.id,
          rechargeOrderId: rechargeOrder.id,
          amountCents: revenueSplit.creatorShareCents,
          notes: "tip_fulfillment",
        },
        {
          entryKey: "platform_earned_revenue_credit",
          accountType: AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
          entryKind: AmnLedgerEntryKind.PLATFORM_EARNED_REVENUE_CREDIT,
          transactionId: walletTransaction?.id ?? null,
          representativeId,
          agentWalletId: agentWallet.id,
          rechargeOrderId: rechargeOrder.id,
          amountCents: revenueSplit.platformGrossCents,
          notes: "tip_fulfillment",
        },
      ],
    },
    tx,
  );
  await attributeRechargeToRepresentative(
    rechargeOrder.id,
    representativeId,
    agentWallet.representative.ownerId,
    tx,
  );
  const updatedWallet = await tx.userWallet.findUnique({
    where: { id: wallet.id },
  });
  if (!updatedWallet) throw new Error("Tip payer wallet was not found after debit.");
  return {
    kind: "TIP",
    tipContribution: serializeTipContribution(tipContribution),
    creatorEarning: serializeTipCreatorEarning(creatorEarning),
    cashBalanceCents: updatedWallet.cashBalanceCents,
  };
}

function assertExistingTipContributionMatches(
  contribution: TipContributionRecord,
  order: RechargeOrderSnapshot,
  wallet: UserWalletRecord,
) {
  const mismatches = [
    contribution.rechargeOrderId !== order.id ? "recharge order" : null,
    contribution.audienceIdentityId !== wallet.audienceIdentityId
      ? "audience identity"
      : null,
    contribution.representativeId !== orderRepresentativeId(order)
      ? "representative"
      : null,
    contribution.amountMinor !== order.amountCents ? "amount" : null,
    contribution.currency !== order.currency ? "currency" : null,
    contribution.creatorRevenueShareBps
      !== order.creatorRevenueShareBpsSnapshot
      ? "creator revenue share"
      : null,
    contribution.platformRevenueShareBps
      !== order.platformRevenueShareBpsSnapshot
      ? "platform revenue share"
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new RechargePaymentConflictError(
      `Existing tip fulfillment differs in ${mismatches.join(", ")}.`,
    );
  }
}

function orderRepresentativeId(order: RechargeOrderSnapshot) {
  return order.representativeId;
}

function serializeTipContribution(
  contribution: TipContributionRecord,
): TipContributionSnapshot {
  return {
    id: contribution.id,
    rechargeOrderId: contribution.rechargeOrderId,
    audienceIdentityId: contribution.audienceIdentityId,
    representativeId: contribution.representativeId,
    agentWalletId: contribution.agentWalletId,
    creatorEarningId: contribution.creatorEarningId,
    amountMinor: contribution.amountMinor,
    currency: contribution.currency,
    creatorRevenueShareBps: contribution.creatorRevenueShareBps,
    platformRevenueShareBps: contribution.platformRevenueShareBps,
    creatorAmountMinor: contribution.creatorAmountMinor,
    platformAmountMinor: contribution.platformAmountMinor,
    status: "completed",
    completedAt: contribution.completedAt.toISOString(),
  };
}

function serializeTipCreatorEarning(
  earning: TipCreatorEarningRecord,
): TipCreatorEarningSnapshot {
  return {
    id: earning.id,
    ownerId: earning.ownerId,
    representativeId: earning.representativeId,
    agentWalletId: earning.agentWalletId,
    status: serializeCreatorEarningStatus(earning.status),
    pendingCents: earning.pendingCents,
    withdrawableCents: earning.withdrawableCents,
    frozenCents: earning.frozenCents,
    withdrawnCents: earning.withdrawnCents,
    currency: earning.currency,
    revenueShareBps: earning.revenueShareBps,
  };
}

function serializeCreatorEarningStatus(
  status: CreatorEarningStatus,
): TipCreatorEarningSnapshot["status"] {
  switch (status) {
    case CreatorEarningStatus.PENDING:
      return "pending";
    case CreatorEarningStatus.WITHDRAWABLE:
      return "withdrawable";
    case CreatorEarningStatus.FROZEN:
      return "frozen";
    case CreatorEarningStatus.WITHDRAWN:
      return "withdrawn";
    case CreatorEarningStatus.REVERSED:
      return "reversed";
  }
}

async function attributeRechargeToRepresentative(
  rechargeOrderId: string,
  representativeId: string,
  ownerId: string,
  transactionClient: unknown,
) {
  const attributionClient = transactionClient as {
    walletTransaction?: {
      updateMany(args: unknown): Promise<unknown>;
    };
    walletLedgerEntry: {
      updateMany?(args: unknown): Promise<unknown>;
    };
  };
  await Promise.all([
    attributionClient.walletTransaction?.updateMany({
      where: { eventGroupId: `recharge:${rechargeOrderId}` },
      data: { ownerId, representativeId },
    }) ?? Promise.resolve(),
    attributionClient.walletLedgerEntry.updateMany?.({
      where: { eventGroupId: `recharge:${rechargeOrderId}` },
      data: { ownerId, representativeId },
    }) ?? Promise.resolve(),
  ]);
}

async function purchaseRechargeServiceCredits(
  rechargeOrder: RechargeOrderSnapshot,
  externalUserId: string,
  representativeId: string,
  idempotencyKey: string,
  transactionClient: unknown,
): Promise<AgentTokenPurchaseSnapshot> {
  const tokenPurchase = await purchaseAgentTokens(
    {
      externalUserId,
      representativeId,
      amountCents: rechargeOrder.amountCents,
      currency: rechargeOrder.currency,
      rechargeOrderId: rechargeOrder.id,
      idempotencyKey,
    },
    transactionClient as NonNullable<
      Parameters<typeof purchaseAgentTokens>[1]
    >,
  );
  const representativeClient = transactionClient as {
    representative: {
      findUnique(args: unknown): Promise<{ ownerId: string } | null>;
    };
  };
  const representative = await representativeClient.representative.findUnique({
    where: { id: representativeId },
    select: { ownerId: true },
  });
  if (!representative) {
    throw new Error("Representative not found.");
  }
  await attributeRechargeToRepresentative(
    rechargeOrder.id,
    representativeId,
    representative.ownerId,
    transactionClient,
  );
  return tokenPurchase;
}

function normalizeCreateRechargeOrderInput(
  input: CreateRechargeOrderInput,
  provider: PaymentProvider,
): Required<Pick<CreateRechargeOrderInput, "externalUserId" | "amountCents" | "currency" | "idempotencyKey">> &
  Pick<
    CreateRechargeOrderInput,
    | "audienceIdentityId"
    | "representativeId"
    | "productCode"
    | "billingProductId"
    | "billingPriceVersionId"
    | "productNameSnapshot"
    | "productKindSnapshot"
    | "unitNameSnapshot"
    | "entitlementUnitsSnapshot"
    | "handoffAllowanceSnapshot"
    | "handoffUnitsSnapshot"
    | "handoffServiceLevelSnapshot"
    | "handoffValidityDaysSnapshot"
    | "creatorRevenueShareBpsSnapshot"
    | "platformRevenueShareBpsSnapshot"
    | "refundPolicySnapshot"
    | "expiryPolicySnapshot"
    | "entitlementValidityDaysSnapshot"
    | "displayName"
    | "telegramUserId"
  > {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new Error("externalUserId is required.");
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const currency = input.currency ?? "CNY";
  if (!SUPPORTED_RECHARGE_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported recharge currency: ${currency}`);
  }
  const representativeId = input.representativeId?.trim() || undefined;
  const productCode = input.productCode?.trim() || undefined;
  if (Boolean(representativeId) !== Boolean(productCode)) {
    throw new Error(
      "representativeId and productCode must be provided together.",
    );
  }
  const commercialSnapshot =
    normalizeCommercialSnapshot(input);
  return {
    externalUserId,
    amountCents: input.amountCents,
    currency,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      `${provider.toLowerCase()}_recharge`,
    ),
    ...(input.audienceIdentityId?.trim() ? { audienceIdentityId: input.audienceIdentityId.trim() } : {}),
    ...(representativeId ? { representativeId } : {}),
    ...(productCode ? { productCode } : {}),
    ...commercialSnapshot,
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    ...(input.telegramUserId?.trim() ? { telegramUserId: input.telegramUserId.trim() } : {}),
  };
}

async function resolveRechargeUserWallet(
  normalized: ReturnType<typeof normalizeCreateRechargeOrderInput>,
  tx: RechargeClient,
): Promise<UserWalletRecord> {
  const existingByAudienceIdentity =
    normalized.audienceIdentityId && tx.userWallet.findFirst
      ? await tx.userWallet.findFirst({
          where: { audienceIdentityId: normalized.audienceIdentityId },
          orderBy: { createdAt: "asc" },
        })
      : null;

  if (existingByAudienceIdentity) {
    if (existingByAudienceIdentity.currency !== normalized.currency) {
      throw new Error("Existing user wallet currency cannot be changed.");
    }
    return tx.userWallet.update({
      where: { id: existingByAudienceIdentity.id },
      data: {
        ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
        ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
      },
    });
  }

  const wallet = await tx.userWallet.upsert({
    where: { externalUserId: normalized.externalUserId },
    create: {
      externalUserId: normalized.externalUserId,
      ...(normalized.audienceIdentityId ? { audienceIdentityId: normalized.audienceIdentityId } : {}),
      ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
      ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
      currency: normalized.currency,
      cashBalanceCents: 0,
    },
    update: {
      ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
      ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
    },
  });
  if (wallet.currency !== normalized.currency) {
    throw new Error("Existing user wallet currency cannot be changed.");
  }
  if (
    wallet.audienceIdentityId &&
    normalized.audienceIdentityId &&
    wallet.audienceIdentityId !== normalized.audienceIdentityId
  ) {
    throw new Error("Existing user wallet belongs to another audience identity.");
  }
  if (!wallet.audienceIdentityId && normalized.audienceIdentityId) {
    return tx.userWallet.update({
      where: { id: wallet.id },
      data: { audienceIdentityId: normalized.audienceIdentityId },
    });
  }
  return wallet;
}

async function linkPaymentExternalUserId(
  normalized: ReturnType<typeof normalizeCreateRechargeOrderInput>,
  tx: RechargeClient,
) {
  if (!normalized.audienceIdentityId || !tx.identityLink) {
    return;
  }

  const link = await tx.identityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: normalized.externalUserId,
      },
    },
    update: {},
    create: {
      audienceIdentityId: normalized.audienceIdentityId,
      provider: "PAYMENT_EXTERNAL_USER",
      providerSubject: normalized.externalUserId,
    },
  });
  if (link.audienceIdentityId !== normalized.audienceIdentityId) {
    throw new Error("Payment external user id is already linked to another audience identity.");
  }
}

function assertExistingRechargeOrderMatches(
  order: RechargeOrderRecord,
  normalized: ReturnType<typeof normalizeCreateRechargeOrderInput>,
  provider: PaymentProvider,
): void {
  if (!order.userWallet) {
    throw new Error("Existing recharge order is missing its user wallet.");
  }
  const ownerMatches = normalized.audienceIdentityId
    ? order.userWallet.audienceIdentityId === normalized.audienceIdentityId
    : order.userWallet.externalUserId === normalized.externalUserId;
  const mismatches = [
    order.provider !== provider ? "provider" : null,
    !ownerMatches ? "owner" : null,
    order.representativeId !== (normalized.representativeId ?? null)
      ? "representative"
      : null,
    order.productCode !== (normalized.productCode ?? null) ? "product" : null,
    (order.billingProductId ?? null)
      !== (normalized.billingProductId ?? null)
      ? "billing product"
      : null,
    (order.billingPriceVersionId ?? null)
      !== (normalized.billingPriceVersionId ?? null)
      ? "billing price version"
      : null,
    (order.productNameSnapshot ?? null)
      !== (normalized.productNameSnapshot ?? null)
      ? "product name snapshot"
      : null,
    (order.productKindSnapshot ?? null)
      !== (normalized.productKindSnapshot ?? null)
      ? "product kind snapshot"
      : null,
    (order.unitNameSnapshot ?? null)
      !== (normalized.unitNameSnapshot ?? null)
      ? "unit name snapshot"
      : null,
    (order.entitlementUnitsSnapshot ?? null)
      !== (normalized.entitlementUnitsSnapshot ?? null)
      ? "entitlement units snapshot"
      : null,
    (order.handoffAllowanceSnapshot ?? null)
      !== (normalized.handoffAllowanceSnapshot ?? null)
      ? "handoff allowance snapshot"
      : null,
    (order.handoffUnitsSnapshot ?? null)
      !== (normalized.handoffUnitsSnapshot ?? null)
      ? "handoff units snapshot"
      : null,
    (order.handoffServiceLevelSnapshot ?? null)
      !== (normalized.handoffServiceLevelSnapshot ?? null)
      ? "handoff service level snapshot"
      : null,
    (order.handoffValidityDaysSnapshot ?? null)
      !== (normalized.handoffValidityDaysSnapshot ?? null)
      ? "handoff validity snapshot"
      : null,
    (order.creatorRevenueShareBpsSnapshot ?? null)
      !== (normalized.creatorRevenueShareBpsSnapshot ?? null)
      ? "creator revenue share snapshot"
      : null,
    (order.platformRevenueShareBpsSnapshot ?? null)
      !== (normalized.platformRevenueShareBpsSnapshot ?? null)
      ? "platform revenue share snapshot"
      : null,
    (order.refundPolicySnapshot ?? null)
      !== (normalized.refundPolicySnapshot ?? null)
      ? "refund policy snapshot"
      : null,
    (order.expiryPolicySnapshot ?? null)
      !== (normalized.expiryPolicySnapshot ?? null)
      ? "expiry policy snapshot"
      : null,
    (order.entitlementValidityDaysSnapshot ?? null)
      !== (normalized.entitlementValidityDaysSnapshot ?? null)
      ? "entitlement validity snapshot"
      : null,
    order.amountCents !== normalized.amountCents ? "amount" : null,
    order.currency !== normalized.currency ? "currency" : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `Recharge idempotency key was reused with different ${mismatches.join(", ")}.`,
    );
  }
}

function assertPaymentEventMatchesRechargeOrder(
  event: NormalizedPaymentProviderEvent,
  order: RechargeOrderRecord,
): void {
  const expectedProviderOrderId =
    order.provider === PaymentProvider.WECHAT_PAY
    && order.status === RechargeOrderStatus.CREATED
    && order.providerOrderId === null
      ? order.id
      : order.providerOrderId;
  const mismatches = [
    event.provider !== order.provider ? "provider" : null,
    event.rechargeOrderId !== order.id ? "order" : null,
    event.providerOrderId !== expectedProviderOrderId
      ? "provider order"
      : null,
    event.amountCents !== order.amountCents ? "amount" : null,
    event.currency?.toUpperCase() !== order.currency.toUpperCase() ? "currency" : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new RechargePaymentConflictError(
      `Payment provider event does not match recharge order: ${mismatches.join(", ")}.`,
    );
  }
}

function assertProviderEventCanAttach(
  providerEvent: PaymentProviderEventRecord | null,
  normalizedEvent: NormalizedPaymentProviderEvent,
  order: RechargeOrderRecord,
): void {
  if (!providerEvent) {
    return;
  }
  if (providerEvent.rechargeOrderId !== order.id) {
    throw new RechargePaymentConflictError(
      "Payment provider event is already attached to another recharge order.",
    );
  }
  if (providerEvent.eventType !== normalizedEvent.eventType) {
    throw new RechargePaymentConflictError(
      "Payment provider event id was reused for a different event type.",
    );
  }
  if (
    (providerEvent.providerTransactionId ?? null)
    !== normalizedEvent.providerTransactionId
  ) {
    throw new RechargePaymentConflictError(
      "Payment provider event id was reused for a different provider transaction.",
    );
  }
}

function serializeRechargeOrder(order: RechargeOrderRecord): RechargeOrderSnapshot {
  if (!order.userWallet) {
    throw new Error("Recharge order is missing user wallet.");
  }
  return {
    id: order.id,
    userWalletId: order.userWalletId,
    externalUserId: order.userWallet.externalUserId,
    amountCents: order.amountCents,
    currency: order.currency,
    provider:
      order.provider.toLowerCase() as RechargeOrderSnapshot["provider"],
    providerOrderId: order.providerOrderId,
    status: order.status.toLowerCase() as RechargeOrderSnapshot["status"],
    checkoutUrl: order.checkoutUrl,
    checkoutExpiresAt:
      order.provider === PaymentProvider.WECHAT_PAY
      && order.status === RechargeOrderStatus.REQUIRES_PAYMENT
        ? readWeChatPayCheckoutExpiresAt(order.providerPayload)
        : null,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    cashBalanceCents: order.userWallet.cashBalanceCents,
    representativeId: order.representativeId,
    billingProductId: order.billingProductId ?? null,
    billingPriceVersionId: order.billingPriceVersionId ?? null,
    productNameSnapshot: order.productNameSnapshot ?? null,
    productKindSnapshot:
      (order.productKindSnapshot as RechargeOrderSnapshot["productKindSnapshot"])
      ?? null,
    unitNameSnapshot: order.unitNameSnapshot ?? null,
    entitlementUnitsSnapshot: order.entitlementUnitsSnapshot ?? null,
    handoffAllowanceSnapshot:
      (order.handoffAllowanceSnapshot as RechargeOrderSnapshot["handoffAllowanceSnapshot"])
      ?? null,
    handoffUnitsSnapshot: order.handoffUnitsSnapshot ?? null,
    handoffServiceLevelSnapshot:
      (order.handoffServiceLevelSnapshot as RechargeOrderSnapshot["handoffServiceLevelSnapshot"])
      ?? null,
    handoffValidityDaysSnapshot:
      order.handoffValidityDaysSnapshot ?? null,
    creatorRevenueShareBpsSnapshot:
      order.creatorRevenueShareBpsSnapshot ?? null,
    platformRevenueShareBpsSnapshot:
      order.platformRevenueShareBpsSnapshot ?? null,
    refundPolicySnapshot:
      (order.refundPolicySnapshot as RechargeOrderSnapshot["refundPolicySnapshot"])
      ?? null,
    expiryPolicySnapshot:
      (order.expiryPolicySnapshot as RechargeOrderSnapshot["expiryPolicySnapshot"])
      ?? null,
    entitlementValidityDaysSnapshot:
      order.entitlementValidityDaysSnapshot ?? null,
  };
}

function normalizeCommercialSnapshot(
  input: CreateRechargeOrderInput,
): Pick<
  CreateRechargeOrderInput,
  | "billingProductId"
  | "billingPriceVersionId"
  | "productNameSnapshot"
  | "productKindSnapshot"
  | "unitNameSnapshot"
  | "entitlementUnitsSnapshot"
  | "handoffAllowanceSnapshot"
  | "handoffUnitsSnapshot"
  | "handoffServiceLevelSnapshot"
  | "handoffValidityDaysSnapshot"
  | "creatorRevenueShareBpsSnapshot"
  | "platformRevenueShareBpsSnapshot"
  | "refundPolicySnapshot"
  | "expiryPolicySnapshot"
  | "entitlementValidityDaysSnapshot"
> {
  const hasSnapshotField = [
    input.billingProductId,
    input.billingPriceVersionId,
    input.productNameSnapshot,
    input.productKindSnapshot,
    input.unitNameSnapshot,
    input.entitlementUnitsSnapshot,
    input.handoffAllowanceSnapshot,
    input.handoffUnitsSnapshot,
    input.handoffServiceLevelSnapshot,
    input.handoffValidityDaysSnapshot,
    input.creatorRevenueShareBpsSnapshot,
    input.platformRevenueShareBpsSnapshot,
    input.refundPolicySnapshot,
    input.expiryPolicySnapshot,
  ].some((value) => value !== undefined);
  if (!hasSnapshotField) {
    return {};
  }

  const billingProductId = input.billingProductId?.trim();
  const billingPriceVersionId = input.billingPriceVersionId?.trim();
  const productNameSnapshot = input.productNameSnapshot?.trim();
  const productKindSnapshot = input.productKindSnapshot;
  const unitNameSnapshot = input.unitNameSnapshot?.trim();
  if (
    !billingProductId
    || !billingPriceVersionId
    || !productNameSnapshot
    || !productKindSnapshot
    || !unitNameSnapshot
    || !input.handoffAllowanceSnapshot
  ) {
    throw new Error("A billing order requires a complete commercial snapshot.");
  }
  assertBasisPoints(
    input.creatorRevenueShareBpsSnapshot,
    "creatorRevenueShareBpsSnapshot",
  );
  assertBasisPoints(
    input.platformRevenueShareBpsSnapshot,
    "platformRevenueShareBpsSnapshot",
  );
  if (
    input.creatorRevenueShareBpsSnapshot!
      + input.platformRevenueShareBpsSnapshot!
    !== 10_000
  ) {
    throw new Error("Revenue share snapshots must total 10000 bps.");
  }
  if (
    input.expiryPolicySnapshot !== "NEVER_EXPIRES"
    || input.entitlementValidityDaysSnapshot !== null
  ) {
    throw new Error("Expiring service packages are not supported in V1.");
  }
  const entitlementUnitsSnapshot = input.entitlementUnitsSnapshot;
  if (
    productKindSnapshot === "SERVICE_PACKAGE"
    && (
      input.productCode !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
      || unitNameSnapshot !== "credit"
      || !Number.isSafeInteger(entitlementUnitsSnapshot)
      || (entitlementUnitsSnapshot ?? 0) <= 0
      || input.refundPolicySnapshot !== "FULL_WHEN_UNUSED"
    )
  ) {
    throw new Error("Service-package recharge snapshot is invalid.");
  }
  if (
    productKindSnapshot === "TIP"
    && (
      input.productCode !== AGENT_WALLET_TIP_PRODUCT_CODE
      || unitNameSnapshot !== "tip"
      || entitlementUnitsSnapshot !== 0
      || input.refundPolicySnapshot !== "NON_REFUNDABLE"
    )
  ) {
    throw new Error("Tip recharge snapshot is invalid.");
  }
  if (
    productKindSnapshot !== "SERVICE_PACKAGE"
    && productKindSnapshot !== "TIP"
  ) {
    throw new Error("Unsupported commerce product kind.");
  }
  const handoffAllowanceSnapshot = input.handoffAllowanceSnapshot;
  if (productKindSnapshot === "TIP" && (
    handoffAllowanceSnapshot !== "NONE"
    || input.handoffUnitsSnapshot !== null
    || input.handoffServiceLevelSnapshot !== null
    || input.handoffValidityDaysSnapshot !== null
  )) {
    throw new Error("Tips cannot grant human-handoff access.");
  }
  if (productKindSnapshot === "SERVICE_PACKAGE") {
    if (handoffAllowanceSnapshot === "NONE" && (
      input.handoffUnitsSnapshot !== null
      || input.handoffServiceLevelSnapshot !== null
      || input.handoffValidityDaysSnapshot !== null
    )) {
      throw new Error("A no-handoff package cannot contain handoff terms.");
    }
    if (handoffAllowanceSnapshot === "LIMITED" && (
      !Number.isSafeInteger(input.handoffUnitsSnapshot)
      || (input.handoffUnitsSnapshot ?? 0) <= 0
      || !input.handoffServiceLevelSnapshot
      || !Number.isSafeInteger(input.handoffValidityDaysSnapshot)
      || (input.handoffValidityDaysSnapshot ?? 0) <= 0
    )) {
      throw new Error("Limited handoff snapshot is invalid.");
    }
    if (handoffAllowanceSnapshot === "UNLIMITED" && (
      input.handoffUnitsSnapshot !== null
      || !input.handoffServiceLevelSnapshot
      || !Number.isSafeInteger(input.handoffValidityDaysSnapshot)
      || (input.handoffValidityDaysSnapshot ?? 0) <= 0
    )) {
      throw new Error("Unlimited handoff snapshot is invalid.");
    }
  }
  const creatorRevenueShareBpsSnapshot =
    input.creatorRevenueShareBpsSnapshot!;
  const platformRevenueShareBpsSnapshot =
    input.platformRevenueShareBpsSnapshot!;

  return {
    billingProductId,
    billingPriceVersionId,
    productNameSnapshot,
    productKindSnapshot,
    unitNameSnapshot: unitNameSnapshot as "credit" | "tip",
    entitlementUnitsSnapshot: entitlementUnitsSnapshot!,
    handoffAllowanceSnapshot,
    handoffUnitsSnapshot: input.handoffUnitsSnapshot!,
    handoffServiceLevelSnapshot: input.handoffServiceLevelSnapshot!,
    handoffValidityDaysSnapshot: input.handoffValidityDaysSnapshot!,
    creatorRevenueShareBpsSnapshot,
    platformRevenueShareBpsSnapshot,
    refundPolicySnapshot: input.refundPolicySnapshot!,
    expiryPolicySnapshot: input.expiryPolicySnapshot!,
    entitlementValidityDaysSnapshot: null,
  };
}

function assertBasisPoints(
  value: number | undefined,
  label: string,
): void {
  if (
    !Number.isSafeInteger(value)
    || value === undefined
    || value < 0
    || value > 10_000
  ) {
    throw new Error(`${label} must be an integer between 0 and 10000.`);
  }
}

/**
 * Returns only the server-authored Native checkout expiry that is safe for a
 * browser. Provider payloads can contain merchant and reconciliation details,
 * so callers must never serialize the source object itself.
 */
export function readWeChatPayCheckoutExpiresAt(
  providerPayload: unknown,
): string | null {
  const outer = readJsonObject(providerPayload);
  if (!outer) {
    return null;
  }
  const nativePayload = Object.prototype.hasOwnProperty.call(
    outer,
    "rawPayload",
  )
    ? readJsonObject(outer.rawPayload)
    : outer;
  if (
    !nativePayload
    || nativePayload.mode !== "native"
    || typeof nativePayload.expiresAt !== "string"
  ) {
    return null;
  }
  const parsed = new Date(nativePayload.expiresAt);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== nativePayload.expiresAt
  ) {
    return null;
  }
  return nativePayload.expiresAt;
}

function readJsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
