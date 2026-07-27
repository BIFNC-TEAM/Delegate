import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
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
import { enqueueWeChatPayOrderReconciliation } from "./agent-wallet-payment-reconciliation";
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
import { prisma } from "./prisma";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "./service-entitlements";

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
  provider: PaymentProvider;
  providerOrderId: string | null;
  providerTransactionId?: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  idempotencyKey: string;
  checkoutUrl: string | null;
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

type RechargeClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  userWallet: {
    findFirst?(args: unknown): Promise<UserWalletRecord | null>;
    upsert(args: unknown): Promise<UserWalletRecord>;
    update(args: unknown): Promise<UserWalletRecord>;
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
  paidAt: string | null;
  cashBalanceCents: number;
};

export type CreateRechargeOrderInput = {
  externalUserId: string;
  audienceIdentityId?: string;
  representativeId?: string;
  productCode?: string;
  amountCents: number;
  currency?: string;
  displayName?: string;
  telegramUserId?: string;
  idempotencyKey?: string;
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

export type CompleteMockRechargeAndPurchaseSnapshot = {
  rechargeOrder: RechargeOrderSnapshot;
  tokenPurchase: AgentTokenPurchaseSnapshot;
};

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
 * both the local order id and the provider out-trade number.
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
      return serializeRechargeOrder(existing);
    }

    const userWallet = await resolveRechargeUserWallet(normalized, tx);
    await linkPaymentExternalUserId(normalized, tx);

    const order = await tx.rechargeOrder.create({
      data: {
        userWalletId: userWallet.id,
        ...(normalized.representativeId
          ? { representativeId: normalized.representativeId }
          : {}),
        ...(normalized.productCode
          ? { productCode: normalized.productCode }
          : {}),
        provider: adapter.provider,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        status: RechargeOrderStatus.CREATED,
        idempotencyKey: normalized.idempotencyKey,
      },
    });

    return serializeRechargeOrder({ ...order, userWallet });
  };

  const prepared = await runWalletWriteTransaction(client, prepare);
  if (prepared.status !== "created") {
    await enqueuePendingWeChatOrderIfRequired(
      adapter.provider,
      prepared.status,
      prepared.id,
      client,
    );
    return prepared;
  }

  const checkout = await adapter.createRechargeCheckout({
    rechargeOrderId: prepared.id,
    externalUserId: prepared.externalUserId,
    amountCents: prepared.amountCents,
    currency: prepared.currency,
    idempotencyKey: normalized.idempotencyKey,
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
      where: { id: prepared.id },
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
      await enqueuePendingWeChatOrderIfRequired(
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
      await enqueuePendingWeChatOrderIfRequired(
        adapter.provider,
        serializeRechargeOrder(raced).status,
        raced.id,
        tx,
      );
      return serializeRechargeOrder(raced);
    }

    await enqueuePendingWeChatOrderIfRequired(
      adapter.provider,
      "requires_payment",
      current.id,
      tx,
    );
    return serializeRechargeOrder({
      ...current,
      providerOrderId,
      checkoutUrl: checkout.checkoutUrl,
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
    });
  });
}

async function enqueuePendingWeChatOrderIfRequired(
  provider: PaymentProvider,
  status: RechargeOrderSnapshot["status"],
  rechargeOrderId: string,
  client: RechargeClient,
): Promise<void> {
  if (
    provider !== PaymentProvider.WECHAT_PAY
    || status !== "requires_payment"
  ) {
    return;
  }
  await enqueueWeChatPayOrderReconciliation(
    rechargeOrderId,
    client as unknown as Parameters<
      typeof enqueueWeChatPayOrderReconciliation
    >[1],
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
  if (order.status !== RechargeOrderStatus.REQUIRES_PAYMENT) {
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
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
    },
    data: {
      status: RechargeOrderStatus.PAID,
      paidAt,
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
      },
    });
    if (
      purchaseIntent?.representativeId !== representativeId
      || purchaseIntent.productCode !==
        AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
    ) {
      throw new RechargePaymentConflictError(
        "Recharge order does not match the intended representative service product.",
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

    const tokenPurchase = await purchaseRechargeServiceCredits(
      rechargeOrder,
      externalUserId,
      representativeId,
      input.purchaseIdempotencyKey
        ?? `recharge_purchase:${rechargeOrder.id}:${representativeId}`,
      tx,
    );

    return {
      rechargeOrder: {
        ...rechargeOrder,
        cashBalanceCents: tokenPurchase.cashBalanceCents,
      },
      tokenPurchase,
    };
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
        userWallet: {
          select: {
            externalUserId: true,
          },
        },
      },
    });
    if (
      !purchaseIntent?.representativeId
      || purchaseIntent.productCode !==
        AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
    ) {
      throw new Error(
        "Recharge order does not match the intended representative service product.",
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
    const tokenPurchase = await purchaseRechargeServiceCredits(
      rechargeOrder,
      purchaseIntent.userWallet.externalUserId,
      purchaseIntent.representativeId,
      `recharge_purchase:${rechargeOrder.id}:${purchaseIntent.representativeId}`,
      tx,
    );

    return {
      rechargeOrder: {
        ...rechargeOrder,
        cashBalanceCents: tokenPurchase.cashBalanceCents,
      },
      tokenPurchase,
    };
  });
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
      where: { eventGroupId: `recharge:${rechargeOrder.id}` },
      data: {
        ownerId: representative.ownerId,
        representativeId,
      },
    }) ?? Promise.resolve(),
    attributionClient.walletLedgerEntry.updateMany?.({
      where: { eventGroupId: `recharge:${rechargeOrder.id}` },
      data: {
        ownerId: representative.ownerId,
        representativeId,
      },
    }) ?? Promise.resolve(),
  ]);
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
  const mismatches = [
    event.provider !== order.provider ? "provider" : null,
    event.rechargeOrderId !== order.id ? "order" : null,
    event.providerOrderId !== order.providerOrderId ? "provider order" : null,
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
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    cashBalanceCents: order.userWallet.cashBalanceCents,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
