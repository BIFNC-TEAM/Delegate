import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  WalletTransactionEventType,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { mockPaymentProviderAdapter } from "./agent-wallet-payment-providers";
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
  provider: PaymentProvider;
  providerOrderId: string | null;
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
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
};

type RechargeClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  userWallet: {
    findFirst?(args: unknown): Promise<UserWalletRecord | null>;
    upsert(args: unknown): Promise<UserWalletRecord>;
    update(args: unknown): Promise<UserWalletRecord>;
  };
  identityLink?: {
    upsert(args: unknown): Promise<unknown>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderRecord | null>;
    create(args: unknown): Promise<RechargeOrderRecord>;
    update(args: unknown): Promise<RechargeOrderRecord>;
  };
  paymentProviderEvent: {
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
  provider: "mock";
  providerOrderId: string | null;
  status: "created" | "requires_payment" | "paid" | "failed" | "canceled" | "refunded";
  checkoutUrl: string | null;
  paidAt: string | null;
  cashBalanceCents: number;
};

export type CreateMockRechargeOrderInput = {
  externalUserId: string;
  audienceIdentityId?: string;
  amountCents: number;
  currency?: string;
  displayName?: string;
  telegramUserId?: string;
  idempotencyKey?: string;
};

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

const SUPPORTED_RECHARGE_CURRENCIES = new Set(["CNY", "USD"]);

export async function createMockRechargeOrder(
  input: CreateMockRechargeOrderInput,
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
  const normalized = normalizeCreateMockRechargeOrderInput(input);
  const run = async (tx: RechargeClient) => {
    const existing = await tx.rechargeOrder.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: { userWallet: true },
    });
    if (existing) {
      assertWalletIdempotencyField(
        "mock recharge",
        "externalUserId",
        existing.userWallet?.externalUserId,
        normalized.externalUserId,
      );
      assertWalletIdempotencyField(
        "mock recharge",
        "amountCents",
        existing.amountCents,
        normalized.amountCents,
      );
      assertWalletIdempotencyField(
        "mock recharge",
        "currency",
        existing.currency,
        normalized.currency,
      );
      return serializeRechargeOrder(existing);
    }

    const userWallet = await resolveRechargeUserWallet(normalized, tx);
    await linkPaymentExternalUserId(normalized, tx);

    const checkout = await mockPaymentProviderAdapter.createRechargeCheckout({
      externalUserId: userWallet.externalUserId,
      amountCents: normalized.amountCents,
      currency: normalized.currency,
      idempotencyKey: normalized.idempotencyKey,
    });

    const order = await tx.rechargeOrder.create({
      data: {
        userWalletId: userWallet.id,
        provider: PaymentProvider.MOCK,
        providerOrderId: checkout.providerOrderId,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        idempotencyKey: normalized.idempotencyKey,
        checkoutUrl: checkout.checkoutUrl,
        providerPayload: checkout.providerPayload,
      },
    });

    return serializeRechargeOrder({ ...order, userWallet });
  };

  return runWalletWriteTransaction(client, run);
}

export async function completeMockRechargeOrder(
  rechargeOrderId: string,
  input: CompleteMockRechargeOrderInput = {},
  client: RechargeClient = prisma,
): Promise<RechargeOrderSnapshot> {
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
    if (typeof input.amountCents === "number" && input.amountCents !== order.amountCents) {
      throw new Error("Mock payment amount does not match recharge order.");
    }
    if (order.status === RechargeOrderStatus.PAID) {
      return serializeRechargeOrder(order);
    }
    if (order.status !== RechargeOrderStatus.REQUIRES_PAYMENT) {
      throw new Error(`Recharge order cannot be paid from status ${order.status}.`);
    }

    const normalizedEvent = await mockPaymentProviderAdapter.normalizeWebhookEvent({
      payload: {
        providerEventId: input.providerEventId ?? `mock_recharge_paid_${order.id}`,
        rechargeOrderId: order.id,
        amountCents: order.amountCents,
        currency: order.currency,
        status: "paid",
      },
    });
    if (normalizedEvent.eventType !== PaymentProviderEventType.RECHARGE_PAID) {
      throw new Error("Mock payment event is not a paid recharge event.");
    }

    const paidAt = new Date();
    const providerEvent = await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: normalizedEvent.provider,
          providerEventId: normalizedEvent.providerEventId,
        },
      },
      create: {
        provider: normalizedEvent.provider,
        providerEventId: normalizedEvent.providerEventId,
        eventType: normalizedEvent.eventType,
        rechargeOrderId: order.id,
        rawPayload: normalizedEvent.rawPayload,
        normalizedPayload: normalizedEvent.normalizedPayload,
        processedAt: paidAt,
        idempotencyKey: normalizedEvent.idempotencyKey,
      },
      update: {
        processedAt: paidAt,
      },
    });
    assertWalletIdempotencyField(
      "mock recharge payment event",
      "rechargeOrderId",
      providerEvent.rechargeOrderId,
      order.id,
    );
    assertWalletIdempotencyField(
      "mock recharge payment event",
      "eventType",
      providerEvent.eventType,
      PaymentProviderEventType.RECHARGE_PAID,
    );

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
        },
      },
      tx,
    );

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
            notes: "mock_recharge_paid",
          },
          {
            entryKey: "external_settlement_debit",
            accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
            entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_DEBIT,
            transactionId: walletTransaction?.id ?? null,
            rechargeOrderId: order.id,
            paymentProviderEventId: providerEvent.id,
            amountCents: -order.amountCents,
            notes: "mock_recharge_paid",
            metadata: {
              provider: order.provider,
            },
          },
        ],
      },
      tx,
    );

    const [updatedWallet, updatedOrder] = await Promise.all([
      tx.userWallet.update({
        where: { id: order.userWallet.id },
        data: {
          cashBalanceCents: {
            increment: order.amountCents,
          },
        },
      }),
      tx.rechargeOrder.update({
        where: { id: order.id },
        data: {
          status: RechargeOrderStatus.PAID,
          paidAt,
        },
      }),
    ]);

    return serializeRechargeOrder({ ...updatedOrder, userWallet: updatedWallet });
  };

  return runWalletWriteTransaction(client, run);
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

    const tokenPurchase = await purchaseAgentTokens(
      {
        externalUserId,
        representativeId,
        amountCents: rechargeOrder.amountCents,
        currency: rechargeOrder.currency,
        rechargeOrderId: rechargeOrder.id,
        idempotencyKey:
          input.purchaseIdempotencyKey
          ?? `recharge_purchase:${rechargeOrder.id}:${representativeId}`,
      },
      tx as unknown as NonNullable<
        Parameters<typeof purchaseAgentTokens>[1]
      >,
    );
    const representative = await tx.representative.findUnique({
      where: { id: representativeId },
      select: { ownerId: true },
    });
    if (!representative) {
      throw new Error("Representative not found.");
    }
    const attributionClient = tx as unknown as {
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

    return {
      rechargeOrder: {
        ...rechargeOrder,
        cashBalanceCents: tokenPurchase.cashBalanceCents,
      },
      tokenPurchase,
    };
  });
}

function normalizeCreateMockRechargeOrderInput(
  input: CreateMockRechargeOrderInput,
): Required<Pick<CreateMockRechargeOrderInput, "externalUserId" | "amountCents" | "currency" | "idempotencyKey">> &
  Pick<CreateMockRechargeOrderInput, "audienceIdentityId" | "displayName" | "telegramUserId"> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new Error("externalUserId is required.");
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const currency = input.currency ?? "CNY";
  if (!SUPPORTED_RECHARGE_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported recharge currency: ${currency}`);
  }
  return {
    externalUserId,
    amountCents: input.amountCents,
    currency,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "mock_recharge",
    ),
    ...(input.audienceIdentityId?.trim() ? { audienceIdentityId: input.audienceIdentityId.trim() } : {}),
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    ...(input.telegramUserId?.trim() ? { telegramUserId: input.telegramUserId.trim() } : {}),
  };
}

async function resolveRechargeUserWallet(
  normalized: ReturnType<typeof normalizeCreateMockRechargeOrderInput>,
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
      throw new Error("Existing user wallet currency cannot be changed by recharge.");
    }
    return tx.userWallet.update({
      where: { id: existingByAudienceIdentity.id },
      data: {
        ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
        ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
      },
    });
  }

  const userWallet = await tx.userWallet.upsert({
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
      ...(normalized.audienceIdentityId ? { audienceIdentityId: normalized.audienceIdentityId } : {}),
      ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
      ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
    },
  });
  if (userWallet.currency !== normalized.currency) {
    throw new Error("Existing user wallet currency cannot be changed by recharge.");
  }
  return userWallet;
}

async function linkPaymentExternalUserId(
  normalized: ReturnType<typeof normalizeCreateMockRechargeOrderInput>,
  tx: RechargeClient,
) {
  if (!normalized.audienceIdentityId || !tx.identityLink) {
    return;
  }

  await tx.identityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: normalized.externalUserId,
      },
    },
    update: {
      audienceIdentityId: normalized.audienceIdentityId,
    },
    create: {
      audienceIdentityId: normalized.audienceIdentityId,
      provider: "PAYMENT_EXTERNAL_USER",
      providerSubject: normalized.externalUserId,
    },
  });
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
    provider: "mock",
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
