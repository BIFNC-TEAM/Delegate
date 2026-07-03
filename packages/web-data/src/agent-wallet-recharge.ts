import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { mockPaymentProviderAdapter } from "./agent-wallet-payment-providers";
import { prisma } from "./prisma";

type UserWalletRecord = {
  id: string;
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

type RechargeClient = Omit<WalletLedgerClient, "$transaction"> & {
  userWallet: {
    upsert(args: unknown): Promise<UserWalletRecord>;
    update(args: unknown): Promise<UserWalletRecord>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderRecord | null>;
    create(args: unknown): Promise<RechargeOrderRecord>;
    update(args: unknown): Promise<RechargeOrderRecord>;
  };
  paymentProviderEvent: {
    upsert(args: unknown): Promise<PaymentProviderEventRecord>;
  };
  $transaction?<T>(fn: (tx: RechargeClient) => Promise<T>): Promise<T>;
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
      return serializeRechargeOrder(existing);
    }

    const userWallet = await tx.userWallet.upsert({
      where: { externalUserId: normalized.externalUserId },
      create: {
        externalUserId: normalized.externalUserId,
        ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
        ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
        currency: normalized.currency,
        cashBalanceCents: 0,
      },
      update: {
        ...(normalized.telegramUserId ? { telegramUserId: normalized.telegramUserId } : {}),
        ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
        currency: normalized.currency,
      },
    });

    const checkout = await mockPaymentProviderAdapter.createRechargeCheckout({
      externalUserId: normalized.externalUserId,
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

  return client.$transaction ? client.$transaction(run) : run(client);
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

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `recharge:${order.id}`,
        idempotencyKey: `recharge:${order.id}:paid`,
        currency: order.currency,
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
            userWalletId: order.userWallet.id,
            rechargeOrderId: order.id,
            paymentProviderEventId: providerEvent.id,
            amountCents: order.amountCents,
            notes: "mock_recharge_paid",
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

  return client.$transaction ? client.$transaction(run) : run(client);
}

function normalizeCreateMockRechargeOrderInput(
  input: CreateMockRechargeOrderInput,
): Required<Pick<CreateMockRechargeOrderInput, "externalUserId" | "amountCents" | "currency" | "idempotencyKey">> &
  Pick<CreateMockRechargeOrderInput, "displayName" | "telegramUserId"> {
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
    idempotencyKey:
      input.idempotencyKey ?? `mock_recharge:${externalUserId}:${currency}:${input.amountCents}`,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.telegramUserId ? { telegramUserId: input.telegramUserId } : {}),
  };
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
